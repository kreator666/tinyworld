// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAgentModule
/// @notice 预留：未来 AI Agent 模块（人格、声誉、代聊托管等）的标准接口。
/// 模块合约经 DIDIdentity.registerModule 注册后接入，核心合约无需改动。
/// 模块可通过 DIDIdentity.agentPermissions(tokenId, agent) 读取授权状态，
/// 通过 getEquipped / personaOf 读取身份数据。
interface IAgentModule {
    /// @notice 模块唯一标识，与注册表 key 一致（如 keccak256("persona")）
    function moduleId() external view returns (bytes32);

    /// @notice 注册成功后的回调钩子（由模块注册方或集成方调用，可选实现空函数）
    function onRegister(address identity) external;
}
