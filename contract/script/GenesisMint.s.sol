// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DIDParts} from "../src/DIDParts.sol";

/// @notice 创世铸造:4 个插槽各一笔 mintPartBatch,每槽 普通12×200 + 稀有9×50 + 史诗6×20 + 传说3×5 = 2985 份,全部铸给 owner
/// 环境变量:
///   PARTS_ADDRESS   已部署的 DIDParts 地址(必填)
///   SEED_TO         接收地址(缺省 = 部署者)
contract GenesisMint is Script {
    uint256 internal constant COUNT = 30;

    function run() external {
        address partsAddr = vm.envAddress("PARTS_ADDRESS");
        DIDParts parts = DIDParts(partsAddr);
        address to = vm.envOr("SEED_TO", msg.sender);

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        for (uint8 slot = 0; slot < 4; slot++) {
            uint256 base = (uint256(slot) + 1) * 1000;
            uint256[] memory ids = new uint256[](COUNT);
            uint256[] memory amounts = new uint256[](COUNT);
            for (uint256 i = 0; i < COUNT; i++) {
                ids[i] = base + 1 + i;
                amounts[i] = i < 12 ? 200 : i < 21 ? 50 : i < 27 ? 20 : 5;
            }
            parts.mintPartBatch(to, ids, amounts);
            console2.log("slot", slot, "minted 2985 to", to);
        }

        vm.stopBroadcast();
    }
}
