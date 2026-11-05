// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {
    IEnhancedAccessControl
} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {
    IPermissionedRegistry
} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {
    IPermissionedResolver
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {
    PermissionedResolverLib
} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";

import {NightshiftRegistrar} from "../src/NightshiftRegistrar.sol";
import {NightshiftFixture} from "./utils/NightshiftFixture.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

contract NightshiftRegistrarTest is NightshiftFixture {
    function setUp() external {
        deployNightshift();
    }

    // ---- constructor / config

    function test_constructor_setsConfig() external view {
        assertEq(address(registrar.REGISTRY()), address(userRegistry));
        assertEq(address(registrar.FACTORY()), address(verifiableFactory));
        assertEq(registrar.RESOLVER_IMPL(), resolverImpl);
        assertEq(registrar.operator(), operator);
        assertEq(registrar.admin(), admin);
        assertEq(registrar.PARENT_DNS(), NameCoder.encode(PARENT));
        assertFalse(registrar.paused());
    }

    function test_constructor_rejectsZeroAddresses() external {
        IPermissionedRegistry reg = IPermissionedRegistry(address(userRegistry));
        IVerifiableFactory fac = verifiableFactory;
        vm.expectRevert(NightshiftRegistrar.ZeroAddress.selector);
        new NightshiftRegistrar(
            IPermissionedRegistry(address(0)), fac, resolverImpl, PARENT, operator, admin
        );
        vm.expectRevert(NightshiftRegistrar.ZeroAddress.selector);
        new NightshiftRegistrar(
            reg, IVerifiableFactory(address(0)), resolverImpl, PARENT, operator, admin
        );
        vm.expectRevert(NightshiftRegistrar.ZeroAddress.selector);
        new NightshiftRegistrar(reg, fac, address(0), PARENT, operator, admin);
        vm.expectRevert(NightshiftRegistrar.ZeroAddress.selector);
        new NightshiftRegistrar(reg, fac, resolverImpl, PARENT, address(0), admin);
        vm.expectRevert(NightshiftRegistrar.ZeroAddress.selector);
        new NightshiftRegistrar(reg, fac, resolverImpl, PARENT, operator, address(0));
    }

    // ---- registerAgent happy path

    function test_registerAgent_happyPath() external {
        uint64 expectedExpiry = uint64(block.timestamp) + registrar.DEFAULT_TERM();
        bytes32 h = keccak256("tamil-scribe");

        vm.expectEmit(true, true, false, false, address(registrar));
        emit NightshiftRegistrar.AgentRegistered(h, "tamil-scribe", agentOwner, address(0), 0, 0);
        vm.prank(operator);
        (address resolver, uint256 tokenId) = registrar.registerAgent(
            "tamil-scribe", agentOwner, records("Tamil transcription", "ctx-v1")
        );

        assertEq(registrar.resolverOf(h), resolver);
        assertEq(registrar.ownerOf(h), agentOwner);
        assertEq(registrar.registrations(h), 1);
        assertEq(verifiableFactory.verifyContract(resolver), resolverImpl);

        IPermissionedRegistry.State memory state = userRegistry.getState(uint256(h));
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.REGISTERED));
        assertEq(state.expiry, expectedExpiry);
        assertEq(state.tokenId, tokenId);
        assertEq(userRegistry.getOwner(uint256(h)), agentOwner);
        assertEq(userRegistry.getResolver("tamil-scribe"), resolver);

        // Resolution walks root -> eth -> nightshift UserRegistry -> agent resolver.
        assertEq(findResolverV2(dns("tamil-scribe")), resolver);
        assertEq(text("tamil-scribe", "description"), "Tamil transcription");
        assertEq(text("tamil-scribe", "agent-context"), "ctx-v1");
        assertEq(text("tamil-scribe", "nightshift.reputation"), '{"jobs":0}');
    }

    function test_registerAgent_noInitialRecords() external {
        vm.prank(operator);
        registrar.registerAgent("bare", agentOwner, new NightshiftRegistrar.Record[](0));
        assertEq(text("bare", "nightshift.reputation"), '{"jobs":0}');
        assertEq(text("bare", "description"), "");
    }

    function test_registerAgent_allOwnerKeysAccepted() external {
        string[9] memory keys = registrar.ownerKeys();
        NightshiftRegistrar.Record[] memory r = new NightshiftRegistrar.Record[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            r[i] = NightshiftRegistrar.Record(keys[i], string.concat("v-", keys[i]));
        }
        vm.prank(operator);
        registrar.registerAgent("all-keys", agentOwner, r);
        for (uint256 i; i < keys.length; ++i) {
            assertEq(text("all-keys", keys[i]), string.concat("v-", keys[i]));
        }
    }

    // ---- registerAgent guards

    function test_registerAgent_onlyOperator() external {
        vm.expectRevert(NightshiftRegistrar.NotOperator.selector);
        vm.prank(stranger);
        registrar.registerAgent("abc", agentOwner, records("d", "c"));
        vm.expectRevert(NightshiftRegistrar.NotOperator.selector);
        vm.prank(admin);
        registrar.registerAgent("abc", agentOwner, records("d", "c"));
    }

    function test_registerAgent_whenPaused() external {
        vm.prank(admin);
        registrar.setPaused(true);
        vm.expectRevert(NightshiftRegistrar.Paused.selector);
        register("abc");

        vm.prank(admin);
        registrar.setPaused(false);
        register("abc");
    }

    function test_registerAgent_invalidOwner() external {
        vm.expectRevert(NightshiftRegistrar.InvalidOwner.selector);
        vm.prank(operator);
        registrar.registerAgent("abc", address(0), records("d", "c"));
    }

    function test_registerAgent_invalidLabel() external {
        vm.expectRevert(NightshiftRegistrar.InvalidLabel.selector);
        vm.prank(operator);
        registrar.registerAgent("Bad_Label", agentOwner, records("d", "c"));
    }

    function test_registerAgent_nameTaken() external {
        register("taken");
        vm.expectRevert(NightshiftRegistrar.NameTaken.selector);
        register("taken");
    }

    function test_registerAgent_nameTakenOutsideRegistrar() external {
        // A label registered directly in the UserRegistry (by its admin) is also not available.
        userRegistry.register(
            "reserved-x", address(this), userRegistry, address(0), 0, type(uint64).max
        );
        vm.expectRevert(NightshiftRegistrar.NameTaken.selector);
        register("reserved-x");
    }

    function test_registerAgent_rejectsReputationInInitial() external {
        NightshiftRegistrar.Record[] memory r = new NightshiftRegistrar.Record[](1);
        r[0] = NightshiftRegistrar.Record("nightshift.reputation", '{"jobs":9999}');
        vm.expectRevert(
            abi.encodeWithSelector(
                NightshiftRegistrar.KeyNotAllowed.selector, "nightshift.reputation"
            )
        );
        vm.prank(operator);
        registrar.registerAgent("liar", agentOwner, r);
    }

    function test_registerAgent_rejectsUnknownKey() external {
        NightshiftRegistrar.Record[] memory r = new NightshiftRegistrar.Record[](2);
        r[0] = NightshiftRegistrar.Record("description", "fine");
        r[1] = NightshiftRegistrar.Record("url", "not an owner key");
        vm.expectRevert(abi.encodeWithSelector(NightshiftRegistrar.KeyNotAllowed.selector, "url"));
        vm.prank(operator);
        registrar.registerAgent("unknown-key", agentOwner, r);
    }

    // ---- label validation

    function test_isValidLabel_table() external view {
        string[7] memory valid = [
            "abc",
            "a-b",
            "tamil-scribe",
            "123",
            "a1-b2-c3",
            "abcdefghijklmnopqrstuvwxyz012345",
            "x--y"
        ];
        for (uint256 i; i < valid.length; ++i) {
            assertTrue(registrar.isValidLabel(valid[i]), valid[i]);
        }
        string[12] memory invalid = [
            "",
            "ab",
            "abcdefghijklmnopqrstuvwxyz0123456",
            "-ab",
            "ab-",
            "Abc",
            "a_b",
            "a.b",
            "a b",
            unicode"tamil-ஸ்",
            "abc\x00",
            "ab/c"
        ];
        for (uint256 i; i < invalid.length; ++i) {
            assertFalse(registrar.isValidLabel(invalid[i]), invalid[i]);
        }
    }

    function test_isOwnerKey() external view {
        assertTrue(registrar.isOwnerKey("agent-endpoint[x402]"));
        assertTrue(registrar.isOwnerKey("nightshift.payto"));
        assertFalse(registrar.isOwnerKey("nightshift.reputation"));
        assertFalse(registrar.isOwnerKey("Description"));
        assertFalse(registrar.isOwnerKey(""));
    }

    function test_available() external {
        assertTrue(registrar.available("fresh"));
        assertFalse(registrar.available("no")); // invalid
        register("fresh");
        assertFalse(registrar.available("fresh"));
    }

    function test_dnsNameOf() external view {
        assertEq(registrar.dnsNameOf("hello"), hex"0568656c6c6f0a6e6967687473686966740365746800");
        assertEq(
            registrar.dnsNameOf("tamil-scribe"), NameCoder.encode("tamil-scribe.nightshift.eth")
        );
    }

    function test_dnsNameOf_rejectsInvalid() external {
        vm.expectRevert(NightshiftRegistrar.InvalidLabel.selector);
        registrar.dnsNameOf("x");
    }

    // ---- setReputation

    function test_setReputation() external {
        register("rep");
        vm.expectEmit(true, false, false, true, address(registrar));
        emit NightshiftRegistrar.ReputationUpdated(keccak256("rep"), '{"jobs":3}');
        vm.prank(operator);
        registrar.setReputation("rep", '{"jobs":3}');
        assertEq(text("rep", "nightshift.reputation"), '{"jobs":3}');
    }

    function test_setReputation_onlyOperator() external {
        register("rep");
        vm.expectRevert(NightshiftRegistrar.NotOperator.selector);
        vm.prank(agentOwner);
        registrar.setReputation("rep", '{"jobs":9999}');
    }

    function test_setReputation_unknownAgent() external {
        vm.expectRevert(NightshiftRegistrar.UnknownAgent.selector);
        vm.prank(operator);
        registrar.setReputation("ghost", "{}");
    }

    // ---- renew

    function test_renew_extendsExpiry() external {
        register("renew-me");
        uint64 before = userRegistry.getExpiry(labelId("renew-me"));
        vm.expectEmit(true, false, false, true, address(registrar));
        emit NightshiftRegistrar.AgentRenewed(keccak256("renew-me"), before + 30 days);
        vm.prank(operator);
        registrar.renew("renew-me", 30 days);
        assertEq(userRegistry.getExpiry(labelId("renew-me")), before + 30 days);
    }

    function test_renew_maxTermAllowed() external {
        register("long");
        vm.prank(operator);
        registrar.renew("long", 365 days);
    }

    function test_renew_termTooLong() external {
        register("long");
        vm.expectRevert(NightshiftRegistrar.TermTooLong.selector);
        vm.prank(operator);
        registrar.renew("long", 365 days + 1);
    }

    function test_renew_unknownAgent() external {
        vm.expectRevert(NightshiftRegistrar.UnknownAgent.selector);
        vm.prank(operator);
        registrar.renew("ghost", 1 days);
    }

    function test_renew_expiredAgent() external {
        register("lapsed");
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(NightshiftRegistrar.UnknownAgent.selector);
        vm.prank(operator);
        registrar.renew("lapsed", 1 days);
    }

    function test_renew_onlyOperator() external {
        register("renew-me");
        vm.expectRevert(NightshiftRegistrar.NotOperator.selector);
        vm.prank(agentOwner);
        registrar.renew("renew-me", 1 days);
    }

    // ---- expiry and re-registration

    function test_expiredLabelCanBeReRegisteredWithFreshResolver() external {
        (address first,) = register("cycle");
        vm.warp(block.timestamp + 31 days);
        assertTrue(registrar.available("cycle"));
        (address second,) = register("cycle");
        assertTrue(first != second);
        assertEq(registrar.resolverOf(keccak256("cycle")), second);
        assertEq(registrar.registrations(keccak256("cycle")), 2);
        assertEq(text("cycle", "nightshift.reputation"), '{"jobs":0}');
    }

    // ---- revoke

    function test_revoke() external {
        register("abuser");
        bytes32 h = keccak256("abuser");
        vm.expectEmit(true, false, false, true, address(registrar));
        emit NightshiftRegistrar.AgentRevoked(h, "spam");
        vm.prank(admin);
        registrar.revoke("abuser", "spam");

        assertEq(registrar.resolverOf(h), address(0));
        assertEq(registrar.ownerOf(h), address(0));
        assertEq(
            uint8(userRegistry.getStatus(uint256(h))), uint8(IPermissionedRegistry.Status.AVAILABLE)
        );
        assertEq(findResolverV2(dns("abuser")), address(0));
        assertTrue(registrar.available("abuser"));

        vm.expectRevert(NightshiftRegistrar.UnknownAgent.selector);
        vm.prank(operator);
        registrar.setReputation("abuser", "{}");
    }

    /// Found by invariant testing: the registry reverts LabelExpired on unregister of an expired
    /// name, so revoke must still clear our records without calling it.
    function test_revoke_expiredAgent() external {
        register("lapsed");
        vm.warp(block.timestamp + 31 days);
        vm.prank(admin);
        registrar.revoke("lapsed", "cleanup");
        assertEq(registrar.resolverOf(keccak256("lapsed")), address(0));
        assertTrue(registrar.available("lapsed"));
    }

    function test_revoke_onlyAdmin() external {
        register("abuser");
        vm.expectRevert(NightshiftRegistrar.NotAdmin.selector);
        vm.prank(operator);
        registrar.revoke("abuser", "spam");
    }

    function test_revoke_unknownAgent() external {
        vm.expectRevert(NightshiftRegistrar.UnknownAgent.selector);
        vm.prank(admin);
        registrar.revoke("ghost", "none");
    }

    // ---- admin config

    function test_setOperator() external {
        address next = makeAddr("next");
        vm.expectEmit(true, false, false, false, address(registrar));
        emit NightshiftRegistrar.OperatorChanged(next);
        vm.prank(admin);
        registrar.setOperator(next);
        assertEq(registrar.operator(), next);

        vm.expectRevert(NightshiftRegistrar.NotOperator.selector);
        register("old-operator");
    }

    function test_setOperator_guards() external {
        vm.expectRevert(NightshiftRegistrar.NotAdmin.selector);
        vm.prank(operator);
        registrar.setOperator(stranger);
        vm.expectRevert(NightshiftRegistrar.ZeroAddress.selector);
        vm.prank(admin);
        registrar.setOperator(address(0));
    }

    function test_setPaused_onlyAdmin() external {
        vm.expectRevert(NightshiftRegistrar.NotAdmin.selector);
        vm.prank(operator);
        registrar.setPaused(true);
    }

    // ---- permission matrix (local; the same matrix runs on the Sepolia fork)

    function test_matrix_ownerCanSetEveryOwnerKey() external {
        register("matrix");
        bytes memory name = dns("matrix");
        string[9] memory keys = registrar.ownerKeys();
        vm.startPrank(agentOwner);
        for (uint256 i; i < keys.length; ++i) {
            IPermissionedResolver(registrar.resolverOf(keccak256("matrix")))
                .setText(name, keys[i], "owner");
        }
        vm.stopPrank();
        for (uint256 i; i < keys.length; ++i) {
            assertEq(text("matrix", keys[i]), "owner");
        }
    }

    function test_matrix_ownerCannotWriteReputation() external {
        (address resolver,) = register("matrix");
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256("nightshift.reputation")),
                PermissionedResolverLib.ROLE_SET_TEXT,
                agentOwner
            )
        );
        vm.prank(agentOwner);
        IPermissionedResolver(resolver)
            .setText(dns("matrix"), "nightshift.reputation", '{"jobs":9999}');
    }

    function test_matrix_ownerCannotLinkUpgradeOrGrant() external {
        (address resolver,) = register("matrix");
        vm.startPrank(agentOwner);
        vm.expectRevert();
        IPermissionedResolver(resolver).linkToRecord(dns("other"), 1);
        vm.expectRevert();
        IUUPS(resolver).upgradeToAndCall(resolverImpl, "");
        vm.expectRevert();
        IPermissionedResolver(resolver)
            .grantRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, agentOwner);
        vm.stopPrank();
    }

    function test_matrix_ownerCanSetAddressAndContenthash() external {
        (address resolver,) = register("matrix");
        assertTrue(
            IPermissionedResolver(resolver)
                .hasRootRoles(
                    PermissionedResolverLib.ROLE_SET_ADDRESS
                        | PermissionedResolverLib.ROLE_SET_CONTENTHASH,
                    agentOwner
                )
        );
        vm.prank(agentOwner);
        IPermissionedResolver(resolver).setAddress(dns("matrix"), 60, abi.encodePacked(agentOwner));
    }

    function test_matrix_registrarCannotWriteIdentityKeys() external {
        (address resolver,) = register("matrix");
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256("description")),
                PermissionedResolverLib.ROLE_SET_TEXT,
                address(registrar)
            )
        );
        vm.prank(address(registrar));
        IPermissionedResolver(resolver).setText(dns("matrix"), "description", "hijack");
        assertFalse(
            IPermissionedResolver(resolver)
                .hasRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, address(registrar))
        );
    }

    function test_matrix_strangerCannotWriteAnything() external {
        (address resolver,) = register("matrix");
        vm.startPrank(stranger);
        vm.expectRevert();
        IPermissionedResolver(resolver).setText(dns("matrix"), "description", "x");
        vm.expectRevert();
        IPermissionedResolver(resolver).setText(dns("matrix"), "nightshift.reputation", "x");
        vm.expectRevert();
        IPermissionedResolver(resolver).setAddress(dns("matrix"), 60, abi.encodePacked(stranger));
        vm.stopPrank();
    }

    function test_matrix_ownerHasNoRegistryRoles() external {
        (, uint256 tokenId) = register("matrix");
        assertEq(userRegistry.roles(tokenId, agentOwner), 0);
        vm.startPrank(agentOwner);
        vm.expectRevert();
        userRegistry.setResolver(tokenId, stranger);
        vm.expectRevert();
        userRegistry.setSubregistry(tokenId, userRegistry);
        vm.expectRevert();
        userRegistry.safeTransferFrom(agentOwner, stranger, tokenId, 1, "");
        vm.stopPrank();
    }

    function test_registrarRootRolesOnRegistry() external view {
        assertTrue(userRegistry.hasRootRoles(REGISTRAR_ROOT_ROLES, address(registrar)));
        assertFalse(
            userRegistry.hasRootRoles(RegistryRolesLib.ROLE_SET_RESOLVER, address(registrar))
        );
    }
}
