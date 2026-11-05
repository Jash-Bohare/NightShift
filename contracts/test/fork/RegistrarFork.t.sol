// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {IUniversalResolver} from "@ens/contracts/universalResolver/IUniversalResolver.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {IEnhancedAccessControl} from
    "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from
    "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {IPermissionedResolver} from
    "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {PermissionedResolverLib} from
    "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";

import {NightshiftRegistrar} from "../../src/NightshiftRegistrar.sol";
import {SepoliaENS} from "./SepoliaENS.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// P1.4 fork tests: NightshiftRegistrar against the live Sepolia ENSv2 deployment and our
/// nightshift.eth UserRegistry, resolved through the live Universal Resolver.
contract RegistrarForkTest is Test {
    string constant LABEL = "fork-agent";

    address operator = makeAddr("operator");
    address admin = makeAddr("admin");
    address agentOwner = makeAddr("agentOwner");
    address stranger = makeAddr("stranger");

    IPermissionedRegistry registry = IPermissionedRegistry(SepoliaENS.NIGHTSHIFT_USER_REGISTRY);
    NightshiftRegistrar registrar;
    IPermissionedResolver resolver;
    bytes name;

    function setUp() external {
        vm.createSelectFork(vm.rpcUrl("sepolia"), SepoliaENS.FORK_BLOCK);
        registrar = new NightshiftRegistrar(
            registry,
            IVerifiableFactory(SepoliaENS.VERIFIABLE_FACTORY),
            SepoliaENS.PERMISSIONED_RESOLVER_IMPL,
            "nightshift.eth",
            operator,
            admin
        );
        vm.prank(SepoliaENS.NIGHTSHIFT_DEPLOYER);
        registry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW
                | RegistryRolesLib.ROLE_UNREGISTER,
            address(registrar)
        );

        NightshiftRegistrar.Record[] memory initial = new NightshiftRegistrar.Record[](3);
        initial[0] = NightshiftRegistrar.Record("agent-context", "fork context");
        initial[1] = NightshiftRegistrar.Record("description", "fork agent");
        initial[2] = NightshiftRegistrar.Record("agent-endpoint[x402]", "https://x/a/fork-agent/run");

        uint256 gasBefore = gasleft();
        vm.prank(operator);
        (address r,) = registrar.registerAgent(LABEL, agentOwner, initial);
        console.log("registerAgent gas (3 initial records):", gasBefore - gasleft());
        resolver = IPermissionedResolver(r);
        name = NameCoder.encode(string.concat(LABEL, ".nightshift.eth"));
    }

    function _urText(string memory key) internal view returns (string memory value, address via) {
        bytes memory result;
        (result, via) = IUniversalResolver(SepoliaENS.UNIVERSAL_RESOLVER).resolve(
            name, abi.encodeCall(ITextResolver.text, (NameCoder.namehash(name, 0), key))
        );
        value = abi.decode(result, (string));
    }

    function test_resolvesThroughLiveUniversalResolver() external view {
        (string memory context, address via) = _urText("agent-context");
        assertEq(context, "fork context");
        assertEq(via, address(resolver));
        (string memory rep,) = _urText("nightshift.reputation");
        assertEq(rep, '{"jobs":0}');
        assertEq(registry.getResolver(LABEL), address(resolver));
        assertEq(registry.getOwner(uint256(keccak256(bytes(LABEL)))), agentOwner);
    }

    function test_reputationUpdateVisibleViaUniversalResolver() external {
        vm.prank(operator);
        registrar.setReputation(LABEL, '{"jobs":1,"success_rate":1}');
        (string memory rep,) = _urText("nightshift.reputation");
        assertEq(rep, '{"jobs":1,"success_rate":1}');
    }

    // ---- permission matrix on the real chain

    function test_matrix_ownerCanSetEveryOwnerKey() external {
        string[9] memory keys = registrar.ownerKeys();
        vm.startPrank(agentOwner);
        for (uint256 i; i < keys.length; ++i) {
            resolver.setText(name, keys[i], "by owner");
        }
        vm.stopPrank();
        for (uint256 i; i < keys.length; ++i) {
            (string memory v,) = _urText(keys[i]);
            assertEq(v, "by owner");
        }
    }

    function test_matrix_ownerReputationWriteReverts() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256("nightshift.reputation")),
                PermissionedResolverLib.ROLE_SET_TEXT,
                agentOwner
            )
        );
        vm.prank(agentOwner);
        resolver.setText(name, "nightshift.reputation", '{"jobs":9999}');
    }

    function test_matrix_ownerCannotLinkOrUpgrade() external {
        vm.startPrank(agentOwner);
        vm.expectRevert();
        resolver.linkToRecord(NameCoder.encode("hello.nightshift.eth"), 1);
        vm.expectRevert();
        IUUPS(address(resolver)).upgradeToAndCall(SepoliaENS.PERMISSIONED_RESOLVER_IMPL, "");
        vm.stopPrank();
    }

    function test_matrix_registrarCannotWriteDescription() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256("description")),
                PermissionedResolverLib.ROLE_SET_TEXT,
                address(registrar)
            )
        );
        vm.prank(address(registrar));
        resolver.setText(name, "description", "hijack");
    }

    function test_matrix_strangerCannotWriteAnything() external {
        vm.startPrank(stranger);
        vm.expectRevert();
        resolver.setText(name, "description", "x");
        vm.expectRevert();
        resolver.setText(name, "nightshift.reputation", "x");
        vm.expectRevert();
        resolver.setAddress(name, 60, abi.encodePacked(stranger));
        vm.stopPrank();
    }

    function test_revokeOnFork() external {
        vm.prank(admin);
        registrar.revoke(LABEL, "fork test");
        assertEq(registry.getResolver(LABEL), address(0));
        assertTrue(registrar.available(LABEL));
    }
}
