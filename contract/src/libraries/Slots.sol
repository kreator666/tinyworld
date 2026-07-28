// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Slots
/// @notice 纸娃娃 4 个装备插槽的常量与校验：头部 / 身体 / 配饰 / 宠物
library Slots {
    uint8 internal constant HEAD = 0;
    uint8 internal constant BODY = 1;
    uint8 internal constant ACCESSORY = 2;
    uint8 internal constant PET = 3;
    uint8 internal constant COUNT = 4;

    error InvalidSlot(uint8 slot);

    function check(uint8 slot) internal pure {
        if (slot >= COUNT) revert InvalidSlot(slot);
    }

    function isValid(uint8 slot) internal pure returns (bool) {
        return slot < COUNT;
    }
}
