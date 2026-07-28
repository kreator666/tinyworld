// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {DIDParts} from "../src/DIDParts.sol";

/// @notice 部署 DIDParts + DIDIdentity，并把配件合约注册进身份合约白名单
/// 环境变量（均有默认值，可无配置本地跑）：
///   PRIVATE_KEY       部署者私钥（缺省用 anvil 默认账户）
///   DID_BASE_URI      DID 元数据前缀，后端按 tokenId 合成纸娃娃图
///   DID_CONTRACT_URI  合约级元数据（市场展示）
///   PARTS_BASE_URI    配件元数据（ERC-1155 支持 {id} 占位符）
contract Deploy is Script {
    function run() external returns (DIDIdentity identity, DIDParts parts) {
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

        parts = new DIDParts(partsURI);
        identity = new DIDIdentity("DID AI Verse Identity", "DIDAI", baseURI, contractURI);
        identity.setCollectionApproved(address(parts), true);

        vm.stopBroadcast();

        console2.log("DIDParts   deployed at:", address(parts));
        console2.log("DIDIdentity deployed at:", address(identity));
        console2.log("Owner (deployer):", identity.owner());
    }
}
