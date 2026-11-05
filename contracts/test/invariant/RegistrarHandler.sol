// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {
    IPermissionedResolver
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";

import {NightshiftRegistrar} from "../../src/NightshiftRegistrar.sol";

/// @dev Drives the registrar through random operator/admin/attacker sequences and records ghost
///      state for the invariants in RegistrarInvariant.t.sol.
contract RegistrarHandler is Test {
    NightshiftRegistrar public immutable registrar;
    address public immutable operator;
    address public immutable admin;

    string[5] internal LABELS = ["alpha", "beta-2", "gamma", "delta-x", "eps"];
    address[3] internal OWNERS = [address(0xA11CE), address(0xB0B), address(0xCA7)];

    /// Every resolver ever deployed (also after revoke/expiry).
    address[] public resolvers;
    /// Last reputation value the registrar wrote per label (via setReputation or registration).
    mapping(bytes32 => string) public ghostReputation;
    /// Count of reputation writes by anyone other than the registrar that did NOT revert.
    uint256 public ghostForeignReputationWrites;
    uint256 public calls;

    constructor(NightshiftRegistrar registrar_, address operator_, address admin_) {
        registrar = registrar_;
        operator = operator_;
        admin = admin_;
    }

    function labelCount() external view returns (uint256) {
        return LABELS.length;
    }

    function labelAt(uint256 i) external view returns (string memory) {
        return LABELS[i];
    }

    function resolverCount() external view returns (uint256) {
        return resolvers.length;
    }

    function _label(uint256 seed) internal view returns (string memory) {
        return LABELS[seed % LABELS.length];
    }

    // ---- actions

    function registerAgent(uint256 labelSeed, uint256 ownerSeed) external {
        ++calls;
        string memory label = _label(labelSeed);
        if (!registrar.available(label)) return;
        vm.prank(operator);
        (address resolver,) = registrar.registerAgent(
            label, OWNERS[ownerSeed % OWNERS.length], new NightshiftRegistrar.Record[](0)
        );
        resolvers.push(resolver);
        ghostReputation[keccak256(bytes(label))] = registrar.INITIAL_REPUTATION();
    }

    function setReputation(uint256 labelSeed, uint256 jobs) external {
        ++calls;
        string memory label = _label(labelSeed);
        if (registrar.resolverOf(keccak256(bytes(label))) == address(0)) return;
        string memory json = string.concat('{"jobs":', vm.toString(jobs % 1e6), "}");
        vm.prank(operator);
        registrar.setReputation(label, json);
        ghostReputation[keccak256(bytes(label))] = json;
    }

    function renew(uint256 labelSeed, uint64 duration) external {
        ++calls;
        string memory label = _label(labelSeed);
        duration = uint64(bound(duration, 0, registrar.MAX_TERM()));
        vm.prank(operator);
        try registrar.renew(label, duration) {} catch {}
    }

    function revoke(uint256 labelSeed) external {
        ++calls;
        string memory label = _label(labelSeed);
        if (registrar.resolverOf(keccak256(bytes(label))) == address(0)) return;
        vm.prank(admin);
        registrar.revoke(label, "invariant");
    }

    function warp(uint256 secs) external {
        ++calls;
        vm.warp(block.timestamp + bound(secs, 1, 40 days));
    }

    /// The owner (or anyone else) tries to write reputation directly on the resolver.
    function attackReputation(uint256 labelSeed, uint256 attackerSeed) external {
        ++calls;
        string memory label = _label(labelSeed);
        address resolver = registrar.resolverOf(keccak256(bytes(label)));
        if (resolver == address(0)) return;
        address attacker = attackerSeed % 2 == 0
            ? registrar.ownerOf(keccak256(bytes(label)))
            : address(uint160(attackerSeed | 1));
        if (attacker == address(registrar)) return;
        vm.prank(attacker);
        try IPermissionedResolver(resolver)
            .setText(
                NameCoder.encode(string.concat(label, ".nightshift.eth")),
                registrar.REPUTATION_KEY(),
                '{"jobs":999999}'
            ) {
            ++ghostForeignReputationWrites;
        } catch {}
    }
}
