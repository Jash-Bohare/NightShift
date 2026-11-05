// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IPermissionedRegistry
} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {
    IPermissionedResolver
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {
    PermissionedResolverLib
} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";

import {NightshiftFixture} from "../utils/NightshiftFixture.sol";
import {RegistrarHandler} from "./RegistrarHandler.sol";

/// Invariants from docs/03, checked after every random handler call sequence.
contract RegistrarInvariantTest is NightshiftFixture {
    RegistrarHandler handler;

    function setUp() external {
        deployNightshift();
        handler = new RegistrarHandler(registrar, operator, admin);
        targetContract(address(handler));
    }

    /// nightshift.reputation is only ever written by the registrar.
    function invariant_onlyRegistrarWritesReputation() external view {
        assertEq(handler.ghostForeignReputationWrites(), 0);
        for (uint256 i; i < handler.labelCount(); ++i) {
            string memory label = handler.labelAt(i);
            bytes32 h = keccak256(bytes(label));
            if (registrar.resolverOf(h) == address(0)) continue;
            if (userRegistry.getStatus(uint256(h)) != IPermissionedRegistry.Status.REGISTERED) {
                continue;
            }
            assertEq(text(label, registrar.REPUTATION_KEY()), handler.ghostReputation(h));
        }
    }

    /// resolverOf[h] != 0 <=> name REGISTERED, until expiry (revoke clears both).
    function invariant_resolverOfMatchesRegistry() external view {
        for (uint256 i; i < handler.labelCount(); ++i) {
            bytes32 h = keccak256(bytes(handler.labelAt(i)));
            address resolver = registrar.resolverOf(h);
            IPermissionedRegistry.State memory state = userRegistry.getState(uint256(h));
            if (resolver == address(0)) {
                assertTrue(state.status != IPermissionedRegistry.Status.REGISTERED);
                assertEq(registrar.ownerOf(h), address(0));
            } else if (block.timestamp < state.expiry) {
                assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.REGISTERED));
                assertEq(userRegistry.getResolver(handler.labelAt(i)), resolver);
                assertEq(state.latestOwner, registrar.ownerOf(h));
            } else {
                assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.AVAILABLE));
            }
        }
    }

    /// The registrar never holds root ROLE_SET_TEXT (nor LINK/UPGRADE) on any agent resolver.
    function invariant_registrarNeverHoldsRootText() external view {
        for (uint256 i; i < handler.resolverCount(); ++i) {
            IPermissionedResolver r = IPermissionedResolver(handler.resolvers(i));
            assertFalse(r.hasRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, address(registrar)));
            assertFalse(r.hasRootRoles(PermissionedResolverLib.ROLE_LINK, address(registrar)));
            assertFalse(r.hasRootRoles(PermissionedResolverLib.ROLE_UPGRADE, address(registrar)));
        }
    }

    function invariant_callSummary() external view {
        // Keeps the handler reachable in reports; no assertion beyond "didn't revert".
        handler.calls();
    }
}
