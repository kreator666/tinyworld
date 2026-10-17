// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";

/// @notice 仅重新部署 DIDIdentity（加入 PERMISSION_SKILL 后需要新合约地址）
/// 环境变量：
///   PRIVATE_KEY       部署者私钥
///   DID_BASE_URI      DID 元数据前缀（可选，有默认值）
///   DID_CONTRACT_URI  合约级元数据（可选，有默认值）
///   PARTS_ADDRESS     已部署的 DIDParts 合约地址（必须）
contract DeployDIDIdentityOnly is Script {
    function run() external returns (DIDIdentity identity) {
        string memory baseURI = vm.envOr("DID_BASE_URI", string("https://api.didaiverse.example/metadata/did/"));
        string memory contractURI =
            vm.envOr("DID_CONTRACT_URI", string("https://api.didaiverse.example/metadata/contract.json"));
        address partsAddress = vm.envAddress("PARTS_ADDRESS");

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }

        identity = new DIDIdentity("DID AI Verse Identity", "DIDAI", baseURI, contractURI);
        identity.setCollectionApproved(partsAddress, true);

        vm.stopBroadcast();

        console2.log("DIDIdentity deployed at:", address(identity));
        console2.log("Parts approved:", partsAddress);
    }
}
