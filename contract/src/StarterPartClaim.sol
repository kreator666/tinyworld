// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDIDParts} from "./interfaces/IDIDParts.sol";
import {IDIDIdentity} from "./interfaces/IDIDIdentity.sol";

/// @title StarterPartClaim
/// @notice 新手装备免费领养(A 方案 v2):
/// - 用户必须已铸造 DID 主身份,且每个地址限领一次
/// - 只能从固定「新手池」4 个装备 id 中选一件,由 owner 授予 DIDParts minter 权限后代铸
/// - 用户自签、自付 gas;本合约无 owner、无升级、无其他写函数,
///   即使被滥用也只会铸造池内 4 个 id,且受 DIDParts 的 maxSupply 硬顶约束
contract StarterPartClaim {
    IDIDParts public immutable parts;
    IDIDIdentity public immutable identity;
    // Solidity 不支持 immutable 数组,拆成 4 个标量,pool() 组装返回
    uint256 internal immutable poolId0;
    uint256 internal immutable poolId1;
    uint256 internal immutable poolId2;
    uint256 internal immutable poolId3;

    mapping(address account => bool) public claimed;

    error NotInPool(uint256 partId);
    error AlreadyClaimed(address account);
    error NoIdentity(address account);

    event Claimed(address indexed account, uint256 indexed partId);

    constructor(address parts_, address identity_, uint256[4] memory poolIds_) {
        parts = IDIDParts(parts_);
        identity = IDIDIdentity(identity_);
        poolId0 = poolIds_[0];
        poolId1 = poolIds_[1];
        poolId2 = poolIds_[2];
        poolId3 = poolIds_[3];
    }

    /// @notice 领取一件新手装备:需已持有 DID 且未领取过,partId 必须在池内
    function claim(uint256 partId) external {
        bool inPool = false;
        uint256[4] memory ids = pool();
        for (uint256 i = 0; i < 4; ++i) {
            if (ids[i] == partId) {
                inPool = true;
                break;
            }
        }
        if (!inPool) revert NotInPool(partId);
        if (claimed[msg.sender]) revert AlreadyClaimed(msg.sender);
        if (identity.tokenIdOf(msg.sender) == 0) revert NoIdentity(msg.sender);

        claimed[msg.sender] = true;
        parts.mintPart(msg.sender, partId, 1);
        emit Claimed(msg.sender, partId);
    }

    /// @notice 当前新手池的 4 个装备 id
    function pool() public view returns (uint256[4] memory) {
        return [poolId0, poolId1, poolId2, poolId3];
    }
}
