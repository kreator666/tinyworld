// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC8004Identity
/// @notice ERC-8004（Trustless Agents）Identity Registry 对齐接口。
/// agentURI 语义 = 本项目的 profileURI（指向注册文件 JSON）。
/// agentWallet 是保留 metadataKey，只能通过带签名的 setAgentWallet 设置。
interface IERC8004Identity {
    /// @notice 读取 agent 元数据（spec: getMetadata）
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);

    /// @notice 设置 agent 元数据；key 为 "agentWallet" 时拒绝（spec 保留键）
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;

    /// @notice 当前 agent 钱包地址（0 = 未设置）
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @notice newWallet 用 EIP-712 签名（EOA 走 ecrecover，合约钱包走 ERC-1271，OZ SignatureChecker 统一校验）
    /// 证明对 newWallet 的控制权后设置 agent 钱包
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;

    /// @notice 清除 agent 钱包设置
    function unsetAgentWallet(uint256 agentId) external;

    /// @notice 更新 agentURI（= profileURI），仅 token owner
    function setProfileURI(uint256 agentId, string calldata newURI) external;

    /// @notice ERC-8004：注册事件（本项目中 mint 即注册）
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    /// @notice ERC-8004：agentURI 更新事件
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    /// @notice ERC-8004：元数据设置事件（indexedMetadataKey 为 keccak256 索引形态）
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
}
