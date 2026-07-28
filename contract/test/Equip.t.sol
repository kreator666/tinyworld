// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {IDIDIdentity} from "../src/interfaces/IDIDIdentity.sol";
import {DIDParts} from "../src/DIDParts.sol";
import {IERC4906} from "../src/interfaces/IERC4906.sol";
import {Slots} from "../src/libraries/Slots.sol";

contract EquipTest is BaseTest {
    uint256 internal aliceToken;

    function setUp() public override {
        super.setUp();
        aliceToken = _mintDID(alice, "Alice");
    }

    function test_equip() public {
        _givePart(alice, HEAD_1, 1);

        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.Equipped(aliceToken, Slots.HEAD, address(parts), HEAD_1);
        vm.expectEmit(true, false, false, false, address(identity));
        emit IERC4906.MetadataUpdate(aliceToken);

        vm.prank(alice);
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);

        IDIDIdentity.EquippedItem[4] memory items = identity.getEquipped(aliceToken);
        assertEq(items[Slots.HEAD].collection, address(parts));
        assertEq(items[Slots.HEAD].id, HEAD_1);
        assertEq(items[Slots.BODY].collection, address(0));

        // 托管划转：配件从用户转入合约
        assertEq(parts.balanceOf(alice, HEAD_1), 0);
        assertEq(parts.balanceOf(address(identity), HEAD_1), 1);
    }

    function test_equip_allSlots() public {
        _givePart(alice, HEAD_1, 1);
        _givePart(alice, BODY_1, 1);
        _givePart(alice, ACC_1, 1);
        _givePart(alice, PET_1, 1);

        vm.startPrank(alice);
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);
        identity.equip(aliceToken, Slots.BODY, address(parts), BODY_1);
        identity.equip(aliceToken, Slots.ACCESSORY, address(parts), ACC_1);
        identity.equip(aliceToken, Slots.PET, address(parts), PET_1);
        vm.stopPrank();

        IDIDIdentity.EquippedItem[4] memory items = identity.getEquipped(aliceToken);
        for (uint8 slot = 0; slot < 4; ++slot) {
            assertEq(items[slot].collection, address(parts));
            assertEq(items[slot].id, _slotPart(slot));
        }
    }

    /// 换装：插槽已占用时自动退回旧件，一笔交易完成
    function test_equip_replace_returnsOld() public {
        _givePart(alice, HEAD_1, 1);
        _givePart(alice, HEAD_2, 1);

        vm.startPrank(alice);
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);

        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.Unequipped(aliceToken, Slots.HEAD, address(parts), HEAD_1);
        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.Equipped(aliceToken, Slots.HEAD, address(parts), HEAD_2);

        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_2);
        vm.stopPrank();

        IDIDIdentity.EquippedItem[4] memory items = identity.getEquipped(aliceToken);
        assertEq(items[Slots.HEAD].id, HEAD_2);
        assertEq(parts.balanceOf(alice, HEAD_1), 1); // 旧件退回
        assertEq(parts.balanceOf(address(identity), HEAD_1), 0);
        assertEq(parts.balanceOf(address(identity), HEAD_2), 1);
    }

    function test_equip_wrongSlot_reverts() public {
        _givePart(alice, BODY_1, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.SlotMismatch.selector, Slots.HEAD, Slots.BODY));
        identity.equip(aliceToken, Slots.HEAD, address(parts), BODY_1);
    }

    function test_equip_invalidSlot_reverts() public {
        _givePart(alice, HEAD_1, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Slots.InvalidSlot.selector, 4));
        identity.equip(aliceToken, 4, address(parts), HEAD_1);
    }

    function test_equip_unapprovedCollection_reverts() public {
        DIDParts parts2 = new DIDParts("https://example/{id}.json");
        parts2.registerPart(HEAD_1, Slots.HEAD, 0, 100);
        parts2.mintPart(alice, HEAD_1, 1);
        vm.prank(alice);
        parts2.setApprovalForAll(address(identity), true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.CollectionNotApproved.selector, address(parts2)));
        identity.equip(aliceToken, Slots.HEAD, address(parts2), HEAD_1);
    }

    function test_equip_notTokenOwner_reverts() public {
        _givePart(bob, HEAD_1, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotTokenOwner.selector, bob));
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);
    }

    function test_equip_unregisteredPart_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartNotRegistered.selector, 9999));
        identity.equip(aliceToken, Slots.HEAD, address(parts), 9999);
    }

    function test_equip_withoutPartBalance_reverts() public {
        vm.prank(alice);
        parts.setApprovalForAll(address(identity), true);
        vm.prank(alice);
        vm.expectRevert(); // ERC1155InsufficientBalance
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);
    }

    // ---------------- unequip ----------------

    function test_unequip() public {
        _givePart(alice, PET_1, 1);
        vm.startPrank(alice);
        identity.equip(aliceToken, Slots.PET, address(parts), PET_1);

        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.Unequipped(aliceToken, Slots.PET, address(parts), PET_1);
        identity.unequip(aliceToken, Slots.PET);
        vm.stopPrank();

        IDIDIdentity.EquippedItem[4] memory items = identity.getEquipped(aliceToken);
        assertEq(items[Slots.PET].collection, address(0));
        assertEq(parts.balanceOf(alice, PET_1), 1);
        assertEq(parts.balanceOf(address(identity), PET_1), 0);
    }

    function test_unequip_empty_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NothingEquipped.selector, aliceToken, Slots.PET));
        identity.unequip(aliceToken, Slots.PET);
    }

    function test_unequip_notOwner_reverts() public {
        _givePart(alice, PET_1, 1);
        vm.prank(alice);
        identity.equip(aliceToken, Slots.PET, address(parts), PET_1);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotTokenOwner.selector, bob));
        identity.unequip(aliceToken, Slots.PET);
    }

    // ---------------- 与转账/销毁的联动 ----------------

    function test_transfer_withEquipment_reverts() public {
        _givePart(alice, HEAD_1, 1);
        vm.prank(alice);
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);

        identity.unlock(aliceToken);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.SlotsNotEmpty.selector, aliceToken));
        identity.transferFrom(alice, bob, aliceToken);

        // 卸下后可转账
        vm.prank(alice);
        identity.unequip(aliceToken, Slots.HEAD);
        vm.prank(alice);
        identity.transferFrom(alice, bob, aliceToken);
        assertEq(identity.ownerOf(aliceToken), bob);
    }

    function test_burn_withEquipment_reverts() public {
        _givePart(alice, HEAD_1, 1);
        vm.prank(alice);
        identity.equip(aliceToken, Slots.HEAD, address(parts), HEAD_1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.SlotsNotEmpty.selector, aliceToken));
        identity.burn(aliceToken);
    }

    /// 非白名单 1155 直接打入合约会被拒收（防垃圾 token 卡死）
    function test_direct1155Transfer_fromUnapprovedCollection_reverts() public {
        DIDParts parts2 = new DIDParts("https://example/{id}.json");
        parts2.registerPart(HEAD_1, Slots.HEAD, 0, 100);
        parts2.mintPart(alice, HEAD_1, 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.CollectionNotApproved.selector, address(parts2)));
        parts2.safeTransferFrom(alice, address(identity), HEAD_1, 1, "");
    }

    // ---------------- fuzz ----------------

    /// 任意插槽装备/卸下后，配件归属与插槽记录始终一致
    function testFuzz_equipUnequip_anySlot(uint8 slotRaw) public {
        uint8 slot = uint8(bound(slotRaw, 0, 3));
        uint256 partId = _slotPart(slot);
        _givePart(alice, partId, 1);

        vm.startPrank(alice);
        identity.equip(aliceToken, slot, address(parts), partId);
        assertEq(parts.balanceOf(address(identity), partId), 1);
        assertEq(parts.balanceOf(alice, partId), 0);

        identity.unequip(aliceToken, slot);
        vm.stopPrank();

        assertEq(parts.balanceOf(address(identity), partId), 0);
        assertEq(parts.balanceOf(alice, partId), 1);
        IDIDIdentity.EquippedItem[4] memory items = identity.getEquipped(aliceToken);
        assertEq(items[slot].collection, address(0));
    }
}
