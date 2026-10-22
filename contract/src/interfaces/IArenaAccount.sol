// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IArenaAccount} from "./IArenaAccount.sol";

/// @title IArenaAccount
/// @notice ArenaSeason 对 per-agent 账户的最小调用视图(避免与 ArenaAccount 双向依赖)。
interface IArenaAccount {
    enum Phase {
        Active,
        Frozen,
        Settled
    }

    function phase() external view returns (Phase);

    function initialize(address owner_, address executor_, address season_) external;

    function settle(uint256 navUsd) external;
}
