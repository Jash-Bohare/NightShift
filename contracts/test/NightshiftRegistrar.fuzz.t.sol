// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {
    IPermissionedResolver
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";

import {NightshiftRegistrar} from "../src/NightshiftRegistrar.sol";
import {NightshiftFixture} from "./utils/NightshiftFixture.sol";

contract NightshiftRegistrarFuzzTest is NightshiftFixture {
    bytes constant ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";

    function setUp() external {
        deployNightshift();
    }

    /// Independent reference for the label rule (3–32 chars, [a-z0-9-], no edge hyphen),
    /// written against an allow-list string rather than byte ranges.
    function referenceIsValid(bytes memory b) internal pure returns (bool) {
        if (b.length < 3 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bool found;
            for (uint256 j; j < ALPHABET.length; ++j) {
                if (b[i] == ALPHABET[j]) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    /// Builds a valid label of length 3–32 from `seed`.
    function validLabel(uint256 seed) internal pure returns (string memory) {
        uint256 len = 3 + (seed % 30);
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            // edges come from the 36 non-hyphen characters
            uint256 range = (i == 0 || i == len - 1) ? 36 : ALPHABET.length;
            b[i] = ALPHABET[seed % range];
        }
        return string(b);
    }

    function testFuzz_labelValidation_matchesReference(bytes memory raw) external view {
        assertEq(registrar.isValidLabel(string(raw)), referenceIsValid(raw));
    }

    function testFuzz_labelValidation_mostlyAlphabet(uint256 seed, uint8 lenSeed) external view {
        // Bias toward the alphabet so the fuzzer explores edge hyphens and lengths around 3/32.
        uint256 len = lenSeed % 40;
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            b[i] = seed % 10 == 0 ? bytes1(uint8(seed >> 8)) : ALPHABET[seed % ALPHABET.length];
        }
        assertEq(registrar.isValidLabel(string(b)), referenceIsValid(b));
    }

    function testFuzz_dnsEncoding_roundTrips(uint256 seed) external view {
        string memory label = validLabel(seed);
        assertTrue(registrar.isValidLabel(label));
        bytes memory encoded = registrar.dnsNameOf(label);
        string memory full = string.concat(label, ".nightshift.eth");
        assertEq(encoded, NameCoder.encode(full));
        assertEq(NameCoder.decode(encoded), full);
    }

    function testFuzz_registerThenResolve(uint256 seed) external {
        string memory label = validLabel(seed);
        vm.prank(operator);
        (address resolver,) = registrar.registerAgent(label, agentOwner, records("fuzz", "ctx"));
        assertEq(findResolverV2(dns(label)), resolver);
        assertEq(text(label, "description"), "fuzz");
        assertEq(text(label, "nightshift.reputation"), '{"jobs":0}');
    }

    function testFuzz_onlyRegistrarWritesReputation(address caller, string calldata value)
        external
    {
        vm.assume(caller != address(registrar));
        (address resolver,) = register("fuzz-rep");
        vm.expectRevert();
        vm.prank(caller);
        IPermissionedResolver(resolver).setText(dns("fuzz-rep"), "nightshift.reputation", value);

        vm.prank(operator);
        registrar.setReputation("fuzz-rep", value);
        assertEq(text("fuzz-rep", "nightshift.reputation"), value);
    }

    function testFuzz_initialKeysFiltered(string calldata key) external {
        NightshiftRegistrar.Record[] memory r = new NightshiftRegistrar.Record[](1);
        r[0] = NightshiftRegistrar.Record(key, "v");
        bool allowed = registrar.isOwnerKey(key);
        if (allowed) {
            vm.prank(operator);
            registrar.registerAgent("fuzz-key", agentOwner, r);
            assertEq(text("fuzz-key", key), "v");
        } else {
            vm.expectRevert(abi.encodeWithSelector(NightshiftRegistrar.KeyNotAllowed.selector, key));
            vm.prank(operator);
            registrar.registerAgent("fuzz-key", agentOwner, r);
        }
    }

    function testFuzz_onlyOperatorRegisters(address caller) external {
        vm.assume(caller != operator);
        vm.expectRevert(NightshiftRegistrar.NotOperator.selector);
        vm.prank(caller);
        registrar.registerAgent("abc", agentOwner, records("d", "c"));
    }
}
