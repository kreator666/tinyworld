// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {DIDParts} from "../src/DIDParts.sol";
import {StarterPartClaim} from "../src/StarterPartClaim.sol";
import {PartsMarket} from "../src/PartsMarket.sol";
import {DIDReputation} from "../src/DIDReputation.sol";
import {DIDValidation} from "../src/DIDValidation.sol";

/// @notice 使用 UUPS 代理模式部署 DID 全套合约
/// 环境变量（均有默认值，可无配置本地跑）：
///   PRIVATE_KEY       部署者私钥（缺省用 anvil 默认账户）
///   DID_BASE_URI      DID 元数据前缀
///   DID_CONTRACT_URI  合约级元数据
///   PARTS_BASE_URI    配件元数据（ERC-1155 支持 {id} 占位符）
contract Deploy is Script {
    struct Addresses {
        address identityProxy;
        address partsProxy;
        address claimProxy;
        address marketProxy;
        address reputationProxy;
        address validationProxy;
    }

    function run() external returns (Addresses memory addrs) {
        string memory baseURI = vm.envOr("DID_BASE_URI", string("https://api.didaiverse.example/metadata/did/"));
        string memory contractURI =
            vm.envOr("DID_CONTRACT_URI", string("https://api.didaiverse.example/metadata/contract.json"));
        string memory partsURI = vm.envOr("PARTS_BASE_URI", string("https://api.didaiverse.example/parts/{id}.json"));

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }

        DIDIdentity identityImpl = new DIDIdentity();
        DIDParts partsImpl = new DIDParts();
        StarterPartClaim claimImpl = new StarterPartClaim();
        PartsMarket marketImpl = new PartsMarket();
        DIDReputation reputationImpl = new DIDReputation();
        DIDValidation validationImpl = new DIDValidation();

        addrs.identityProxy = address(
            new ERC1967Proxy(
                address(identityImpl),
                abi.encodeCall(DIDIdentity.initialize, ("DID AI Verse Identity", "DIDAI", baseURI, contractURI))
            )
        );
        addrs.partsProxy = address(
            new ERC1967Proxy(address(partsImpl), abi.encodeCall(DIDParts.initialize, (partsURI)))
        );
        addrs.claimProxy = address(
            new ERC1967Proxy(
                address(claimImpl), abi.encodeCall(StarterPartClaim.initialize, (addrs.partsProxy, addrs.identityProxy))
            )
        );
        addrs.marketProxy = address(
            new ERC1967Proxy(address(marketImpl), abi.encodeCall(PartsMarket.initialize, (addrs.partsProxy)))
        );
        addrs.reputationProxy = address(
            new ERC1967Proxy(
                address(reputationImpl), abi.encodeCall(DIDReputation.initialize, (addrs.identityProxy))
            )
        );
        addrs.validationProxy = address(
            new ERC1967Proxy(
                address(validationImpl), abi.encodeCall(DIDValidation.initialize, (addrs.identityProxy))
            )
        );

        DIDIdentity(payable(addrs.identityProxy)).setCollectionApproved(addrs.partsProxy, true);
        DIDParts(addrs.partsProxy).setMinter(addrs.claimProxy, true);
        DIDParts(addrs.partsProxy).setMinter(addrs.marketProxy, true);

        vm.stopBroadcast();

        console2.log("=== UUPS Proxy Addresses ===");
        console2.log("DIDIdentity    proxy:", addrs.identityProxy);
        console2.log("DIDParts       proxy:", addrs.partsProxy);
        console2.log("StarterPartClaim proxy:", addrs.claimProxy);
        console2.log("PartsMarket    proxy:", addrs.marketProxy);
        console2.log("DIDReputation  proxy:", addrs.reputationProxy);
        console2.log("DIDValidation  proxy:", addrs.validationProxy);
        console2.log("Owner (deployer):", DIDIdentity(payable(addrs.identityProxy)).owner());
    }
}
