// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {Grant} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {
    IEnhancedAccessControl
} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {
    IPermissionedResolver
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {
    IPermissionedResolverInitializable
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolverInitializable.sol";
import {ITextSetter} from "@ensdomains/contracts-v2/resolver/interfaces/setters/ITextSetter.sol";
import {
    PermissionedResolverLib
} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";

import {SepoliaENS} from "./SepoliaENS.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// P1.2 — answers docs/03 Q1–Q5 against the live Sepolia PermissionedResolver implementation,
/// using exactly the grant layout NightshiftRegistrar will use:
///   owner     -> ROLE_SET_ADDRESS | ROLE_SET_CONTENTHASH at root, setText scoped to owner keys
///   registrar -> ROLE_SET_TEXT_ADMIN at root, setText scoped to nightshift.reputation
/// Run: forge test --match-path test/fork/ResolverPermissions.t.sol -vvv (needs SEPOLIA_RPC_URL)
contract ResolverPermissionsForkTest is Test {
    string constant NAME = "permtest.nightshift.eth";
    string constant OWNER_KEY = "description";
    string constant OTHER_OWNER_KEY = "agent-context";
    string constant UNGRANTED_KEY = "url";
    string constant REPUTATION_KEY = "nightshift.reputation";

    address owner = makeAddr("owner");
    address registrar = makeAddr("registrar");
    address stranger = makeAddr("stranger");

    IPermissionedResolver resolver;
    bytes dnsName;
    bytes32 node;

    function setUp() external {
        vm.createSelectFork(vm.rpcUrl("sepolia"), SepoliaENS.FORK_BLOCK);
        dnsName = NameCoder.encode(NAME);
        node = NameCoder.namehash(dnsName, 0);

        Grant[] memory grants = new Grant[](2);
        grants[0] = Grant(
            owner,
            PermissionedResolverLib.ROLE_SET_ADDRESS | PermissionedResolverLib.ROLE_SET_CONTENTHASH
        );
        grants[1] = Grant(registrar, PermissionedResolverLib.ROLE_SET_TEXT_ADMIN);
        bytes[] memory calls = new bytes[](1);
        calls[0] =
            abi.encodeCall(ITextSetter.setText, (dnsName, OWNER_KEY, "set during initialize"));

        // Q5: this is the exact initialize signature; deployProxy reverts if it doesn't match.
        vm.prank(registrar);
        resolver = IPermissionedResolver(
            IVerifiableFactory(SepoliaENS.VERIFIABLE_FACTORY)
                .deployProxy(
                    SepoliaENS.PERMISSIONED_RESOLVER_IMPL,
                    uint256(keccak256("ResolverPermissionsForkTest")),
                    abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, calls))
                )
        );
    }

    function _text(string memory key) internal view returns (string memory) {
        bytes memory result =
            resolver.resolve(dnsName, abi.encodeCall(ITextResolver.text, (node, key)));
        return abi.decode(result, (string));
    }

    /// Same as PermissionedResolverLib.resource(string calldata): keccak256 of the key.
    function _resource(string memory key) internal pure returns (uint256) {
        return uint256(keccak256(bytes(key)));
    }

    function _textSetter(string memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(ITextSetter.setText, ("", key, ""));
    }

    function _grantOwnerKeysAndReputation() internal {
        vm.startPrank(registrar);
        resolver.grantSetterRoles(_textSetter(OWNER_KEY), owner);
        resolver.grantSetterRoles(_textSetter(OTHER_OWNER_KEY), owner);
        resolver.grantSetterRoles(_textSetter(REPUTATION_KEY), registrar);
        vm.stopPrank();
    }

    function _expectUnauthorized(string memory key, address account) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                _resource(key),
                PermissionedResolverLib.ROLE_SET_TEXT,
                account
            )
        );
    }

    // ---- Q5 + proxy sanity

    function test_Q5_proxyIsVerifiableAndUsesLiveImpl() external view {
        assertEq(
            IVerifiableFactory(SepoliaENS.VERIFIABLE_FACTORY).verifyContract(address(resolver)),
            SepoliaENS.PERMISSIONED_RESOLVER_IMPL
        );
    }

    // ---- Q4: initialize accepts setText calls on the DNS-encoded name (role checks skipped)

    function test_Q4_initializeCallsWriteRecords() external view {
        assertEq(_text(OWNER_KEY), "set during initialize");
    }

    // ---- Q1: ROLE_SET_TEXT_ADMIN at root is enough to issue key-scoped setText grants

    function test_Q1_rootTextAdminCanGrantScopedSetter() external {
        vm.prank(registrar);
        assertTrue(resolver.grantSetterRoles(_textSetter(OWNER_KEY), owner));
        assertTrue(
            resolver.hasRoles(_resource(OWNER_KEY), PermissionedResolverLib.ROLE_SET_TEXT, owner)
        );
        // ...and the grant is scoped: owner has no root text role.
        assertFalse(resolver.hasRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, owner));
    }

    function test_Q1_nonAdminCannotGrantSetter() external {
        _grantOwnerKeysAndReputation();
        // Owner holds the scoped role but not its admin, so can't delegate it.
        vm.prank(owner);
        vm.expectRevert();
        resolver.grantSetterRoles(_textSetter(OWNER_KEY), stranger);
        vm.prank(stranger);
        vm.expectRevert();
        resolver.grantSetterRoles(_textSetter(REPUTATION_KEY), stranger);
    }

    // ---- Q2/Q3: scoped holders write their keys and only those keys

    function test_Q3_ownerWritesScopedKeysWithoutRootTextRole() external {
        _grantOwnerKeysAndReputation();
        vm.startPrank(owner);
        resolver.setText(dnsName, OWNER_KEY, "owner description");
        resolver.setText(dnsName, OTHER_OWNER_KEY, "owner context");
        vm.stopPrank();
        assertEq(_text(OWNER_KEY), "owner description");
        assertEq(_text(OTHER_OWNER_KEY), "owner context");
    }

    function test_Q2_ownerCannotWriteReputationOrUngrantedKeys() external {
        _grantOwnerKeysAndReputation();
        _expectUnauthorized(REPUTATION_KEY, owner);
        vm.prank(owner);
        resolver.setText(dnsName, REPUTATION_KEY, '{"jobs":9999}');

        _expectUnauthorized(UNGRANTED_KEY, owner);
        vm.prank(owner);
        resolver.setText(dnsName, UNGRANTED_KEY, "nope");
    }

    function test_Q2_registrarWritesReputationOnly() external {
        _grantOwnerKeysAndReputation();
        vm.prank(registrar);
        resolver.setText(dnsName, REPUTATION_KEY, '{"jobs":1}');
        assertEq(_text(REPUTATION_KEY), '{"jobs":1}');

        // Holding ROLE_SET_TEXT_ADMIN does not itself allow writing identity keys.
        _expectUnauthorized(OWNER_KEY, registrar);
        vm.prank(registrar);
        resolver.setText(dnsName, OWNER_KEY, "registrar overwrite");
    }

    function test_strangerCannotWriteAnything() external {
        _grantOwnerKeysAndReputation();
        _expectUnauthorized(OWNER_KEY, stranger);
        vm.prank(stranger);
        resolver.setText(dnsName, OWNER_KEY, "x");
        _expectUnauthorized(REPUTATION_KEY, stranger);
        vm.prank(stranger);
        resolver.setText(dnsName, REPUTATION_KEY, "x");
    }

    // ---- Frozen surface: nobody holds ROLE_LINK or ROLE_UPGRADE

    function test_ownerCannotLinkOrUpgrade() external {
        _grantOwnerKeysAndReputation();
        vm.startPrank(owner);
        vm.expectRevert();
        resolver.linkToRecord(NameCoder.encode("evil.nightshift.eth"), 1);
        vm.expectRevert();
        IUUPS(address(resolver)).upgradeToAndCall(address(0xdead), "");
        vm.stopPrank();
    }

    function test_registrarCannotLinkOrUpgrade() external {
        vm.startPrank(registrar);
        vm.expectRevert();
        resolver.linkToRecord(NameCoder.encode("evil.nightshift.eth"), 1);
        vm.expectRevert();
        IUUPS(address(resolver)).upgradeToAndCall(address(0xdead), "");
        vm.stopPrank();
    }

    function test_ownerCanSetAddressAtRoot() external {
        vm.prank(owner);
        resolver.setAddress(dnsName, 60, abi.encodePacked(owner));
    }
}
