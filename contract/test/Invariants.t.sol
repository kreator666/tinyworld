// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {IDIDIdentity} from "../src/interfaces/IDIDIdentity.sol";
import {Slots} from "../src/libraries/Slots.sol";

/// @notice 不变量测试处理器：随机用户随机装备/卸下，ghost 变量跟踪托管中的配件数量
contract EquipHandler is BaseTest {
    address[] internal users;
    mapping(uint256 partId => uint256 equippedCount) public ghost_equipped;

    function init() external {
        setUp();
        users.push(alice);
        users.push(bob);
        users.push(carol);
        for (uint256 i = 0; i < users.length; ++i) {
            _mintDID(users[i], string(abi.encodePacked("user", vm.toString(i))));
        }
        // handler 作为 minter，按需给用户发配件，保证 equip 路径总能走通
        parts.setMinter(address(this), true);
    }

    function equip(uint256 userSeed, uint8 slotSeed) external {
        address user = users[userSeed % users.length];
        uint8 slot = uint8(slotSeed % Slots.COUNT);
        uint256 tokenId = identity.tokenIdOf(user);
        uint256 partId = _slotPart(slot);

        // 先读旧件：换装会自动退回旧件
        IDIDIdentity.EquippedItem[4] memory before = identity.getEquipped(tokenId);
        IDIDIdentity.EquippedItem memory old = before[slot];

        parts.mintPart(user, partId, 1);
        vm.startPrank(user);
        parts.setApprovalForAll(address(identity), true);
        identity.equip(tokenId, slot, address(parts), partId);
        vm.stopPrank();

        ghost_equipped[partId]++;
        if (old.collection != address(0)) ghost_equipped[old.id]--;
    }

    function unequip(uint256 userSeed, uint8 slotSeed) external {
        address user = users[userSeed % users.length];
        uint8 slot = uint8(slotSeed % Slots.COUNT);
        uint256 tokenId = identity.tokenIdOf(user);

        IDIDIdentity.EquippedItem[4] memory items = identity.getEquipped(tokenId);
        if (items[slot].collection == address(0)) return;

        vm.prank(user);
        identity.unequip(tokenId, slot);
        ghost_equipped[items[slot].id]--;
    }

    // 供外部不变量断言读取
    function partsBalanceOf(address account, uint256 id) external view returns (uint256) {
        return parts.balanceOf(account, id);
    }

    function identityAddress() external view returns (address) {
        return address(identity);
    }
}

contract InvariantsTest is Test {
    EquipHandler internal handler;

    function setUp() public {
        handler = new EquipHandler();
        handler.init();
        // 只 fuzz equip/unequip，防止 fuzzer 调用 init/setUp 重置链上状态导致 ghost 失真
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = EquipHandler.equip.selector;
        selectors[1] = EquipHandler.unequip.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// 不变量：identity 合约托管的每种配件数量 == ghost 记录的在装数量
    function invariant_custodyMatchesSlots() public view {
        uint256[5] memory partIds = [uint256(1001), 1002, 2001, 3001, 4001];
        for (uint256 i = 0; i < partIds.length; ++i) {
            assertEq(
                handler.partsBalanceOf(handler.identityAddress(), partIds[i]),
                handler.ghost_equipped(partIds[i]),
                "custody mismatch"
            );
        }
    }
}
