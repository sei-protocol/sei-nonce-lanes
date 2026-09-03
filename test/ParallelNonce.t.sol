// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {BaseAccount} from "@account-abstraction/core/BaseAccount.sol";

import {LaneAccount} from "../src/LaneAccount.sol";
import {MockPerpVenue} from "../src/MockPerpVenue.sol";

/// @notice Proves the property the whole design rests on: ERC-4337 nonce keys are
///         independent lanes, so operations from one account can be submitted and
///         landed without queueing behind each other.
///
/// Every test here runs against the real EntryPoint v0.8 bytecode from
/// `lib/account-abstraction`, the same contract already deployed on Sei at
/// 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108.
contract ParallelNonceTest is Test {
    /// The canonical ERC-4337 v0.8 singleton. `Simple7702Account` hardcodes this
    /// address, and it is already live on Sei, so the tests place a real EntryPoint
    /// here rather than at an arbitrary test address.
    address constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    uint128 constant VERIFICATION_GAS = 150_000;
    uint128 constant CALL_GAS = 250_000;
    uint256 constant PRE_VERIFICATION_GAS = 50_000;
    uint128 constant MAX_FEE = 1 gwei;
    uint128 constant MAX_PRIORITY_FEE = 1 gwei;

    uint256 constant MARK_PX = 100e18;

    EntryPoint entryPoint;
    LaneAccount implementation;
    MockPerpVenue venue;

    address trader;
    uint256 traderPk;
    address payable relayer;

    function setUp() public {
        deployCodeTo("EntryPoint.sol:EntryPoint", ENTRY_POINT_V08);
        entryPoint = EntryPoint(payable(ENTRY_POINT_V08));

        implementation = new LaneAccount();
        venue = new MockPerpVenue(MARK_PX);

        (trader, traderPk) = makeAddrAndKey("trader");
        relayer = payable(makeAddr("relayer"));

        vm.deal(trader, 100 ether);

        // One-time EIP-7702 delegation. After this the trading EOA keeps its address
        // and balance but runs LaneAccount's code, so the EntryPoint can drive it.
        vm.signAndAttachDelegation(address(implementation), traderPk);
        vm.prank(trader);
        (bool ok,) = payable(trader).call("");
        assertTrue(ok);

        assertEq(
            trader.code,
            abi.encodePacked(hex"ef0100", address(implementation)),
            "delegation designator not set"
        );
    }

    /*//////////////////////////////////////////////////////////////
                          THE CORE PROPERTY
    //////////////////////////////////////////////////////////////*/

    /// Eight orders on eight lanes, submitted in reverse lane order. All land.
    /// Landing order follows bundle position, not lane number, which is the point:
    /// lanes carry no ordering relationship to each other.
    function test_uniqueLanes_landInAnyOrder() public {
        uint256 n = 8;
        PackedUserOperation[] memory ops = new PackedUserOperation[](n);

        // ops[0] is lane 8, ops[7] is lane 1.
        for (uint256 i = 0; i < n; i++) {
            uint192 lane = uint192(n - i);
            ops[i] = _signedPlaceOp(lane, 0, 100 + lane, MARK_PX);
        }

        entryPoint.handleOps(ops, relayer);

        for (uint192 lane = 1; lane <= n; lane++) {
            assertTrue(venue.isFilled(100 + lane), "order on lane did not land");
        }
        // Submitted lane 8 first, so it landed first.
        assertEq(venue.landingSeq(108), 1, "lane 8 should land first");
        assertEq(venue.landingSeq(101), 8, "lane 1 should land last");
    }

    /// A reverting operation consumes its own lane and nothing else. This is the
    /// behavior that removes the need for a fleet of funded hot wallets.
    function test_revertingOp_doesNotBlockOtherLanes() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](3);
        ops[0] = _signedPlaceOp(1, 0, 201, MARK_PX);
        ops[1] = _signedPlaceOp(2, 0, 202, MARK_PX - 1); // limit under mark, venue reverts
        ops[2] = _signedPlaceOp(3, 0, 203, MARK_PX);

        // handleOps itself does not revert. The failing op gets a revert reason event.
        entryPoint.handleOps(ops, relayer);

        assertTrue(venue.isFilled(201), "lane 1 should have landed");
        assertFalse(venue.isFilled(202), "lane 2 should have failed");
        assertTrue(venue.isFilled(203), "lane 3 should have landed");

        // The failed op still burned its lane sequence. A retry uses seq 1, not seq 0.
        assertEq(entryPoint.getNonce(trader, 2), (uint256(2) << 64) | 1, "failed op must consume its seq");
        assertEq(entryPoint.getNonce(trader, 1), (uint256(1) << 64) | 1);
        assertEq(entryPoint.getNonce(trader, 3), (uint256(3) << 64) | 1);
    }

    /// Retrying a failed order means advancing that lane's sequence, and only that lane's.
    function test_retryAfterFailure_usesNextSeq() public {
        PackedUserOperation[] memory failing = new PackedUserOperation[](1);
        failing[0] = _signedPlaceOp(2, 0, 302, MARK_PX - 1);
        entryPoint.handleOps(failing, relayer);
        assertFalse(venue.isFilled(302));

        // Reusing seq 0 is rejected: the EntryPoint already consumed it.
        PackedUserOperation[] memory stale = new PackedUserOperation[](1);
        stale[0] = _signedPlaceOp(2, 0, 302, MARK_PX);
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce")
        );
        entryPoint.handleOps(stale, relayer);

        // seq 1 on the same lane goes through.
        PackedUserOperation[] memory retry = new PackedUserOperation[](1);
        retry[0] = _signedPlaceOp(2, 1, 302, MARK_PX);
        entryPoint.handleOps(retry, relayer);
        assertTrue(venue.isFilled(302), "retry on next seq should land");
    }

    /// The case that actually strands a single-nonce account: an operation that never
    /// lands at all. Dropped, underpriced, rejected at admission, or lost to a crash
    /// before submit. On one lane per order there is nothing behind it to strand.
    function test_droppedOp_doesNotBlockOtherLanes() public {
        // Built and signed, then deliberately never submitted.
        PackedUserOperation memory dropped = _signedPlaceOp(2, 0, 602, MARK_PX);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedPlaceOp(1, 0, 601, MARK_PX);
        ops[1] = _signedPlaceOp(3, 0, 603, MARK_PX);
        entryPoint.handleOps(ops, relayer);

        assertTrue(venue.isFilled(601), "lane 1 must not wait on lane 2");
        assertTrue(venue.isFilled(603), "lane 3 must not wait on lane 2");
        assertFalse(venue.isFilled(602));
        assertEq(entryPoint.getNonce(trader, 2), uint256(2) << 64, "lane 2 untouched");

        // The dropped op is still valid afterwards. No rebuild, no re-sign, no
        // replacement transaction. It simply lands late, behind the ops that
        // were submitted after it.
        PackedUserOperation[] memory late = new PackedUserOperation[](1);
        late[0] = dropped;
        entryPoint.handleOps(late, relayer);

        assertTrue(venue.isFilled(602));
        assertEq(venue.landingSeq(602), 3, "dropped op landed last, after its successors");
    }

    /// The same drop on a shared lane reproduces the behavior being escaped: the
    /// successor cannot land until the missing sequence is filled in.
    function test_sameLane_droppedOpStrandsSuccessor() public {
        PackedUserOperation memory dropped = _signedPlaceOp(9, 0, 611, MARK_PX);

        PackedUserOperation[] memory successor = new PackedUserOperation[](1);
        successor[0] = _signedPlaceOp(9, 1, 612, MARK_PX);

        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce")
        );
        entryPoint.handleOps(successor, relayer);
        assertFalse(venue.isFilled(612), "stranded behind the missing seq");

        // Only after the gap is filled does the successor become includable.
        PackedUserOperation[] memory fill = new PackedUserOperation[](1);
        fill[0] = dropped;
        entryPoint.handleOps(fill, relayer);
        entryPoint.handleOps(successor, relayer);
        assertTrue(venue.isFilled(612));
    }

    /*//////////////////////////////////////////////////////////////
                    CONTROL TESTS: WHY LANES MATTER
    //////////////////////////////////////////////////////////////*/

    /// An execution revert is isolated, but a *validation* failure is not: it takes
    /// down every op sharing the bundle, including ops on unrelated lanes. Bundling
    /// is what reintroduces a shared failure domain, so bundle width is a real
    /// tuning knob. Simulate before sending, and use narrow bundles when isolation
    /// matters more than gas.
    function test_validationFailure_killsWholeBundle() public {
        (, uint256 wrongPk) = makeAddrAndKey("not the trader");

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedPlaceOp(4, 0, 701, MARK_PX);
        // Well-formed signature from the wrong key: recovers cleanly to the wrong
        // address, so the account reports SIG_VALIDATION_FAILED.
        ops[1] = _signWith(_placeOp(5, 0, 702, MARK_PX), wrongPk);

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA24 signature error"));
        entryPoint.handleOps(ops, relayer);

        assertFalse(venue.isFilled(701), "healthy op died with the bundle");

        // Resubmitted on its own, the healthy op is untouched and still valid.
        PackedUserOperation[] memory retry = new PackedUserOperation[](1);
        retry[0] = _signedPlaceOp(4, 0, 701, MARK_PX);
        entryPoint.handleOps(retry, relayer);
        assertTrue(venue.isFilled(701));
    }

    /// Two ops on the *same* lane with a gap. This is the old sequential-nonce failure
    /// mode reproduced inside 4337, and it kills the whole bundle.
    function test_sameLane_gapRevertsWholeBundle() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedPlaceOp(7, 0, 401, MARK_PX);
        ops[1] = _signedPlaceOp(7, 2, 402, MARK_PX); // gap: seq 1 is missing

        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA25 invalid account nonce")
        );
        entryPoint.handleOps(ops, relayer);

        assertFalse(venue.isFilled(401), "bundle reverted, so nothing landed");
    }

    /// Same lane, correct sequences, wrong order in the bundle. Also fatal.
    /// Anything sharing a lane must be ordered by the submitter.
    function test_sameLane_reversedRevertsWholeBundle() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedPlaceOp(7, 1, 411, MARK_PX);
        ops[1] = _signedPlaceOp(7, 0, 412, MARK_PX);

        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce")
        );
        entryPoint.handleOps(ops, relayer);
    }

    /// Same lane in the right order does work, for genuinely dependent operations.
    function test_sameLane_inOrderIsFine() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signedPlaceOp(7, 0, 421, MARK_PX);
        ops[1] = _signedPlaceOp(7, 1, 422, MARK_PX);

        entryPoint.handleOps(ops, relayer);

        assertTrue(venue.isFilled(421));
        assertTrue(venue.isFilled(422));
        assertEq(venue.landingSeq(421), 1);
        assertEq(venue.landingSeq(422), 2);
    }

    /// LaneAccount rejects lane 0 so an SDK that forgets to set a nonce key cannot
    /// silently collapse the book back into one queue.
    function test_laneZero_isRejected() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _signedPlaceOp(0, 0, 501, MARK_PX);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(LaneAccount.LaneZeroReserved.selector)
            )
        );
        entryPoint.handleOps(ops, relayer);
    }

    /*//////////////////////////////////////////////////////////////
                                SCALE
    //////////////////////////////////////////////////////////////*/

    /// 50 independent orders, one account, one bundle, one EVM nonce consumed
    /// (the relayer's). Under the canonical 4337 mempool this would be capped at 4.
    function test_fiftyLanes_oneBundle() public {
        uint192 n = 50;
        PackedUserOperation[] memory ops = new PackedUserOperation[](n);
        for (uint192 i = 0; i < n; i++) {
            ops[i] = _signedPlaceOp(i + 1, 0, 1000 + i, MARK_PX);
        }

        uint256 gasBefore = gasleft();
        entryPoint.handleOps(ops, relayer);
        uint256 gasUsed = gasBefore - gasleft();

        for (uint192 i = 0; i < n; i++) {
            assertTrue(venue.isFilled(1000 + i), "order did not land");
        }
        assertEq(venue.landedCount(), n);
        console.log("gas for 50 ops in one bundle:", gasUsed);
        console.log("gas per op:", gasUsed / n);
    }

    /// Sanity check on the nonce encoding the off-chain code depends on.
    function test_nonceEncoding() public view {
        assertEq(entryPoint.getNonce(trader, 0), 0);
        assertEq(entryPoint.getNonce(trader, 1), uint256(1) << 64);
        assertEq(entryPoint.getNonce(trader, 42), uint256(42) << 64);
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    function _signedPlaceOp(uint192 lane, uint64 seq, uint256 orderId, uint256 limitPx)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        return _signWith(_placeOp(lane, seq, orderId, limitPx), traderPk);
    }

    function _placeOp(uint192 lane, uint64 seq, uint256 orderId, uint256 limitPx)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes memory venueCall = abi.encodeCall(MockPerpVenue.place, (orderId, 1e18, limitPx));
        bytes memory accountCall = abi.encodeCall(BaseAccount.execute, (address(venue), 0, venueCall));
        return _buildOp(lane, seq, accountCall);
    }

    function _buildOp(uint192 lane, uint64 seq, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return PackedUserOperation({
            sender: trader,
            nonce: (uint256(lane) << 64) | uint256(seq),
            // Empty: the account is already delegated and therefore already has code,
            // so the EntryPoint has nothing to deploy.
            initCode: "",
            callData: callData,
            accountGasLimits: _pack(VERIFICATION_GAS, CALL_GAS),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: _pack(MAX_PRIORITY_FEE, MAX_FEE),
            paymasterAndData: "",
            signature: ""
        });
    }

    /// EntryPoint v0.8 hashes the op as EIP-712 typed data. `Simple7702Account`
    /// recovers that digest directly, with no EIP-191 prefix.
    function _signWith(PackedUserOperation memory op, uint256 pk)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes32 digest = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _pack(uint128 high, uint128 low) internal pure returns (bytes32) {
        return bytes32((uint256(high) << 128) | uint256(low));
    }
}
