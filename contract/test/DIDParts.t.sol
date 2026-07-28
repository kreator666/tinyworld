// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDParts} from "../src/DIDParts.sol";
import {Slots} from "../src/libraries/Slots.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DIDPartsTest is BaseTest {
    function test_registerPart() public view {
        assertEq(parts.slotOf(HEAD_1), Slots.HEAD);
        assertEq(parts.rarityOf(HEAD_1), RARITY_COMMON);
        assertEq(parts.slotOf(PET_1), Slots.PET);
        assertEq(parts.rarityOf(PET_1), RARITY_LEGENDARY);
    }

    function test_registerPart_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(parts));
        emit DIDParts.PartRegistered(9001, Slots.HEAD, 1, 42);
        parts.registerPart(9001, Slots.HEAD, 1, 42);
    }

    function test_registerPart_notOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        parts.registerPart(9001, Slots.HEAD, 0, 10);
    }

    function test_registerPart_twice_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartAlreadyRegistered.selector, HEAD_1));
        parts.registerPart(HEAD_1, Slots.BODY, 0, 10);
    }

    function test_registerPart_invalidSlot_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Slots.InvalidSlot.selector, 4));
        parts.registerPart(9001, 4, 0, 10);
    }

    function test_registerPart_zeroMaxSupply_reverts() public {
        vm.expectRevert(DIDParts.InvalidMaxSupply.selector);
        parts.registerPart(9001, Slots.HEAD, 0, 0);
    }

    function test_mintPart() public {
        parts.mintPart(alice, HEAD_1, 3);
        assertEq(parts.balanceOf(alice, HEAD_1), 3);
        assertEq(parts.totalSupply(HEAD_1), 3);
    }

    function test_mintPart_exceedsMaxSupply_reverts() public {
        parts.registerPart(9002, Slots.BODY, 0, 2);
        parts.mintPart(alice, 9002, 2);
        vm.expectRevert(abi.encodeWithSelector(DIDParts.MaxSupplyExceeded.selector, 9002, 2));
        parts.mintPart(alice, 9002, 1);
    }

    function test_mintPart_unregistered_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartNotRegistered.selector, 9999));
        parts.mintPart(alice, 9999, 1);
    }

    function test_mintPart_notMinter_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDParts.NotMinter.selector, alice));
        parts.mintPart(alice, HEAD_1, 1);
    }

    function test_setMinter_allowsExternalMint() public {
        parts.setMinter(alice, true);
        vm.prank(alice);
        parts.mintPart(bob, HEAD_1, 1);
        assertEq(parts.balanceOf(bob, HEAD_1), 1);
    }

    function test_setPartMintable_false_reverts() public {
        parts.setPartMintable(HEAD_1, false);
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartNotMintable.selector, HEAD_1));
        parts.mintPart(alice, HEAD_1, 1);
    }

    function test_slotOf_unregistered_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DIDParts.PartNotRegistered.selector, 9999));
        parts.slotOf(9999);
    }

    function test_mintPartBatch() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = HEAD_1;
        ids[1] = PET_1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 5;
        amounts[1] = 2;
        parts.mintPartBatch(alice, ids, amounts);
        assertEq(parts.balanceOf(alice, HEAD_1), 5);
        assertEq(parts.balanceOf(alice, PET_1), 2);
    }

    function test_mintPartBatch_exceedsCap_reverts() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = PET_1; // maxSupply 10
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 11;
        vm.expectRevert(abi.encodeWithSelector(DIDParts.MaxSupplyExceeded.selector, PET_1, 10));
        parts.mintPartBatch(alice, ids, amounts);
    }

    function test_uri() public view {
        assertEq(parts.uri(HEAD_1), "https://api.didaiverse.example/parts/{id}.json");
    }
}
