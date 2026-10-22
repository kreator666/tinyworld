// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// 让 Hardhat 把 OpenZeppelin npm 依赖的代理合约纳入编译(hardhat 不直接编译 node_modules 合约,
// foundry 走 lib/ 无此问题;UUPS 链上部署用 DeployUUPS.s.sol,测试与脚本走这里)。
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract OzProxyImports {
    // 占位:仅为触发编译依赖
}
