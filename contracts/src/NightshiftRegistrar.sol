// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {Grant} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {
    IPermissionedRegistry
} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
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

/// @title NightshiftRegistrar
/// @notice Issues `<label>.nightshift.eth` to AI worker agents. Each agent gets its own
///         PermissionedResolver with split permissions: the owner edits identity records,
///         only this contract writes `nightshift.reputation`, and nobody can relink or upgrade.
/// @dev See docs/03-contracts.md. Permission layout verified on Sepolia in
///      test/fork/ResolverPermissions.t.sol.
contract NightshiftRegistrar {
    // ---- types

    struct Record {
        string key;
        string value;
    }

    // ---- constants

    uint64 public constant DEFAULT_TERM = 30 days;
    uint64 public constant MAX_TERM = 365 days;
    string public constant REPUTATION_KEY = "nightshift.reputation";
    string public constant INITIAL_REPUTATION = '{"jobs":0}';
    /// @dev Owner holds the name token but no registry roles: non-transferable, fixed resolver.
    uint256 public constant OWNER_REGISTRY_ROLES = 0;
    bytes32 private constant RESOLVER_SALT_TAG = keccak256("NightshiftAgentResolver");

    // ---- immutables

    IPermissionedRegistry public immutable REGISTRY;
    IVerifiableFactory public immutable FACTORY;
    address public immutable RESOLVER_IMPL;
    address public immutable admin;

    /// @notice DNS-encoded parent name, e.g. "\x0anightshift\x03eth\x00".
    bytes public PARENT_DNS;

    // ---- state

    address public operator;
    bool public paused;

    mapping(bytes32 labelhash => address resolver) public resolverOf;
    mapping(bytes32 labelhash => address owner) public ownerOf;
    /// @dev Bumped per registration so a revoked/expired label gets a fresh resolver address.
    mapping(bytes32 labelhash => uint256 count) public registrations;

    // ---- events

    event AgentRegistered(
        bytes32 indexed labelhash,
        string label,
        address indexed owner,
        address resolver,
        uint256 tokenId,
        uint64 expiry
    );
    event AgentRenewed(bytes32 indexed labelhash, uint64 newExpiry);
    event ReputationUpdated(bytes32 indexed labelhash, string value);
    event AgentRevoked(bytes32 indexed labelhash, string reason);
    event OperatorChanged(address indexed operator);
    event PausedSet(bool paused);

    // ---- errors

    error NotOperator();
    error NotAdmin();
    error Paused();
    error InvalidLabel();
    error NameTaken();
    error InvalidOwner();
    error UnknownAgent();
    error KeyNotAllowed(string key);
    error TermTooLong();
    error ZeroAddress();

    // ---- modifiers

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(
        IPermissionedRegistry registry,
        IVerifiableFactory factory,
        address resolverImpl,
        string memory parentName,
        address operator_,
        address admin_
    ) {
        if (
            address(registry) == address(0) || address(factory) == address(0)
                || resolverImpl == address(0) || operator_ == address(0) || admin_ == address(0)
        ) revert ZeroAddress();
        REGISTRY = registry;
        FACTORY = factory;
        RESOLVER_IMPL = resolverImpl;
        PARENT_DNS = NameCoder.encode(parentName);
        operator = operator_;
        admin = admin_;
        emit OperatorChanged(operator_);
    }

    // ---- views

    /// @notice Text keys the agent owner may write (docs/03 OWNER_KEYS).
    function ownerKeys() public pure returns (string[9] memory keys) {
        keys = [
            "agent-context",
            "agent-endpoint[x402]",
            "agent-endpoint[web]",
            "description",
            "avatar",
            "nightshift.skill",
            "nightshift.price",
            "nightshift.payto",
            "nightshift.model"
        ];
    }

    function isOwnerKey(string memory key) public pure returns (bool) {
        bytes32 h = keccak256(bytes(key));
        string[9] memory keys = ownerKeys();
        for (uint256 i; i < keys.length; ++i) {
            if (keccak256(bytes(keys[i])) == h) return true;
        }
        return false;
    }

    /// @notice 3–32 chars of [a-z0-9-], no leading or trailing hyphen.
    function isValidLabel(string memory label) public pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 n = b.length;
        if (n < 3 || n > 32 || b[0] == "-" || b[n - 1] == "-") return false;
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }

    function available(string calldata label) external view returns (bool) {
        return isValidLabel(label) && _status(label) == IPermissionedRegistry.Status.AVAILABLE;
    }

    /// @notice DNS encoding of `<label>.<parent>`, e.g. "\x05hello\x0anightshift\x03eth\x00".
    ///         Reverts for invalid labels, which also keeps the length byte from truncating.
    function dnsNameOf(string calldata label) public view returns (bytes memory) {
        if (!isValidLabel(label)) revert InvalidLabel();
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(bytes1(uint8(bytes(label).length)), label, PARENT_DNS);
    }

    // ---- operator

    /// @notice Deploys the agent's resolver, writes its initial records, splits permissions and
    ///         registers `<label>.<parent>` to `owner`.
    function registerAgent(string calldata label, address owner, Record[] calldata initial)
        external
        onlyOperator
        whenNotPaused
        returns (address resolver, uint256 tokenId)
    {
        if (!isValidLabel(label)) revert InvalidLabel();
        if (owner == address(0)) revert InvalidOwner();
        if (_status(label) != IPermissionedRegistry.Status.AVAILABLE) revert NameTaken();

        bytes32 labelhash = keccak256(bytes(label));
        resolver = _deployResolver(labelhash, owner, _initialCalls(dnsNameOf(label), initial));
        _grantSetters(IPermissionedResolver(resolver), owner);

        uint64 expiry = uint64(block.timestamp) + DEFAULT_TERM;
        tokenId = REGISTRY.register(
            label, owner, IRegistry(address(0)), resolver, OWNER_REGISTRY_ROLES, expiry
        );

        resolverOf[labelhash] = resolver;
        ownerOf[labelhash] = owner;
        emit AgentRegistered(labelhash, label, owner, resolver, tokenId, expiry);
    }

    function setReputation(string calldata label, string calldata json) external onlyOperator {
        bytes32 labelhash = keccak256(bytes(label));
        address resolver = resolverOf[labelhash];
        if (resolver == address(0)) revert UnknownAgent();
        ITextSetter(resolver).setText(dnsNameOf(label), REPUTATION_KEY, json);
        emit ReputationUpdated(labelhash, json);
    }

    function renew(string calldata label, uint64 duration) external onlyOperator {
        if (duration > MAX_TERM) revert TermTooLong();
        bytes32 labelhash = keccak256(bytes(label));
        if (resolverOf[labelhash] == address(0)) revert UnknownAgent();
        IPermissionedRegistry.State memory state = REGISTRY.getState(uint256(labelhash));
        if (state.status != IPermissionedRegistry.Status.REGISTERED) revert UnknownAgent();
        uint64 newExpiry = state.expiry + duration;
        REGISTRY.renew(uint256(labelhash), newExpiry);
        emit AgentRenewed(labelhash, newExpiry);
    }

    // ---- admin

    /// @notice Moderation: unregisters an abusive agent's name. For a name that has already
    ///         expired (the registry rejects unregistering it) only our records are cleared.
    function revoke(string calldata label, string calldata reason) external onlyAdmin {
        bytes32 labelhash = keccak256(bytes(label));
        if (resolverOf[labelhash] == address(0)) revert UnknownAgent();
        delete resolverOf[labelhash];
        delete ownerOf[labelhash];
        if (_status(label) == IPermissionedRegistry.Status.REGISTERED) {
            REGISTRY.unregister(uint256(labelhash));
        }
        emit AgentRevoked(labelhash, reason);
    }

    function setOperator(address operator_) external onlyAdmin {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setPaused(bool paused_) external onlyAdmin {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ---- internal

    /// @dev setText calls for the initial records plus the starting reputation. They run inside
    ///      the resolver's initialize, where role checks are skipped.
    function _initialCalls(bytes memory dnsName, Record[] calldata initial)
        internal
        pure
        returns (bytes[] memory calls)
    {
        calls = new bytes[](initial.length + 1);
        for (uint256 i; i < initial.length; ++i) {
            if (!isOwnerKey(initial[i].key)) revert KeyNotAllowed(initial[i].key);
            calls[i] =
                abi.encodeCall(ITextSetter.setText, (dnsName, initial[i].key, initial[i].value));
        }
        calls[initial.length] =
            abi.encodeCall(ITextSetter.setText, (dnsName, REPUTATION_KEY, INITIAL_REPUTATION));
    }

    /// @dev Root grants: owner gets address + contenthash setters; this contract gets only
    ///      ROLE_SET_TEXT_ADMIN, which lets it issue key-scoped text grants but not write text.
    function _deployResolver(bytes32 labelhash, address owner, bytes[] memory calls)
        internal
        returns (address)
    {
        Grant[] memory grants = new Grant[](2);
        grants[0] = Grant(
            owner,
            PermissionedResolverLib.ROLE_SET_ADDRESS | PermissionedResolverLib.ROLE_SET_CONTENTHASH
        );
        grants[1] = Grant(address(this), PermissionedResolverLib.ROLE_SET_TEXT_ADMIN);

        uint256 version = ++registrations[labelhash];
        uint256 salt = uint256(keccak256(abi.encode(RESOLVER_SALT_TAG, labelhash, version)));
        return FACTORY.deployProxy(
            RESOLVER_IMPL,
            salt,
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, calls))
        );
    }

    /// @dev Owner: setText scoped to each owner key. Registrar: setText scoped to reputation.
    function _grantSetters(IPermissionedResolver resolver, address owner) internal {
        string[9] memory keys = ownerKeys();
        for (uint256 i; i < keys.length; ++i) {
            resolver.grantSetterRoles(_textSetter(keys[i]), owner);
        }
        resolver.grantSetterRoles(_textSetter(REPUTATION_KEY), address(this));
    }

    function _status(string calldata label) internal view returns (IPermissionedRegistry.Status) {
        return REGISTRY.getState(uint256(keccak256(bytes(label)))).status;
    }

    /// @dev grantSetterRoles only reads the selector and key argument of the setter calldata.
    function _textSetter(string memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(ITextSetter.setText, ("", key, ""));
    }
}
