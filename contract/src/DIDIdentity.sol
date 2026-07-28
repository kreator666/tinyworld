// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IDIDIdentity} from "./interfaces/IDIDIdentity.sol";
import {IDIDParts} from "./interfaces/IDIDParts.sol";
import {IERC5192} from "./interfaces/IERC5192.sol";
import {IERC4906} from "./interfaces/IERC4906.sol";
import {Slots} from "./libraries/Slots.sol";

/// @title DIDIdentity
/// @notice DID 主身份 NFT（ERC-721 + ERC-5192 Soulbound）：
/// - 每地址限铸 1 枚，链上名称唯一且永久保留
/// - 默认 Soulbound 锁定，治理可解锁（账号迁移/申诉场景），本人可 burn
/// - 4 个纸娃娃插槽（头/身/配饰/宠物），装备即配件 ERC-1155 转入本合约托管；
///   换装自动退回旧件，一笔交易完成；转账/销毁前必须清空插槽
/// - AI Agent 扩展点：操作员授权（权限位）、人格配置链上指针（URI + 内容哈希）、模块注册表；
///   未来 AI 模块以独立合约经注册表接入，核心合约零改动（ERC-6551 TBA 对 ERC-721 天然可用）
contract DIDIdentity is ERC721, Ownable, ReentrancyGuard, IERC1155Receiver, IERC4906, IDIDIdentity, IERC5192 {
    /// @dev AI 操作员权限位：更新人格配置
    uint256 public constant PERMISSION_PERSONA = 1 << 0;
    /// @dev AI 操作员权限位：社交行为（预留给未来模块使用）
    uint256 public constant PERMISSION_SOCIAL = 1 << 1;

    uint256 private constant MAX_NAME_LENGTH = 64;

    uint256 private _nextTokenId; // 从 1 开始，0 保留为“无”
    string private _baseTokenURI;
    string private _contractURI;

    /// @dev 地址 => DID tokenId（0 = 未铸造）
    mapping(address => uint256) public tokenIdOf;
    /// @dev 名称（小写规范化后哈希）=> 是否已被占用；burn 后仍保留，防冒名
    mapping(bytes32 => bool) private _nameTaken;
    mapping(uint256 => string) private _names;
    mapping(uint256 => string) private _profileURIs;
    /// @dev 治理解锁标记（默认锁定）
    mapping(uint256 => bool) private _unlocked;

    /// @dev 配件合约白名单
    mapping(address => bool) public approvedCollections;
    /// @dev tokenId => slot => 装备中的配件
    mapping(uint256 => mapping(uint8 => EquippedItem)) private _equipped;

    /// @dev tokenId => agent => 权限位
    mapping(uint256 => mapping(address => uint256)) public agentPermissions;
    mapping(uint256 => Persona) private _personas;

    /// @dev 模块注册表（未来 AI 模块接入点）
    mapping(bytes32 => address) public getModule;

    // ------------------------------------------------------------------
    // 错误
    // ------------------------------------------------------------------

    error AlreadyHasDID(address account);
    error InvalidName();
    error NameTaken(string name);
    error TokenLocked(uint256 tokenId);
    error SlotsNotEmpty(uint256 tokenId);
    error NotTokenOwner(address caller);
    error CollectionNotApproved(address collection);
    error SlotMismatch(uint8 expected, uint8 actual);
    error NothingEquipped(uint256 tokenId, uint8 slot);
    error NotAuthorized(address caller);
    error InvalidAgent();
    error InvalidModuleId();

    // ------------------------------------------------------------------
    // 事件（Locked/Unlocked、MetadataUpdate 来自 EIP-5192/4906 接口）
    // ------------------------------------------------------------------

    event Minted(address indexed owner, uint256 indexed tokenId, string name);
    event Equipped(uint256 indexed tokenId, uint8 slot, address indexed collection, uint256 id);
    event Unequipped(uint256 indexed tokenId, uint8 slot, address indexed collection, uint256 id);
    event CollectionApproved(address indexed collection, bool approved);
    event AgentUpdated(uint256 indexed tokenId, address indexed agent, uint256 permissionMask);
    event PersonaUpdated(uint256 indexed tokenId, string uri, bytes32 contentHash);
    event ModuleRegistered(bytes32 indexed moduleId, address indexed impl);

    constructor(string memory name_, string memory symbol_, string memory baseTokenURI_, string memory contractURI_)
        ERC721(name_, symbol_)
        Ownable(msg.sender)
    {
        _baseTokenURI = baseTokenURI_;
        _contractURI = contractURI_;
    }

    // ==================================================================
    // 身份铸造
    // ==================================================================

    /// @notice 铸造 DID 主身份 NFT；每地址限 1 枚，名称唯一（大小写不敏感）且永久保留
    function mint(string calldata name, string calldata profileURI) external returns (uint256 tokenId) {
        if (tokenIdOf[msg.sender] != 0) revert AlreadyHasDID(msg.sender);

        bytes memory nameBytes = bytes(name);
        if (nameBytes.length == 0 || nameBytes.length > MAX_NAME_LENGTH) revert InvalidName();
        bytes32 nameHash = keccak256(_toLower(nameBytes));
        if (_nameTaken[nameHash]) revert NameTaken(name);

        tokenId = ++_nextTokenId;
        _nameTaken[nameHash] = true;
        _names[tokenId] = name;
        _profileURIs[tokenId] = profileURI;
        tokenIdOf[msg.sender] = tokenId;

        _safeMint(msg.sender, tokenId);
        emit Locked(tokenId); // EIP-5192：铸造即为锁定态
        emit Minted(msg.sender, tokenId, name);
    }

    /// @notice 名称是否可用（前端预校验）
    function nameAvailable(string calldata name) external view returns (bool) {
        bytes memory nameBytes = bytes(name);
        if (nameBytes.length == 0 || nameBytes.length > MAX_NAME_LENGTH) return false;
        return !_nameTaken[keccak256(_toLower(nameBytes))];
    }

    function nameOf(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return _names[tokenId];
    }

    function profileURIOf(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return _profileURIs[tokenId];
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    // ==================================================================
    // Soulbound（ERC-5192）：默认锁定 + 治理解锁
    // ==================================================================

    function locked(uint256 tokenId) external view override(IDIDIdentity, IERC5192) returns (bool) {
        _requireOwned(tokenId);
        return !_unlocked[tokenId];
    }

    /// @notice 治理解锁（账号迁移/申诉等场景），仅 owner（部署后转多签）
    function unlock(uint256 tokenId) external onlyOwner {
        _requireOwned(tokenId);
        _unlocked[tokenId] = true;
        emit Unlocked(tokenId);
    }

    /// @notice 治理重新锁定
    function lock(uint256 tokenId) external onlyOwner {
        _requireOwned(tokenId);
        _unlocked[tokenId] = false;
        emit Locked(tokenId);
    }

    /// @notice 销毁身份；需插槽全空。名称永久保留不复用，防冒名
    function burn(uint256 tokenId) external {
        if (msg.sender != _requireOwned(tokenId)) revert NotTokenOwner(msg.sender);
        _burn(tokenId); // 插槽清空校验与 tokenIdOf 清理在 _update 中完成
    }

    // ==================================================================
    // 4 插槽装备（custodial nesting）
    // ==================================================================

    /// @notice 装备配件到指定插槽；配件转入本合约托管。
    /// 插槽已占用时自动把旧件退回 DID 持有者（一笔交易完成换装）。
    /// 前置：持有者在配件合约上 setApprovalForAll(address(this), true)
    function equip(uint256 tokenId, uint8 slot, address collection, uint256 id) external nonReentrant {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner) revert NotTokenOwner(msg.sender);
        Slots.check(slot);
        if (!approvedCollections[collection]) revert CollectionNotApproved(collection);
        uint8 actual = IDIDParts(collection).slotOf(id); // 未注册的配件 id 会在此 revert
        if (actual != slot) revert SlotMismatch(slot, actual);

        EquippedItem memory old = _equipped[tokenId][slot];
        // effects：先写入新状态，再做外部调用（nonReentrant 兜底）
        _equipped[tokenId][slot] = EquippedItem({collection: collection, id: id});

        // interactions：先退旧件，再拉新件；任一步失败整体回滚，保证原子性
        if (old.collection != address(0)) {
            IERC1155(old.collection).safeTransferFrom(address(this), owner, old.id, 1, "");
            emit Unequipped(tokenId, slot, old.collection, old.id);
        }
        IERC1155(collection).safeTransferFrom(owner, address(this), id, 1, "");

        emit Equipped(tokenId, slot, collection, id);
        emit MetadataUpdate(tokenId); // EIP-4906：通知市场刷新纸娃娃外观
    }

    /// @notice 卸下指定插槽配件，退回 DID 持有者
    function unequip(uint256 tokenId, uint8 slot) external nonReentrant {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner) revert NotTokenOwner(msg.sender);
        Slots.check(slot);

        EquippedItem memory old = _equipped[tokenId][slot];
        if (old.collection == address(0)) revert NothingEquipped(tokenId, slot);

        delete _equipped[tokenId][slot];
        IERC1155(old.collection).safeTransferFrom(address(this), owner, old.id, 1, "");

        emit Unequipped(tokenId, slot, old.collection, old.id);
        emit MetadataUpdate(tokenId);
    }

    /// @notice 一次读取 4 个插槽（前端纸娃娃渲染 / 市场展示）
    function getEquipped(uint256 tokenId) external view returns (EquippedItem[4] memory items) {
        _requireOwned(tokenId);
        for (uint8 slot = 0; slot < Slots.COUNT; ++slot) {
            items[slot] = _equipped[tokenId][slot];
        }
    }

    function setCollectionApproved(address collection, bool approved) external onlyOwner {
        approvedCollections[collection] = approved;
        emit CollectionApproved(collection, approved);
    }

    /// @dev 只接受白名单配件合约的 1155 转入（防垃圾 token 打入卡死）
    function onERC1155Received(address, address, uint256, uint256, bytes memory) external view returns (bytes4) {
        if (!approvedCollections[msg.sender]) revert CollectionNotApproved(msg.sender);
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory)
        external
        view
        returns (bytes4)
    {
        if (!approvedCollections[msg.sender]) revert CollectionNotApproved(msg.sender);
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    // ==================================================================
    // AI Agent 扩展点
    // ==================================================================

    /// @notice 授权 AI 操作员（权限位组合：PERMISSION_PERSONA | PERMISSION_SOCIAL）
    function setAgent(uint256 tokenId, address agent, uint256 permissionMask) external {
        if (msg.sender != _requireOwned(tokenId)) revert NotTokenOwner(msg.sender);
        if (agent == address(0) || permissionMask == 0) revert InvalidAgent();
        agentPermissions[tokenId][agent] = permissionMask;
        emit AgentUpdated(tokenId, agent, permissionMask);
    }

    function revokeAgent(uint256 tokenId, address agent) external {
        if (msg.sender != _requireOwned(tokenId)) revert NotTokenOwner(msg.sender);
        delete agentPermissions[tokenId][agent];
        emit AgentUpdated(tokenId, agent, 0);
    }

    /// @notice 设置人格配置链上指针；DID 持有者或被授权（PERMISSION_PERSONA）的 agent 可调用。
    /// 人格 JSON 存链下（IPFS/后端），链上仅存 URI + keccak256 内容哈希保证完整性。
    function setPersona(uint256 tokenId, string calldata uri, bytes32 contentHash) external {
        address owner = _requireOwned(tokenId);
        if (msg.sender != owner && agentPermissions[tokenId][msg.sender] & PERMISSION_PERSONA == 0) {
            revert NotAuthorized(msg.sender);
        }
        _personas[tokenId] = Persona({uri: uri, contentHash: contentHash});
        emit PersonaUpdated(tokenId, uri, contentHash);
        emit MetadataUpdate(tokenId);
    }

    function personaOf(uint256 tokenId) external view returns (Persona memory) {
        _requireOwned(tokenId);
        return _personas[tokenId];
    }

    // ==================================================================
    // 模块注册表（未来 AI 模块接入点）
    // ==================================================================

    /// @notice 注册/更新/移除（impl = 0 地址）模块，仅 owner
    function registerModule(bytes32 moduleId, address impl) external onlyOwner {
        if (moduleId == bytes32(0)) revert InvalidModuleId();
        getModule[moduleId] = impl;
        emit ModuleRegistered(moduleId, impl);
    }

    // ==================================================================
    // 元数据
    // ==================================================================

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
    }

    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function setContractURI(string calldata newContractURI) external onlyOwner {
        _contractURI = newContractURI;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // ==================================================================
    // 转账钩子：Soulbound 锁定 + 插槽清空校验 + 每地址一枚
    // ==================================================================

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);

        if (from != address(0)) {
            // 转账与销毁共通：插槽必须全空，否则托管配件永久卡死
            if (_hasEquipment(tokenId)) revert SlotsNotEmpty(tokenId);
            if (to != address(0)) {
                // 转让：需治理已解锁，且接收方没有 DID
                if (!_unlocked[tokenId]) revert TokenLocked(tokenId);
                if (tokenIdOf[to] != 0) revert AlreadyHasDID(to);
                tokenIdOf[to] = tokenId;
            }
            delete tokenIdOf[from];
        }

        return super._update(to, tokenId, auth);
    }

    function _hasEquipment(uint256 tokenId) internal view returns (bool) {
        for (uint8 slot = 0; slot < Slots.COUNT; ++slot) {
            if (_equipped[tokenId][slot].collection != address(0)) return true;
        }
        return false;
    }

    function _toLower(bytes memory b) internal pure returns (bytes memory) {
        for (uint256 i = 0; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 65 && c <= 90) b[i] = bytes1(c + 32);
        }
        return b;
    }

    // ==================================================================
    // ERC-165
    // ==================================================================

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC5192).interfaceId // 0xb45a3c0e
            || interfaceId == type(IERC4906).interfaceId // 0x49064906
            || interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
