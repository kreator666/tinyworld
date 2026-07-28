// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DIDIdentity} from "../src/DIDIdentity.sol";
import {DIDParts} from "../src/DIDParts.sol";
import {Slots} from "../src/libraries/Slots.sol";

/// @notice 公共测试基座：部署两个合约、注册 5 个示例配件（对应 prototype/role.md 的 4 插槽）
abstract contract BaseTest is Test {
    DIDIdentity internal identity;
    DIDParts internal parts;

    // 合约 owner = 部署者（测试合约本身）
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal agent = makeAddr("agent");

    // 配件 id 规划：1xxx 头部 / 2xxx 身体 / 3xxx 配饰 / 4xxx 宠物
    uint256 internal constant HEAD_1 = 1001;
    uint256 internal constant HEAD_2 = 1002;
    uint256 internal constant BODY_1 = 2001;
    uint256 internal constant ACC_1 = 3001;
    uint256 internal constant PET_1 = 4001;

    uint256 internal constant RARITY_COMMON = 0;
    uint256 internal constant RARITY_RARE = 1;
    uint256 internal constant RARITY_EPIC = 2;
    uint256 internal constant RARITY_LEGENDARY = 3;

    function setUp() public virtual {
        parts = new DIDParts("https://api.didaiverse.example/parts/{id}.json");
        identity = new DIDIdentity(
            "DID AI Verse Identity",
            "DIDAI",
            "https://api.didaiverse.example/metadata/did/",
            "https://api.didaiverse.example/metadata/contract.json"
        );
        identity.setCollectionApproved(address(parts), true);

        parts.registerPart(HEAD_1, Slots.HEAD, uint8(RARITY_COMMON), 1000);
        parts.registerPart(HEAD_2, Slots.HEAD, uint8(RARITY_RARE), 500);
        parts.registerPart(BODY_1, Slots.BODY, uint8(RARITY_COMMON), 1000);
        parts.registerPart(ACC_1, Slots.ACCESSORY, uint8(RARITY_EPIC), 100);
        parts.registerPart(PET_1, Slots.PET, uint8(RARITY_LEGENDARY), 10);
    }

    function _mintDID(address user, string memory name) internal returns (uint256 tokenId) {
        vm.prank(user);
        tokenId = identity.mint(name, string.concat("ipfs://profile/", name));
    }

    /// @dev 给用户发配件并授权 identity 合约托管划转
    function _givePart(address user, uint256 id, uint256 amount) internal {
        parts.mintPart(user, id, amount);
        vm.prank(user);
        parts.setApprovalForAll(address(identity), true);
    }

    function _slotPart(uint8 slot) internal pure returns (uint256) {
        if (slot == Slots.HEAD) return HEAD_1;
        if (slot == Slots.BODY) return BODY_1;
        if (slot == Slots.ACCESSORY) return ACC_1;
        return PET_1;
    }
}
