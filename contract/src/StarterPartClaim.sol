// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDIDParts} from "./interfaces/IDIDParts.sol";
import {IDIDIdentity} from "./interfaces/IDIDIdentity.sol";

/// @title StarterPartClaim
/// @notice 新手大礼包 v2:新用户一次交易随机领取 4 件套(头/身/配饰/宠物 各 1 件)并自动穿戴。
/// - 用户必须已铸造 DID 主身份,且每个地址限领一次
/// - 随机池 = 每个槽位的前 8 件装备(头 1001-1008 / 身 2001-2008 / 配饰 3001-3008 / 宠物 4001-4008)
/// - 由 owner 授予 DIDParts minter 权限后代铸;用户自签、自付 gas
/// - 自动穿戴:identity 经 getApproved 授权本合约后,低层 call equipBatch 尝试一键穿上;
///   未授权/未批准托管时穿戴失败不 revert(装备已在用户钱包,前端引导手动穿)
/// - 本合约无 owner、无升级、无其他写函数,即使被滥用也只会铸造池内 32 个 id,
///   且受 DIDParts 的 maxSupply 硬顶约束
contract StarterPartClaim {
    IDIDParts public immutable parts;
    IDIDIdentity public immutable identity;

    /// @notice 每槽随机池大小:起始 id 起连续 RANGE 件
    uint256 private constant RANGE = 8;

    mapping(address account => bool) public claimed;

    error AlreadyClaimed(address account);
    error NoIdentity(address account);

    event StarterPackClaimed(address indexed account, uint256[4] partIds, bool dressed);

    constructor(address parts_, address identity_) {
        parts = IDIDParts(parts_);
        identity = IDIDIdentity(identity_);
    }

    /// @notice 领取新手大礼包:随机 4 件套铸到用户钱包,并尝试自动穿到 DID 上
    function claimPack() external {
        if (claimed[msg.sender]) revert AlreadyClaimed(msg.sender);
        uint256 tokenId = identity.tokenIdOf(msg.sender);
        if (tokenId == 0) revert NoIdentity(msg.sender);
        claimed[msg.sender] = true;

        // 逐槽随机:上一区块哈希 + 领取人 + 槽位序号作种子(链上随机,防同块内被预测抢先)
        uint256[4] memory ids;
        for (uint256 i = 0; i < 4; ++i) {
            uint256 r = uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), msg.sender, i))) % RANGE;
            ids[i] = _slotBases()[i] + r;
            parts.mintPart(msg.sender, ids[i], 1);
        }

        // 自动穿戴:identity 对本合约的授权经 approve(claim, tokenId) 或 setApprovalForAll 生效;
        // 用户在 DIDParts 上批准 identity 托管(setApprovalForAll)也是前提。任一不满足则穿戴失败,
        // 不 revert——装备已 mint 到用户钱包,由前端引导手动穿戴
        bool dressed = false;
        uint8[] memory slots = new uint8[](4);
        address[] memory collections = new address[](4);
        uint256[] memory batchIds = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            slots[i] = uint8(i);
            collections[i] = address(parts);
            batchIds[i] = ids[i];
        }
        (bool ok,) = address(identity).call(
            abi.encodeCall(IDIDIdentity.equipBatch, (tokenId, slots, collections, batchIds))
        );
        if (ok) dressed = true;

        emit StarterPackClaimed(msg.sender, ids, dressed);
    }

    /// @notice 每个槽位随机池的起始 id(头/身/配饰/宠物);定长数组不能作常量,用 pure 函数
    function _slotBases() internal pure returns (uint256[4] memory) {
        return [uint256(1001), uint256(2001), uint256(3001), uint256(4001)];
    }
}
