// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {IERC5192} from "../src/interfaces/IERC5192.sol";
import {IERC4906} from "../src/interfaces/IERC4906.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DIDIdentityTest is BaseTest {
    // ---------------- mint ----------------

    function test_mint() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        assertEq(tokenId, 1);
        assertEq(identity.ownerOf(tokenId), alice);
        assertEq(identity.tokenIdOf(alice), tokenId);
        assertEq(identity.nameOf(tokenId), "Alice");
        assertEq(identity.totalMinted(), 1);
        assertTrue(identity.locked(tokenId)); // 铸造即为锁定态
    }

    function test_mint_emitsLockedAndMinted() public {
        vm.expectEmit(true, false, false, false, address(identity));
        emit IERC5192.Locked(1);
        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.Minted(alice, 1, "Alice");
        _mintDID(alice, "Alice");
    }

    function test_mint_twice_reverts() public {
        _mintDID(alice, "Alice");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.AlreadyHasDID.selector, alice));
        identity.mint("Alice2", "ipfs://x");
    }

    function test_mint_duplicateName_reverts() public {
        _mintDID(alice, "Satoshi");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NameTaken.selector, "satoshi"));
        identity.mint("satoshi", "ipfs://x");
    }

    function test_mint_nameCaseInsensitive_reverts() public {
        _mintDID(alice, "Alice");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NameTaken.selector, "ALICE"));
        identity.mint("ALICE", "ipfs://x");
    }

    function test_mint_emptyName_reverts() public {
        vm.prank(alice);
        vm.expectRevert(DIDIdentity.InvalidName.selector);
        identity.mint("", "ipfs://x");
    }

    function test_nameAvailable() public view {
        assertTrue(identity.nameAvailable("Bob"));
    }

    function test_nameAvailable_afterMint_false() public {
        _mintDID(alice, "Alice");
        assertFalse(identity.nameAvailable("alice"));
        assertFalse(identity.nameAvailable("ALICE"));
        assertTrue(identity.nameAvailable("bob"));
    }

    // ---------------- soulbound ----------------

    function test_transfer_locked_reverts() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.TokenLocked.selector, tokenId));
        identity.transferFrom(alice, bob, tokenId);
    }

    function test_unlock_thenTransfer_works() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        identity.unlock(tokenId);

        vm.prank(alice);
        identity.transferFrom(alice, bob, tokenId);

        assertEq(identity.ownerOf(tokenId), bob);
        assertEq(identity.tokenIdOf(alice), 0);
        assertEq(identity.tokenIdOf(bob), tokenId);
        assertFalse(identity.locked(tokenId)); // 解锁状态跟随 token
    }

    function test_unlock_emitsEvent() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        vm.expectEmit(true, false, false, false, address(identity));
        emit IERC5192.Unlocked(tokenId);
        identity.unlock(tokenId);
    }

    function test_unlock_notOwner_reverts() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        identity.unlock(tokenId);
    }

    function test_lockAgain_blocksTransfer() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        identity.unlock(tokenId);
        identity.lock(tokenId);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.TokenLocked.selector, tokenId));
        identity.transferFrom(alice, bob, tokenId);
    }

    function test_transfer_toExistingDIDHolder_reverts() public {
        uint256 aliceToken = _mintDID(alice, "Alice");
        _mintDID(bob, "Bob");
        identity.unlock(aliceToken);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.AlreadyHasDID.selector, bob));
        identity.transferFrom(alice, bob, aliceToken);
    }

    // ---------------- burn ----------------

    function test_burn() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        vm.prank(alice);
        identity.burn(tokenId);
        assertEq(identity.tokenIdOf(alice), 0);
        assertEq(identity.totalMinted(), 1); // tokenId 不复用
        // 名称永久保留，防冒名
        assertFalse(identity.nameAvailable("alice"));
    }

    function test_burn_thenRemint_newTokenId() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        vm.prank(alice);
        identity.burn(tokenId);

        vm.prank(alice);
        uint256 newTokenId = identity.mint("Alice2", "ipfs://y");
        assertEq(newTokenId, tokenId + 1);
    }

    function test_burn_notOwner_reverts() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotTokenOwner.selector, bob));
        identity.burn(tokenId);
    }

    // ---------------- metadata ----------------

    function test_tokenURI() public {
        uint256 tokenId = _mintDID(alice, "Alice");
        assertEq(identity.tokenURI(tokenId), "https://api.didaiverse.example/metadata/did/1");
    }

    function test_contractURI() public view {
        assertEq(identity.contractURI(), "https://api.didaiverse.example/metadata/contract.json");
    }

    function test_setBaseURI_notOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        identity.setBaseURI("https://evil.example/");
    }

    // ---------------- ERC-165 ----------------

    function test_supportsInterface() public view {
        assertTrue(identity.supportsInterface(type(IERC721).interfaceId));
        assertTrue(identity.supportsInterface(type(IERC5192).interfaceId)); // 0xb45a3c0e
        assertTrue(identity.supportsInterface(type(IERC4906).interfaceId)); // 0x49064906
        assertTrue(identity.supportsInterface(type(IERC1155Receiver).interfaceId));
        assertFalse(identity.supportsInterface(0xffffffff));
    }
}
