// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title IDIDIdentity
/// @notice DID 主身份 NFT 对外接口（前端 / 市场 / 未来 AI 模块均面向此接口编程）
interface IDIDIdentity is IERC721 {
    /// @notice 某插槽当前装备的配件；collection 为 0 地址表示空插槽
    struct EquippedItem {
        address collection;
        uint256 id;
    }

    /// @notice 人格配置（AI 分身）链上指针：内容存链下（IPFS/后端），链上存 URI + 完整性哈希
    struct Persona {
        string uri;
        bytes32 contentHash;
    }

    // ---- AI Agent 权限位 ----
    function PERMISSION_PERSONA() external view returns (uint256);

    function PERMISSION_SOCIAL() external view returns (uint256);

    // ---- 身份铸造 ----
    function mint(string calldata name, string calldata profileURI) external returns (uint256 tokenId);

    function tokenIdOf(address owner) external view returns (uint256);

    function nameOf(uint256 tokenId) external view returns (string memory);

    function totalMinted() external view returns (uint256);

    // ---- Soulbound（ERC-5192，默认锁定 + 治理解锁）----
    function locked(uint256 tokenId) external view returns (bool);

    function unlock(uint256 tokenId) external;

    function lock(uint256 tokenId) external;

    function burn(uint256 tokenId) external;

    // ---- 4 插槽装备 ----
    function equip(uint256 tokenId, uint8 slot, address collection, uint256 id) external;

    function unequip(uint256 tokenId, uint8 slot) external;

    function getEquipped(uint256 tokenId) external view returns (EquippedItem[4] memory items);

    function setCollectionApproved(address collection, bool approved) external;

    function approvedCollections(address collection) external view returns (bool);

    // ---- AI Agent 扩展点 ----
    function setAgent(uint256 tokenId, address agent, uint256 permissionMask) external;

    function revokeAgent(uint256 tokenId, address agent) external;

    function agentPermissions(uint256 tokenId, address agent) external view returns (uint256);

    function setPersona(uint256 tokenId, string calldata uri, bytes32 contentHash) external;

    function personaOf(uint256 tokenId) external view returns (Persona memory);

    // ---- 模块注册表（未来 AI 模块接入点）----
    function registerModule(bytes32 moduleId, address impl) external;

    function getModule(bytes32 moduleId) external view returns (address);

    // ---- 元数据 ----
    function setBaseURI(string calldata newBaseURI) external;

    function contractURI() external view returns (string memory);

    function setContractURI(string calldata newContractURI) external;
}
