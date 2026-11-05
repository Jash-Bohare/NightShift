// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {V2Fixture} from "~test/fixtures/V2Fixture.sol";
import {MockURIRenderer} from "~test/mocks/MockURIRenderer.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {
    EACBaseRolesLib
} from "@ensdomains/contracts-v2/access-control/libraries/EACBaseRolesLib.sol";
import {
    IEACGrantInitializable,
    Grant
} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {
    IPermissionedRegistry
} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {
    IPermissionedResolver
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";

import {NightshiftRegistrar} from "../../src/NightshiftRegistrar.sol";

/// @dev Local ENSv2 stack built from the real contracts-v2 sources (no mocks):
///      root -> eth -> nightshift.eth (our UserRegistry) and a NightshiftRegistrar wired to it
///      exactly as script/01_DeployRegistrar.s.sol does on Sepolia.
abstract contract NightshiftFixture is V2Fixture {
    string constant PARENT = "nightshift.eth";
    uint256 constant REGISTRAR_ROOT_ROLES = RegistryRolesLib.ROLE_REGISTRAR
        | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER;

    address operator = makeAddr("operator");
    address admin = makeAddr("admin");
    address agentOwner = makeAddr("agentOwner");
    address stranger = makeAddr("stranger");

    UserRegistry userRegistry;
    address resolverImpl;
    NightshiftRegistrar registrar;

    function deployNightshift() internal {
        deployV2Fixture();

        UserRegistry userRegistryImpl =
            new UserRegistry(labelStore, new MockURIRenderer("mock"), address(contractNamer));
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(address(this), EACBaseRolesLib.ALL_ROLES);
        userRegistry = UserRegistry(
            verifiableFactory.deployProxy(
                address(userRegistryImpl),
                uint256(keccak256("nightshift user registry")),
                abi.encodeCall(IEACGrantInitializable.initialize, (grants))
            )
        );
        ethRegistry.register(
            "nightshift",
            address(this),
            IRegistry(address(userRegistry)),
            address(0),
            0,
            type(uint64).max
        );
        userRegistry.setParent(ethRegistry, "nightshift");

        resolverImpl = address(new PermissionedResolver(address(contractNamer)));
        registrar = new NightshiftRegistrar(
            IPermissionedRegistry(address(userRegistry)),
            verifiableFactory,
            resolverImpl,
            PARENT,
            operator,
            admin
        );
        userRegistry.grantRootRoles(REGISTRAR_ROOT_ROLES, address(registrar));
    }

    // ---- helpers

    function records(string memory description, string memory context)
        internal
        pure
        returns (NightshiftRegistrar.Record[] memory r)
    {
        r = new NightshiftRegistrar.Record[](2);
        r[0] = NightshiftRegistrar.Record("description", description);
        r[1] = NightshiftRegistrar.Record("agent-context", context);
    }

    function register(string memory label) internal returns (address resolver, uint256 tokenId) {
        vm.prank(operator);
        return registrar.registerAgent(label, agentOwner, records("desc", "ctx"));
    }

    function dns(string memory label) internal pure returns (bytes memory) {
        return NameCoder.encode(string.concat(label, ".", PARENT));
    }

    function text(string memory label, string memory key) internal view returns (string memory) {
        bytes memory name = dns(label);
        address resolver = findResolverV2(name);
        bytes memory result = IPermissionedResolver(resolver)
            .resolve(name, abi.encodeCall(ITextResolver.text, (NameCoder.namehash(name, 0), key)));
        return abi.decode(result, (string));
    }

    function labelId(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }
}
