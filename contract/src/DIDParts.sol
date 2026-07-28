// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDIDParts} from "./interfaces/IDIDParts.sol";
import {Slots} from "./libraries/Slots.sol";

/// @title DIDParts
/// @notice 纸娃娃配件 NFT（ERC-1155）：头部 / 身体 / 配饰 / 宠物。
/// 同款配件可多份持有与交易；每个配件注册时绑定插槽、稀有度与最大供应量。
contract DIDParts is ERC1155, ERC1155Supply, Ownable, IDIDParts {
    /// @notice 稀有度：0 普通 / 1 稀有 / 2 史诗 / 3 传说（展示语义，链上不做额外约束）
    struct PartInfo {
        uint8 slot;
        uint8 rarity;
        uint96 maxSupply; // 必须 > 0，mint 时强约束
        bool mintable; // 关闭后不可再铸（绝版）
        bool registered;
    }

    mapping(uint256 id => PartInfo) public parts;

    /// @notice 除 owner 外被授权的铸造方（如未来的配件售卖合约）
    mapping(address account => bool) public minters;

    error PartNotRegistered(uint256 id);
    error PartAlreadyRegistered(uint256 id);
    error PartNotMintable(uint256 id);
    error MaxSupplyExceeded(uint256 id, uint96 maxSupply);
    error NotMinter(address account);
    error InvalidMaxSupply();

    event PartRegistered(uint256 indexed id, uint8 slot, uint8 rarity, uint96 maxSupply);
    event PartMintableUpdated(uint256 indexed id, bool mintable);
    event MinterUpdated(address indexed account, bool allowed);

    modifier onlyMinter() {
        if (msg.sender != owner() && !minters[msg.sender]) revert NotMinter(msg.sender);
        _;
    }

    constructor(string memory baseURI) ERC1155(baseURI) Ownable(msg.sender) {}

    // ------------------------------------------------------------------
    // 管理
    // ------------------------------------------------------------------

    /// @notice 注册新配件（id 由发行方规划，如 head_01 = 1001）
    function registerPart(uint256 id, uint8 slot, uint8 rarity, uint96 maxSupply) external onlyOwner {
        Slots.check(slot);
        if (parts[id].registered) revert PartAlreadyRegistered(id);
        if (maxSupply == 0) revert InvalidMaxSupply();
        parts[id] = PartInfo({slot: slot, rarity: rarity, maxSupply: maxSupply, mintable: true, registered: true});
        emit PartRegistered(id, slot, rarity, maxSupply);
    }

    function setPartMintable(uint256 id, bool mintable) external onlyOwner {
        if (!parts[id].registered) revert PartNotRegistered(id);
        parts[id].mintable = mintable;
        emit PartMintableUpdated(id, mintable);
    }

    function setMinter(address account, bool allowed) external onlyOwner {
        minters[account] = allowed;
        emit MinterUpdated(account, allowed);
    }

    function setURI(string calldata newURI) external onlyOwner {
        _setURI(newURI);
    }

    // ------------------------------------------------------------------
    // 铸造
    // ------------------------------------------------------------------

    function mintPart(address to, uint256 id, uint256 amount) external onlyMinter {
        PartInfo storage info = parts[id];
        if (!info.registered) revert PartNotRegistered(id);
        if (!info.mintable) revert PartNotMintable(id);
        _mint(to, id, amount, "");
        if (totalSupply(id) > info.maxSupply) revert MaxSupplyExceeded(id, info.maxSupply);
    }

    function mintPartBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external onlyMinter {
        for (uint256 i = 0; i < ids.length; ++i) {
            PartInfo storage info = parts[ids[i]];
            if (!info.registered) revert PartNotRegistered(ids[i]);
            if (!info.mintable) revert PartNotMintable(ids[i]);
        }
        _mintBatch(to, ids, amounts, "");
        for (uint256 i = 0; i < ids.length; ++i) {
            if (totalSupply(ids[i]) > parts[ids[i]].maxSupply) {
                revert MaxSupplyExceeded(ids[i], parts[ids[i]].maxSupply);
            }
        }
    }

    // ------------------------------------------------------------------
    // 只读（IDIDParts）
    // ------------------------------------------------------------------

    function slotOf(uint256 id) external view returns (uint8) {
        PartInfo storage info = parts[id];
        if (!info.registered) revert PartNotRegistered(id);
        return info.slot;
    }

    function rarityOf(uint256 id) external view returns (uint8) {
        PartInfo storage info = parts[id];
        if (!info.registered) revert PartNotRegistered(id);
        return info.rarity;
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Supply)
    {
        super._update(from, to, ids, values);
    }
}
