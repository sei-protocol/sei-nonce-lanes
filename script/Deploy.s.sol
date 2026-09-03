// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LaneAccount} from "../src/LaneAccount.sol";
import {MockPerpVenue} from "../src/MockPerpVenue.sol";

/// @notice Deploys the EIP-7702 implementation and the demo venue.
///
/// The EntryPoint is not deployed here. The canonical ERC-4337 v0.8 singleton is
/// already live on Sei, and `Simple7702Account` hardcodes its address, so this
/// script only checks that it is present.
contract Deploy is Script {
    address constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    function run() external {
        require(ENTRY_POINT_V08.code.length > 0, "EntryPoint v0.8 not found on this chain");

        vm.startBroadcast();
        LaneAccount implementation = new LaneAccount();
        MockPerpVenue venue = new MockPerpVenue(100e18);
        vm.stopBroadcast();

        console.log("EntryPoint v0.8      ", ENTRY_POINT_V08);
        console.log("LaneAccount impl     ", address(implementation));
        console.log("MockPerpVenue        ", address(venue));
        console.log("");
        console.log("Add these to .env:");
        console.log(string.concat("LANE_ACCOUNT_IMPL=", vm.toString(address(implementation))));
        console.log(string.concat("VENUE=", vm.toString(address(venue))));
    }
}
