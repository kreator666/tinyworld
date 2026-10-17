// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PartsMarket} from "../src/PartsMarket.sol";

/// @notice 给 PartsMarket 批量上架普通装 48 件（每槽 1001-1012），单价 0.01 原生币
/// 环境变量：
///   MARKET_ADDRESS  PartsMarket 代理地址（必填）
///   PRICE_WEI       单价 wei（缺省 0.01 AVAX/ETH = 1e16）
contract SetMarketPrices is Script {
    function run() external {
        address marketAddr = vm.envAddress("MARKET_ADDRESS");
        uint256 price = vm.envOr("PRICE_WEI", uint256(0.01 ether));
        PartsMarket market = PartsMarket(marketAddr);

        uint256[] memory ids = new uint256[](48);
        uint256[] memory prices = new uint256[](48);
        uint256 idx;
        for (uint8 slot = 0; slot < 4; ++slot) {
            uint256 base = (uint256(slot) + 1) * 1000;
            for (uint256 i = 0; i < 12; ++i) {
                ids[idx] = base + 1 + i;
                prices[idx] = price;
                ++idx;
            }
        }

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        market.setPrices(ids, prices);

        vm.stopBroadcast();

        console2.log("Listed parts count:", ids.length);
        console2.log("Price wei:", price);
    }
}
