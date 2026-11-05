// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Live Sepolia ENSv2 deployment (docs/07; contracts-v2 deployments/sepolia @ 07e55a0).
library SepoliaConfig {
    uint256 internal constant CHAIN_ID = 11_155_111;
    address internal constant ETH_REGISTRY = 0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4;
    address internal constant VERIFIABLE_FACTORY = 0xDa70306C98E97eCe36F997a21368e53298572991;
    address internal constant USER_REGISTRY_IMPL = 0x9BD8a88719068D09ecee662f36C0E3856708366a;
    address internal constant PERMISSIONED_RESOLVER_IMPL =
        0x115eb53F0c60696633855F90b138178Fb40b2b2C;
    address internal constant UNIVERSAL_RESOLVER = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    string internal constant PARENT_LABEL = "nightshift";
    string internal constant PARENT_NAME = "nightshift.eth";
    string internal constant DEPLOYMENTS_PATH = "./deployments/sepolia.json";
}
