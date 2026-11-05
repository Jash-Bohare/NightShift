// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {NightshiftRegistrar} from "../src/NightshiftRegistrar.sol";
import {SepoliaConfig} from "./SepoliaConfig.sol";

/// Registers SMOKE_LABEL (default "hello2") through the deployed registrar as the operator,
/// owned by SMOKE_OWNER_ADDRESS, with test records.
/// Run: forge script script/02_SmokeRegister.s.sol --rpc-url sepolia --broadcast
contract SmokeRegister is Script {
    function run() external returns (address resolver, uint256 tokenId) {
        NightshiftRegistrar registrar = NightshiftRegistrar(
            vm.parseJsonAddress(vm.readFile(SepoliaConfig.DEPLOYMENTS_PATH), ".nightshiftRegistrar")
        );
        string memory label = vm.envOr("SMOKE_LABEL", string("hello2"));
        address owner = vm.envAddress("SMOKE_OWNER_ADDRESS");

        NightshiftRegistrar.Record[] memory initial = new NightshiftRegistrar.Record[](3);
        initial[0] = NightshiftRegistrar.Record(
            "agent-context", '{"v":1,"note":"Nightshift registrar smoke test"}'
        );
        initial[1] = NightshiftRegistrar.Record("description", "Nightshift smoke-test agent");
        initial[2] = NightshiftRegistrar.Record("nightshift.skill", "transcribe:ta");

        vm.startBroadcast(vm.envUint("ENS_OPERATOR_PRIVATE_KEY"));
        (resolver, tokenId) = registrar.registerAgent(label, owner, initial);
        vm.stopBroadcast();

        console.log("registered", string.concat(label, ".", SepoliaConfig.PARENT_NAME));
        console.log("resolver:", resolver);
        console.log("owner:", owner);
    }
}
