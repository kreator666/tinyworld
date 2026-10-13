// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDParts} from "../src/DIDParts.sol";

/// @notice registerPartBatch：成功 / 等长不符 / 重复注册回滚 / 空数组
contract DIDPartsBatchTest is BaseTest {
    function test_registerPartBatch_success() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1003;
        ids[1] = 2002;
        ids[2] = 3002;
        uint8[] memory slots = new uint8[](3);
        slots[0] = 0;
        slots[1] = 1;
        slots[2] = 2;
        uint8[] memory rarities = new uint8[](3);
        rarities[0] = 0;
        rarities[1] = 1;
        rarities[2] = 2;
        uint96[] memory maxSupplies = new uint96[](3);
        maxSupplies[0] = 10000;
        maxSupplies[1] = 2000;
        maxSupplies[2] = 500;

        parts.registerPartBatch(ids, slots, rarities, maxSupplies);

        assertEq(parts.slotOf(1003), 0);
        assertEq(parts.rarityOf(2002), 1);
        (,, uint96 maxSupply,, bool registered) = parts.parts(3002);
        assertTrue(registered);
        assertEq(maxSupply, 500);
        // 批量注册后可铸
        parts.mintPart(alice, 1003, 1);
        assertEq(parts.balanceOf(alice, 1003), 1);
    }

    function test_registerPartBatch_lengthMismatch_reverts() public {
        uint256[] memory ids = new uint256[](2);
        uint8[] memory slots = new uint8[](1);
        uint8[] memory rarities = new uint8[](2);
        uint96[] memory maxSupplies = new uint96[](2);
        vm.expectRevert(DIDParts.ArrayLengthMismatch.selector);
        parts.registerPartBatch(ids, slots, rarities, maxSupplies);
    }

    function test_registerPartBatch_duplicate_reverts() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1001; // setUp 已注册
        ids[1] = 1003;
        uint8[] memory slots = new uint8[](2);
        slots[0] = 0;
        slots[1] = 0;
        uint8[] memory rarities = new uint8[](2);
        uint96[] memory maxSupplies = new uint96[](2);
        maxSupplies[0] = 10;
        maxSupplies[1] = 10;
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartAlreadyRegistered.selector, 1001));
        parts.registerPartBatch(ids, slots, rarities, maxSupplies);
        // 原子性：1003 也不应注册成功
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartNotRegistered.selector, 1003));
        parts.slotOf(1003);
    }

    function test_registerPartBatch_zeroSupply_reverts() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1003;
        uint8[] memory slots = new uint8[](1);
        uint8[] memory rarities = new uint8[](1);
        uint96[] memory maxSupplies = new uint96[](1);
        vm.expectRevert(DIDParts.InvalidMaxSupply.selector);
        parts.registerPartBatch(ids, slots, rarities, maxSupplies);
    }

    function test_registerPartBatch_nonOwner_reverts() public {
        uint256[] memory ids = new uint256[](1);
        uint8[] memory slots = new uint8[](1);
        uint8[] memory rarities = new uint8[](1);
        uint96[] memory maxSupplies = new uint96[](1);
        maxSupplies[0] = 10;
        vm.prank(alice);
        vm.expectRevert();
        parts.registerPartBatch(ids, slots, rarities, maxSupplies);
    }
}
