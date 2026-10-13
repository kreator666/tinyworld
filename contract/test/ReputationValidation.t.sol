// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDReputation} from "../src/DIDReputation.sol";
import {DIDValidation} from "../src/DIDValidation.sol";

/// @notice ERC-8004 Reputation + Validation 注册表
contract ReputationValidationTest is BaseTest {
    DIDReputation internal reputation;
    DIDValidation internal validation;
    uint256 internal tokenId;

    address internal validator = makeAddr("validator");

    function setUp() public override {
        super.setUp();
        tokenId = _mintDID(alice, "alice");
        reputation = new DIDReputation(address(identity));
        validation = new DIDValidation(address(identity));
    }

    // ---------- Reputation ----------

    function test_giveFeedback_ok() public {
        vm.prank(bob);
        reputation.giveFeedback(tokenId, 80, 0, "quality", "defi", "agent.example", "ipfs://fb/1", bytes32("h"));
        DIDReputation.Feedback memory fb = reputation.readFeedback(tokenId, bob, 0);
        assertEq(fb.value, 80);
        assertEq(fb.tag1, "quality");
        assertFalse(fb.isRevoked);
        assertEq(fb.clientAddress, bob);
        assertEq(reputation.getLastIndex(tokenId, bob), 1);
        assertEq(reputation.getClients(tokenId).length, 1);
    }

    function test_giveFeedback_ownerBlocked() public {
        vm.prank(alice);
        vm.expectRevert(DIDReputation.AgentOwnerCannotFeedback.selector);
        reputation.giveFeedback(tokenId, 100, 0, "", "", "", "", bytes32(0));
    }

    function test_giveFeedback_operatorBlocked() public {
        uint256 perm = identity.PERMISSION_SOCIAL();
        vm.prank(alice);
        identity.setAgent(tokenId, agent, perm);
        vm.prank(agent);
        vm.expectRevert(DIDReputation.AgentOwnerCannotFeedback.selector);
        reputation.giveFeedback(tokenId, 100, 0, "", "", "", "", bytes32(0));
    }

    function test_giveFeedback_decimalsOver18_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDReputation.InvalidValueDecimals.selector, 19));
        reputation.giveFeedback(tokenId, 1, 19, "", "", "", "", bytes32(0));
    }

    function test_revokeFeedback_onlyAuthor() public {
        vm.prank(bob);
        reputation.giveFeedback(tokenId, 50, 0, "", "", "", "", bytes32(0));

        vm.prank(carol); // 非作者（无反馈桶）不能撤回
        vm.expectRevert(
            abi.encodeWithSelector(DIDReputation.InvalidFeedbackIndex.selector, tokenId, carol, uint128(0))
        );
        reputation.revokeFeedback(tokenId, 0);

        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit DIDReputation.FeedbackRevoked(tokenId, bob, 0);
        reputation.revokeFeedback(tokenId, 0);
        assertTrue(reputation.readFeedback(tokenId, bob, 0).isRevoked);
    }

    function test_appendResponse_ok() public {
        vm.prank(bob);
        reputation.giveFeedback(tokenId, 50, 0, "", "", "", "", bytes32(0));
        vm.prank(bob);
        reputation.appendResponse(tokenId, bob, 0, "ipfs://resp", bytes32("r"));
        assertEq(reputation.readFeedback(tokenId, bob, 0).responseCount, 1);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(DIDReputation.NotFeedbackAuthor.selector, carol));
        reputation.appendResponse(tokenId, bob, 0, "x", bytes32(0));
    }

    function test_readAllFeedback_and_summary() public {
        vm.prank(bob);
        reputation.giveFeedback(tokenId, 4, 0, "quality", "dex", "", "", bytes32(0));
        vm.prank(bob);
        reputation.giveFeedback(tokenId, 5, 0, "quality", "lend", "", "", bytes32(0));
        vm.prank(carol);
        reputation.giveFeedback(tokenId, 3, 0, "speed", "", "", "", bytes32(0));
        // bob 撤回一条，汇总应排除
        vm.prank(bob);
        reputation.revokeFeedback(tokenId, 0);

        address[] memory clients = new address[](2);
        clients[0] = bob;
        clients[1] = carol;
        uint128[] memory starts = new uint128[](2);
        uint128[] memory counts = new uint128[](2);
        counts[0] = 10;
        counts[1] = 10;
        (DIDReputation.Feedback[] memory fbs,,,) = reputation.readAllFeedback(tokenId, clients, starts, counts);
        assertEq(fbs.length, 3); // 含已撤回的，读路径不做过滤

        (int256 avg, uint8 dec, uint256 n) = reputation.getSummary(tokenId, clients, "", "");
        assertEq(n, 2); // 撤回的排除
        assertEq(dec, 18);
        assertEq(avg, 4 ether); // (5 + 3) / 2 = 4（统一到 18 位小数）

        // tag 过滤
        (avg,, n) = reputation.getSummary(tokenId, clients, "quality", "");
        assertEq(n, 1);
        assertEq(avg, 5 ether);
    }

    function test_getSummary_emptyClients_reverts() public {
        address[] memory clients = new address[](0);
        vm.expectRevert(DIDReputation.EmptyClientAddresses.selector);
        reputation.getSummary(tokenId, clients, "", "");
    }

    // ---------- Validation ----------

    bytes32 internal constant REQ_HASH = bytes32("request-hash-01");

    function test_validationFlow_ok() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit DIDValidation.ValidationRequest(tokenId, alice, validator, "ipfs://req", REQ_HASH);
        validation.validationRequest(validator, tokenId, "ipfs://req", REQ_HASH);

        (uint8 resp, bool exists) = validation.getValidationStatus(REQ_HASH);
        assertTrue(exists);
        assertEq(resp, 0);

        // validator 提交响应，可更新
        vm.prank(validator);
        validation.validationResponse(REQ_HASH, 1, "ipfs://ok", bytes32("a"), "audit");
        vm.prank(validator);
        validation.validationResponse(REQ_HASH, 1, "ipfs://ok2", bytes32("b"), "audit");
        (resp,) = validation.getValidationStatus(REQ_HASH);
        assertEq(resp, 1);
        assertEq(validation.getValidation(REQ_HASH).responseURI, "ipfs://ok2");

        assertEq(validation.getAgentValidations(tokenId).length, 1);
        assertEq(validation.getValidatorRequests(validator).length, 1);
    }

    function test_validationRequest_stranger_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDValidation.NotAgentOwnerOrOperator.selector, bob));
        validation.validationRequest(validator, tokenId, "ipfs://req", REQ_HASH);
    }

    function test_validationRequest_operator_ok() public {
        uint256 perm = identity.PERMISSION_SOCIAL();
        vm.prank(alice);
        identity.setAgent(tokenId, agent, perm);
        vm.prank(agent);
        validation.validationRequest(validator, tokenId, "ipfs://req", REQ_HASH);
        assertEq(validation.getAgentValidations(tokenId).length, 1);
    }

    function test_validationResponse_nonValidator_reverts() public {
        vm.prank(alice);
        validation.validationRequest(validator, tokenId, "ipfs://req", REQ_HASH);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDValidation.NotValidator.selector, bob));
        validation.validationResponse(REQ_HASH, 1, "x", bytes32(0), "");

        // owner 也不能代答
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DIDValidation.NotValidator.selector, alice));
        validation.validationResponse(REQ_HASH, 1, "x", bytes32(0), "");
    }

    function test_validationResponse_unknownHash_reverts() public {
        vm.prank(validator);
        vm.expectRevert(abi.encodeWithSelector(DIDValidation.RequestNotFound.selector, REQ_HASH));
        validation.validationResponse(REQ_HASH, 1, "x", bytes32(0), "");
    }

    function test_getSummary_counts() public {
        bytes32 h1 = bytes32(uint256(1));
        bytes32 h2 = bytes32(uint256(2));
        bytes32 h3 = bytes32(uint256(3));
        vm.startPrank(alice);
        validation.validationRequest(validator, tokenId, "a", h1);
        validation.validationRequest(validator, tokenId, "b", h2);
        validation.validationRequest(carol, tokenId, "c", h3);
        vm.stopPrank();
        vm.prank(validator);
        validation.validationResponse(h1, 1, "", bytes32(0), "audit");
        vm.prank(validator);
        validation.validationResponse(h2, 2, "", bytes32(0), "audit");
        // h3 保持未响应

        address[] memory validators = new address[](1);
        validators[0] = validator;
        (uint256 ok, uint256 bad, uint256 pending) = validation.getSummary(tokenId, validators, "audit");
        assertEq(ok, 1);
        assertEq(bad, 1);
        assertEq(pending, 0);
        // 空 validator 集合 = 不过滤
        address[] memory all = new address[](0);
        (ok, bad, pending) = validation.getSummary(tokenId, all, "");
        assertEq(ok, 1);
        assertEq(bad, 1);
        assertEq(pending, 1);
    }
}
