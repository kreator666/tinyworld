// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IArenaSeason} from "./IArenaSeason.sol";

/// @title IArenaSeason
/// @notice ArenaAccount 对赛季合约的最小只读视图(避免与 ArenaSeason 双向依赖)。
interface IArenaSeason {
    /// @notice 本赛季是否允许开新交易(开始时间已到且未被管理员熔断)。
    function isTradingOpen() external view returns (bool);

    /// @notice 目标合约+方法选择器是否在赛季白名单内(资金出口约束的唯一链上裁决)。
    function isAllowedCall(address target, bytes4 selector) external view returns (bool);
}
