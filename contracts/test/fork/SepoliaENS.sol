// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Live Sepolia ENSv2 addresses (docs/07, contracts-v2 @ 07e55a0) and our P0.5 deployments.
library SepoliaENS {
    address internal constant ETH_REGISTRY = 0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4;
    address internal constant VERIFIABLE_FACTORY = 0xDa70306C98E97eCe36F997a21368e53298572991;
    address internal constant PERMISSIONED_RESOLVER_IMPL =
        0x115eb53F0c60696633855F90b138178Fb40b2b2C;
    address internal constant UNIVERSAL_RESOLVER = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;

    /// UserRegistry behind nightshift.eth (P0.5) and the wallet holding all of its roles.
    address internal constant NIGHTSHIFT_USER_REGISTRY = 0x68177337D020e03815bE894450914d7C94682425;
    address internal constant NIGHTSHIFT_DEPLOYER = 0xc57aB1ceF012CC669C89cA4Efd929b807BD15a4c;

    /// Block after the P0.5 deployments; pinning keeps fork tests reproducible and cached.
    uint256 internal constant FORK_BLOCK = 11_970_934;
}
