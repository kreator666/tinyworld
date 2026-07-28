// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @title IDIDParts
/// @notice 配件 NFT（ERC-1155）对外接口；DIDIdentity 装备时通过 slotOf 校验插槽匹配
interface IDIDParts is IERC1155 {
    /// @notice 配件所属插槽（见 Slots.sol）；未注册的 id 必须 revert
    function slotOf(uint256 id) external view returns (uint8);

    function rarityOf(uint256 id) external view returns (uint8);
}
