// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { WorkspaceSentinel } from "../../contracts/WorkspaceSentinel.sol";

contract WorkspaceSentinelTest {
    function testWorkspaceVersion() public {
        WorkspaceSentinel sentinel = new WorkspaceSentinel();
        require(
            keccak256(bytes(sentinel.workspaceVersion()))
                == keccak256(bytes("foc-platform-workspace-v1")),
            "unexpected workspace version"
        );
    }
}
