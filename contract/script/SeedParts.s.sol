// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DIDParts} from "../src/DIDParts.sol";
import {Slots} from "../src/libraries/Slots.sol";

/// @notice 注册演示配件（对应 prototype/role.md 的示例素材），并给指定地址发一套用于联调
/// 环境变量：
///   PARTS_ADDRESS   已部署的 DIDParts 地址（必填）
///   SEED_TO         接收演示配件的地址（缺省 = 部署者）
contract SeedParts is Script {
    // 与 role.md assetMap 对应的演示配件 id 规划
    uint256 internal constant HEAD_01 = 1001; // head_01
    uint256 internal constant HEAD_02 = 1002; // head_02
    uint256 internal constant BODY_01 = 2001; // body_01
    uint256 internal constant ACC_RIBBON = 3001; // acc_ribbon
    uint256 internal constant PET_CAT = 4001; // pet_cat

    function run() external {
        address partsAddr = vm.envAddress("PARTS_ADDRESS");
        DIDParts parts = DIDParts(partsAddr);

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }

        parts.registerPart(HEAD_01, Slots.HEAD, 0, 10000); // 普通
        parts.registerPart(HEAD_02, Slots.HEAD, 1, 1000); // 稀有
        parts.registerPart(BODY_01, Slots.BODY, 0, 10000);
        parts.registerPart(ACC_RIBBON, Slots.ACCESSORY, 2, 500); // 史诗
        parts.registerPart(PET_CAT, Slots.PET, 3, 100); // 传说

        address seedTo = vm.envOr("SEED_TO", msg.sender);
        uint256[] memory ids = new uint256[](5);
        ids[0] = HEAD_01;
        ids[1] = HEAD_02;
        ids[2] = BODY_01;
        ids[3] = ACC_RIBBON;
        ids[4] = PET_CAT;
        uint256[] memory amounts = new uint256[](5);
        for (uint256 i = 0; i < amounts.length; ++i) {
            amounts[i] = 1;
        }
        parts.mintPartBatch(seedTo, ids, amounts);

        vm.stopBroadcast();

        console2.log("Seeded 5 demo parts to:", seedTo);
    }
}
