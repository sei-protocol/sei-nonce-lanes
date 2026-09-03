// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Simple7702Account} from "@account-abstraction/accounts/Simple7702Account.sol";

/// @title LaneAccount
/// @notice EIP-7702 implementation for an account that submits many independent
///         UserOperations at the same time.
///
/// An ERC-4337 nonce is `(uint192 key << 64) | uint64 seq`. The EntryPoint keeps
/// one `seq` counter per `key`, so ops carrying different keys never queue behind
/// each other. This contract inherits all of its behavior from the audited
/// `Simple7702Account` and adds a single rule: key 0 is rejected.
///
/// Key 0 is what every SDK picks when no key is passed. A book that lands entirely
/// on key 0 is one queue again, which is the problem 2D nonces exist to solve.
/// Rejecting it converts that silent fallback into a loud validation failure.
/// Administrative operations that genuinely need ordering (withdrawals, rotating
/// the delegation) get their own reserved lane, `ADMIN_LANE`, instead of key 0.
///
/// The inherited `entryPoint()` is hardcoded to the canonical v0.8 singleton at
/// 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108, which is already deployed on both
/// Pacific-1 and Atlantic-2, so this contract needs no constructor arguments.
contract LaneAccount is Simple7702Account {
    /// @dev Reserved lane for operations that must stay strictly ordered relative
    ///      to each other, kept away from the trading lanes.
    uint192 public constant ADMIN_LANE = type(uint192).max;

    error LaneZeroReserved();

    /// @dev Called by `BaseAccount.validateUserOp` after signature validation.
    ///      The EntryPoint still owns nonce uniqueness; this is a policy check only.
    function _validateNonce(uint256 nonce) internal pure override {
        if (nonce >> 64 == 0) revert LaneZeroReserved();
    }
}
