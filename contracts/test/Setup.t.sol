// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {V2Fixture} from "~test/fixtures/V2Fixture.sol";
import {MockURIRenderer} from "~test/mocks/MockURIRenderer.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";

/// P1.1 smoke: the ENSv2 toolchain (fixture, UserRegistry, PermissionedResolver) compiles and deploys.
contract SetupTest is V2Fixture {
    function test_ensFixtureDeploys() external {
        deployV2Fixture();
        UserRegistry userRegistryImpl =
            new UserRegistry(labelStore, new MockURIRenderer("mock"), address(contractNamer));
        PermissionedResolver resolverImpl = new PermissionedResolver(address(contractNamer));
        assertTrue(address(userRegistryImpl).code.length > 0);
        assertTrue(address(resolverImpl).code.length > 0);
    }
}
