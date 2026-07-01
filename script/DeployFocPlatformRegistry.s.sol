// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { FocPlatformRegistry } from "../contracts/FocPlatformRegistry.sol";

interface Vm {
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployFocPlatformRegistryScript {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (FocPlatformRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("PLATFORM_ROOT_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        registry = new FocPlatformRegistry();
        vm.stopBroadcast();
    }
}
