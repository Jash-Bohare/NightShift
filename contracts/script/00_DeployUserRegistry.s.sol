// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
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

import {SepoliaConfig} from "./SepoliaConfig.sol";

/// Ensures nightshift.eth points at a UserRegistry owned by the deployer.
/// Reuses ENS_USER_REGISTRY_ADDRESS when it is already the subregistry (our P0.5 deployment);
/// otherwise deploys one via VerifiableFactory and calls ETHRegistry.setSubregistry.
/// Run: forge script script/00_DeployUserRegistry.s.sol --rpc-url sepolia --broadcast
contract DeployUserRegistry is Script {
    function run() external returns (address userRegistry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        IPermissionedRegistry ethRegistry = IPermissionedRegistry(SepoliaConfig.ETH_REGISTRY);

        address current = address(ethRegistry.getSubregistry(SepoliaConfig.PARENT_LABEL));
        address configured = vm.envOr("ENS_USER_REGISTRY_ADDRESS", address(0));
        if (current != address(0) && current == configured) {
            require(
                IPermissionedRegistry(current).hasRootRoles(EACBaseRolesLib.ALL_ROLES, deployer),
                "deployer does not hold all roles on the existing UserRegistry"
            );
            console.log("Reusing UserRegistry (already subregistry of nightshift.eth):", current);
            return current;
        }

        // Salt scheme from ENS docs: keccak256(abi.encode(keccak256("UserRegistry"), namehash, version)).
        bytes32 node = NameCoder.namehash(NameCoder.encode(SepoliaConfig.PARENT_NAME), 0);
        uint256 version = vm.envOr("USER_REGISTRY_VERSION", uint256(2));
        uint256 salt = uint256(keccak256(abi.encode(keccak256("UserRegistry"), node, version)));
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(deployer, EACBaseRolesLib.ALL_ROLES);

        vm.startBroadcast(deployerKey);
        userRegistry = IVerifiableFactory(SepoliaConfig.VERIFIABLE_FACTORY)
            .deployProxy(
                SepoliaConfig.USER_REGISTRY_IMPL,
                salt,
                abi.encodeCall(IEACGrantInitializable.initialize, (grants))
            );
        ethRegistry.setSubregistry(
            uint256(keccak256(bytes(SepoliaConfig.PARENT_LABEL))), IRegistry(userRegistry)
        );
        vm.stopBroadcast();
        console.log("Deployed UserRegistry and set as subregistry:", userRegistry);
    }
}
