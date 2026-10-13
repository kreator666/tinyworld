// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";

/// @notice ERC-8004 Identity 对齐：metadata / agentWallet / Registered / URIUpdated
contract ERC8004IdentityTest is BaseTest {
    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        tokenId = _mintDID(alice, "alice");
    }

    // ---------- metadata ----------

    function test_setMetadata_ok() public {
        vm.prank(alice);
        identity.setMetadata(tokenId, "service.endpoint", abi.encode("https://agent.example"));
        assertEq(identity.getMetadata(tokenId, "service.endpoint"), abi.encode("https://agent.example"));
    }

    function test_setMetadata_operatorWithPersonaPerm_ok() public {
        uint256 perm = identity.PERMISSION_PERSONA(); // 先取值,避免参数求值的 staticcall 消耗 prank
        vm.prank(alice);
        identity.setAgent(tokenId, agent, perm);
        vm.prank(agent);
        identity.setMetadata(tokenId, "k", "v");
        assertEq(identity.getMetadata(tokenId, "k"), "v");
    }

    function test_setMetadata_reservedAgentWalletKey_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.ReservedMetadataKey.selector, "agentWallet"));
        identity.setMetadata(tokenId, "agentWallet", abi.encode(bob));
    }

    function test_setMetadata_stranger_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotAuthorized.selector, bob));
        identity.setMetadata(tokenId, "k", "v");
    }

    // ---------- agentWallet（EIP-712 签名） ----------

    function _signWallet(address signerPkAddr, uint256 pk, uint256 agentId, address newWallet, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = identity.agentWalletDigest(agentId, newWallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_setAgentWallet_ok() public {
        uint256 walletPk = 0xA11CE;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWallet(wallet, walletPk, tokenId, wallet, deadline);

        vm.prank(alice);
        identity.setAgentWallet(tokenId, wallet, deadline, sig);
        assertEq(identity.getAgentWallet(tokenId), wallet);
    }

    function test_setAgentWallet_expired_reverts() public {
        uint256 walletPk = 0xA11CE;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signWallet(wallet, walletPk, tokenId, wallet, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.SignatureExpired.selector, deadline));
        identity.setAgentWallet(tokenId, wallet, deadline, sig);
    }

    function test_setAgentWallet_wrongSigner_reverts() public {
        uint256 walletPk = 0xA11CE;
        address wallet = vm.addr(walletPk);
        uint256 otherPk = 0xB0B;
        uint256 deadline = block.timestamp + 1 hours;
        // otherPk 签了"wallet 控制证明"，验签应失败
        bytes32 digest = identity.agentWalletDigest(tokenId, wallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherPk, digest);

        vm.prank(alice);
        vm.expectRevert(DIDIdentity.InvalidWalletSignature.selector);
        identity.setAgentWallet(tokenId, wallet, deadline, abi.encodePacked(r, s, v));
    }

    function test_setAgentWallet_strangerCaller_reverts() public {
        uint256 walletPk = 0xA11CE;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWallet(wallet, walletPk, tokenId, wallet, deadline);

        vm.prank(bob); // bob 既不是 owner 也无权限位
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotAuthorized.selector, bob));
        identity.setAgentWallet(tokenId, wallet, deadline, sig);
    }

    function test_unsetAgentWallet_ok() public {
        uint256 walletPk = 0xA11CE;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWallet(wallet, walletPk, tokenId, wallet, deadline);
        vm.prank(alice);
        identity.setAgentWallet(tokenId, wallet, deadline, sig);
        assertEq(identity.getAgentWallet(tokenId), wallet);

        vm.prank(alice);
        identity.unsetAgentWallet(tokenId);
        assertEq(identity.getAgentWallet(tokenId), address(0));
    }

    function test_agentWallet_clearedOnTransfer() public {
        uint256 walletPk = 0xA11CE;
        address wallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signWallet(wallet, walletPk, tokenId, wallet, deadline);
        vm.prank(alice);
        identity.setAgentWallet(tokenId, wallet, deadline, sig);
        assertEq(identity.getAgentWallet(tokenId), wallet);

        // Soulbound 转让：先治理解锁，再转给无 DID 的 bob
        identity.unlock(tokenId);
        vm.prank(alice);
        identity.transferFrom(alice, bob, tokenId);
        assertEq(identity.getAgentWallet(tokenId), address(0));
        assertEq(identity.ownerOf(tokenId), bob);
    }

    // ---------- Registered / URIUpdated ----------

    function test_registeredEmittedOnMint() public {
        vm.expectEmit(true, false, true, true);
        emit IERC8004Identity.Registered(2, "ipfs://profile/bob", bob);
        _mintDID(bob, "bob");
    }

    function test_setProfileURI_ownerOnly() public {
        vm.prank(alice);
        vm.expectEmit(true, false, true, true);
        emit IERC8004Identity.URIUpdated(tokenId, "ipfs://v2", alice);
        identity.setProfileURI(tokenId, "ipfs://v2");
        assertEq(identity.profileURIOf(tokenId), "ipfs://v2");
    }

    function test_setProfileURI_stranger_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotTokenOwner.selector, bob));
        identity.setProfileURI(tokenId, "ipfs://v2");
    }

    function test_supportsInterface_erc8004() public view {
        assertTrue(identity.supportsInterface(type(IERC8004Identity).interfaceId));
    }
}
