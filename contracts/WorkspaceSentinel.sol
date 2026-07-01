// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal compile target proving the Foundry workspace is wired.
/// @dev The production registry is introduced by the section 6.7 issue.
contract WorkspaceSentinel {
    function workspaceVersion() external pure returns (string memory) {
        return "foc-platform-workspace-v1";
    }
}
