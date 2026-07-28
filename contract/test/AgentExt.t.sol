// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {IDIDIdentity} from "../src/interfaces/IDIDIdentity.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AgentExtTest is BaseTest {
    uint256 internal aliceToken;

    function setUp() public override {
        super.setUp();
        aliceToken = _mintDID(alice, "Alice");
    }

    // ---------------- agent 授权 ----------------

    function test_setAgent() public {
        // 注意：先取权限值到本地变量，避免外部 getter 调用消耗 vm.prank
        uint256 personaPerm = identity.PERMISSION_PERSONA();
        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.AgentUpdated(aliceToken, agent, personaPerm);

        vm.prank(alice);
        identity.setAgent(aliceToken, agent, personaPerm);

        assertEq(identity.agentPermissions(aliceToken, agent), personaPerm);
    }

    function test_setAgent_combinedMask() public {
        uint256 mask = identity.PERMISSION_PERSONA() | identity.PERMISSION_SOCIAL();
        vm.prank(alice);
        identity.setAgent(aliceToken, agent, mask);
        assertEq(identity.agentPermissions(aliceToken, agent), mask);
    }

    function test_setAgent_notOwner_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotTokenOwner.selector, bob));
        identity.setAgent(aliceToken, agent, 1);
    }

    function test_setAgent_zeroAddress_reverts() public {
        vm.prank(alice);
        vm.expectRevert(DIDIdentity.InvalidAgent.selector);
        identity.setAgent(aliceToken, address(0), 1);
    }

    function test_setAgent_zeroMask_reverts() public {
        vm.prank(alice);
        vm.expectRevert(DIDIdentity.InvalidAgent.selector);
        identity.setAgent(aliceToken, agent, 0);
    }

    function test_revokeAgent() public {
        vm.startPrank(alice);
        identity.setAgent(aliceToken, agent, 1);

        vm.expectEmit(true, true, false, true, address(identity));
        emit DIDIdentity.AgentUpdated(aliceToken, agent, 0);
        identity.revokeAgent(aliceToken, agent);
        vm.stopPrank();

        assertEq(identity.agentPermissions(aliceToken, agent), 0);
    }

    // ---------------- persona ----------------

    function test_setPersona_byOwner() public {
        bytes32 hash = keccak256("persona-v1");
        vm.expectEmit(true, false, false, true, address(identity));
        emit DIDIdentity.PersonaUpdated(aliceToken, "ipfs://persona/alice.json", hash);

        vm.prank(alice);
        identity.setPersona(aliceToken, "ipfs://persona/alice.json", hash);

        IDIDIdentity.Persona memory p = identity.personaOf(aliceToken);
        assertEq(p.uri, "ipfs://persona/alice.json");
        assertEq(p.contentHash, hash);
    }

    function test_setPersona_byAuthorizedAgent() public {
        uint256 personaPerm = identity.PERMISSION_PERSONA();
        vm.prank(alice);
        identity.setAgent(aliceToken, agent, personaPerm);

        bytes32 hash = keccak256("persona-by-agent");
        vm.prank(agent);
        identity.setPersona(aliceToken, "ipfs://persona/agent.json", hash);

        assertEq(identity.personaOf(aliceToken).uri, "ipfs://persona/agent.json");
    }

    function test_setPersona_agentWithoutPersonaPerm_reverts() public {
        uint256 socialPerm = identity.PERMISSION_SOCIAL();
        vm.prank(alice);
        identity.setAgent(aliceToken, agent, socialPerm); // 只有社交权限

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotAuthorized.selector, agent));
        identity.setPersona(aliceToken, "ipfs://persona/x.json", bytes32(0));
    }

    function test_setPersona_stranger_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotAuthorized.selector, bob));
        identity.setPersona(aliceToken, "ipfs://persona/x.json", bytes32(0));
    }

    function test_setPersona_afterRevoke_reverts() public {
        uint256 personaPerm = identity.PERMISSION_PERSONA();
        vm.startPrank(alice);
        identity.setAgent(aliceToken, agent, personaPerm);
        identity.revokeAgent(aliceToken, agent);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DIDIdentity.NotAuthorized.selector, agent));
        identity.setPersona(aliceToken, "ipfs://persona/x.json", bytes32(0));
    }

    // ---------------- 模块注册表 ----------------

    function test_registerModule() public {
        bytes32 moduleId = keccak256("persona-module");
        address impl = makeAddr("personaModule");

        vm.expectEmit(true, true, false, false, address(identity));
        emit DIDIdentity.ModuleRegistered(moduleId, impl);
        identity.registerModule(moduleId, impl);

        assertEq(identity.getModule(moduleId), impl);
    }

    function test_registerModule_removeWithZeroAddress() public {
        bytes32 moduleId = keccak256("persona-module");
        identity.registerModule(moduleId, makeAddr("personaModule"));
        identity.registerModule(moduleId, address(0));
        assertEq(identity.getModule(moduleId), address(0));
    }

    function test_registerModule_notOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        identity.registerModule(keccak256("m"), makeAddr("impl"));
    }

    function test_registerModule_zeroId_reverts() public {
        vm.expectRevert(DIDIdentity.InvalidModuleId.selector);
        identity.registerModule(bytes32(0), makeAddr("impl"));
    }
}
