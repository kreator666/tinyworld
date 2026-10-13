// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DIDParts} from "../src/DIDParts.sol";

/// @notice 用 registerPartBatch 全量注册 120 件装备（head 1001-1030 / body 2001-2030 / acc 3001-3030 / pet 4001-4030），
/// 稀有度分布按 knowledge/contract-design-and-workflow.md §5：普通x12(max10000) 稀有x9(max2000) 史诗x6(max500) 传说x3(max100)，
/// 并给指定测试账户各发一套演示装备
/// 环境变量：
///   PARTS_ADDRESS   已部署的 DIDParts 地址（必填）
///   SEED_TO         接收演示配件的地址（缺省 = 部署者）
contract RegisterAllParts is Script {
    uint256 internal constant COUNT = 30; // 每个插槽 30 件

    function run() external {
        address partsAddr = vm.envAddress("PARTS_ADDRESS");
        DIDParts parts = DIDParts(partsAddr);

        // 每类 4 个稀有度段：数量 / maxSupply
        uint8[4] memory counts = [12, 9, 6, 3];
        uint96[4] memory supplies = [uint96(10000), 2000, 500, 100];

        uint256 n = COUNT * 4;
        uint256[] memory ids = new uint256[](n);
        uint8[] memory slots = new uint8[](n);
        uint8[] memory rarities = new uint8[](n);
        uint96[] memory maxSupplies = new uint96[](n);

        // 每个插槽 30 件：前 12 普通 / 接着 9 稀有 / 接着 6 史诗 / 最后 3 传说
        uint256 idx;
        for (uint8 slot = 0; slot < 4; ++slot) {
            uint256 base = (uint256(slot) + 1) * 1000; // 1xxx/2xxx/3xxx/4xxx
            uint8 r;
            for (uint256 i = 0; i < COUNT; ++i) {
                if (i < 12) r = 0;
                else if (i < 21) r = 1;
                else if (i < 27) r = 2;
                else r = 3;
                ids[idx] = base + 1 + i;
                slots[idx] = slot;
                rarities[idx] = r;
                maxSupplies[idx] = supplies[r];
                ++idx;
            }
        }

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }

        parts.registerPartBatch(ids, slots, rarities, maxSupplies);

        // 给测试账户发一套演示装备（每槽 1 件：各槽 1 号）
        address seedTo = vm.envOr("SEED_TO", msg.sender);
        uint256[] memory demoIds = new uint256[](4);
        demoIds[0] = 1001;
        demoIds[1] = 2001;
        demoIds[2] = 3001;
        demoIds[3] = 4001;
        uint256[] memory amounts = new uint256[](4);
        amounts[0] = 1;
        amounts[1] = 1;
        amounts[2] = 1;
        amounts[3] = 1;
        parts.mintPartBatch(seedTo, demoIds, amounts);

        vm.stopBroadcast();

        console2.log("Registered parts:", n);
        console2.log("Seeded demo set to:", seedTo);
    }
}
