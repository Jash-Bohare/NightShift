// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {
    IPermissionedRegistry
} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";

import {NightshiftRegistrar} from "../src/NightshiftRegistrar.sol";
import {SepoliaConfig} from "./SepoliaConfig.sol";

/// Deploys NightshiftRegistrar (admin = deployer, operator = ENS_OPERATOR_PRIVATE_KEY's address),
/// grants it REGISTRAR | RENEW | UNREGISTER on our UserRegistry and writes deployments/sepolia.json.
/// Run: forge script script/01_DeployRegistrar.s.sol --rpc-url sepolia --broadcast --verify
contract DeployRegistrar is Script {
    function run() external returns (NightshiftRegistrar registrar) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerKey);
        address operator = vm.addr(vm.envUint("ENS_OPERATOR_PRIVATE_KEY"));
        IPermissionedRegistry userRegistry =
            IPermissionedRegistry(vm.envAddress("ENS_USER_REGISTRY_ADDRESS"));
        require(
            address(
                IPermissionedRegistry(SepoliaConfig.ETH_REGISTRY)
                    .getSubregistry(SepoliaConfig.PARENT_LABEL)
            ) == address(userRegistry),
            "ENS_USER_REGISTRY_ADDRESS is not the subregistry of nightshift.eth (run 00 first)"
        );

        vm.startBroadcast(deployerKey);
        registrar = new NightshiftRegistrar(
            userRegistry,
            IVerifiableFactory(SepoliaConfig.VERIFIABLE_FACTORY),
            SepoliaConfig.PERMISSIONED_RESOLVER_IMPL,
            SepoliaConfig.PARENT_NAME,
            operator,
            admin
        );
        userRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW
                | RegistryRolesLib.ROLE_UNREGISTER,
            address(registrar)
        );
        vm.stopBroadcast();

        console.log("NightshiftRegistrar:", address(registrar));
        console.log("operator:", operator);
        console.log("admin:", admin);
        _writeDeployments(address(registrar), address(userRegistry), operator, admin);
    }

    function _writeDeployments(
        address registrar,
        address userRegistry,
        address operator,
        address admin
    ) internal {
        string memory ens = "ens";
        vm.serializeAddress(ens, "ethRegistry", SepoliaConfig.ETH_REGISTRY);
        vm.serializeAddress(ens, "verifiableFactory", SepoliaConfig.VERIFIABLE_FACTORY);
        vm.serializeAddress(
            ens, "permissionedResolverImpl", SepoliaConfig.PERMISSIONED_RESOLVER_IMPL
        );
        string memory ensJson =
            vm.serializeAddress(ens, "universalResolver", SepoliaConfig.UNIVERSAL_RESOLVER);

        string memory root = "root";
        vm.serializeUint(root, "chainId", SepoliaConfig.CHAIN_ID);
        vm.serializeString(root, "parentName", SepoliaConfig.PARENT_NAME);
        vm.serializeAddress(root, "nightshiftRegistrar", registrar);
        vm.serializeAddress(root, "userRegistry", userRegistry);
        vm.serializeAddress(root, "operator", operator);
        vm.serializeAddress(root, "admin", admin);
        vm.serializeUint(root, "deployBlock", block.number);
        string memory json = vm.serializeString(root, "ensv2", ensJson);
        vm.writeJson(json, SepoliaConfig.DEPLOYMENTS_PATH);
    }
}
