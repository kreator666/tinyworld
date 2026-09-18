// DID AI Verse 完整链上流程端到端测试
// 覆盖: 部署 -> 注册配件 -> 铸造配件 -> 铸造 DID -> 穿戴/换装/卸下 -> Soulbound -> AI 人格
// 注意: 环境未安装 hardhat-chai-matchers,custom error 断言用 try/catch + selector 匹配实现
const assert = require("assert");
const { ethers } = require("hardhat");

// 递归收集错误对象里所有字符串字段(ethers v6 把 revert data 藏在 err.data / err.error.data / err.info.error.data 等处)
function collectStrings(err) {
  const parts = [];
  (function walk(o, depth) {
    if (o == null || depth > 8) return;
    if (typeof o === "string") {
      parts.push(o.toLowerCase());
      return;
    }
    if (typeof o === "object") {
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    }
  })(err, 0);
  return parts.join("|");
}

// 断言 promise 以指定 custom error revert(selector 出现在 revert data 中)
async function expectCustomError(promise, contract, errorName) {
  const fragment = contract.interface.getError(errorName);
  assert.ok(fragment, `合约 ABI 中不存在错误 ${errorName}`);
  const selector = fragment.selector.toLowerCase();
  try {
    await promise;
  } catch (err) {
    const blob = collectStrings(err);
    assert.ok(
      blob.includes(selector.slice(2)),
      `期望 revert ${errorName} (selector ${selector}),实际错误: ${err.message}`
    );
    return;
  }
  assert.fail(`期望 revert ${errorName},但交易成功执行`);
}

describe("DID AI Verse 完整链上流程", function () {
  let owner, player1, player2, minter, agent, stranger;
  let parts, identity, partsAddr, identityAddr;

  // 配件 id 规划: 头=1001(普通), 身=2001(稀有), 配饰=3001(史诗), 宠物=4001(传说), 备用头=1002
  const HEAD = 1001n, HEAD2 = 1002n, BODY = 2001n, ACC = 3001n, PET = 4001n;
  let aliceId, bobId;

  // ---------- 步骤 1: 部署 ----------
  before(async function () {
    [owner, player1, player2, minter, agent, stranger] = await ethers.getSigners();

    const DIDParts = await ethers.getContractFactory("DIDParts");
    parts = await DIDParts.deploy("https://api.didaiverse.example/parts/{id}.json");
    await parts.waitForDeployment();
    partsAddr = await parts.getAddress();

    const DIDIdentity = await ethers.getContractFactory("DIDIdentity");
    identity = await DIDIdentity.deploy(
      "DID AI Verse Identity",
      "DIDAI",
      "https://api.didaiverse.example/metadata/did/",
      "https://api.didaiverse.example/metadata/contract.json"
    );
    await identity.waitForDeployment();
    identityAddr = await identity.getAddress();

    // 配件合约加入身份合约白名单
    await identity.setCollectionApproved(partsAddr, true);
    assert.strictEqual(await identity.approvedCollections(partsAddr), true);
  });

  // ---------- 步骤 2: 注册配件 ----------
  describe("步骤2: 注册配件 registerPart", function () {
    it("owner 注册 4 件装备(slot 0-3,稀有度 0-3)", async function () {
      await parts.registerPart(HEAD, 0, 0, 10000);
      await parts.registerPart(BODY, 1, 1, 2000);
      await parts.registerPart(ACC, 2, 2, 500);
      await parts.registerPart(PET, 3, 3, 100);

      const head = await parts.parts(HEAD);
      assert.strictEqual(head.slot, 0n);
      assert.strictEqual(head.rarity, 0n);
      assert.strictEqual(head.maxSupply, 10000n);
      assert.strictEqual(head.mintable, true);
      assert.strictEqual(head.registered, true);
    });

    it("非 owner 注册应 revert OwnableUnauthorizedAccount", async function () {
      await expectCustomError(
        parts.connect(player1).registerPart(9999, 0, 0, 100),
        parts,
        "OwnableUnauthorizedAccount"
      );
    });

    it("重复注册应 revert PartAlreadyRegistered", async function () {
      await expectCustomError(parts.registerPart(HEAD, 0, 0, 100), parts, "PartAlreadyRegistered");
    });

    it("maxSupply = 0 应 revert InvalidMaxSupply", async function () {
      await expectCustomError(parts.registerPart(5001, 0, 0, 0), parts, "InvalidMaxSupply");
    });
  });

  // ---------- 步骤 3: 铸造配件 ----------
  describe("步骤3: 铸造配件 mintPart / mintPartBatch", function () {
    it("owner mintPartBatch 发一套装备给 player1", async function () {
      // 每个配件铸 2 份: 1 份穿戴,1 份留在玩家背包
      await parts.mintPartBatch(player1.address, [HEAD, BODY, ACC, PET], [2, 2, 2, 2]);
      assert.strictEqual(await parts.balanceOf(player1.address, HEAD), 2n);
      assert.strictEqual(await parts.balanceOf(player1.address, PET), 2n);
      // totalSupply 存在 (uint256) 与 () 两个重载,需用完整签名调用
      assert.strictEqual(await parts["totalSupply(uint256)"](PET), 2n);
    });

    it("非 minter 铸造应 revert NotMinter", async function () {
      await expectCustomError(
        parts.connect(player1).mintPart(player1.address, HEAD, 1),
        parts,
        "NotMinter"
      );
    });

    it("setMinter 授权后 minter 可以铸造", async function () {
      await parts.setMinter(minter.address, true);
      await parts.connect(minter).mintPart(player1.address, HEAD, 1);
      assert.strictEqual(await parts.balanceOf(player1.address, HEAD), 3n);
      // 用完即收回授权
      await parts.setMinter(minter.address, false);
    });

    it("超过 maxSupply 应 revert MaxSupplyExceeded", async function () {
      // PET maxSupply=100,一次铸 101 必然超限
      await expectCustomError(
        parts.mintPart(player1.address, PET, 101),
        parts,
        "MaxSupplyExceeded"
      );
    });

    it("setPartMintable(false) 后铸造应 revert PartNotMintable", async function () {
      await parts.setPartMintable(ACC, false);
      await expectCustomError(parts.mintPart(player1.address, ACC, 1), parts, "PartNotMintable");
      await parts.setPartMintable(ACC, true); // 恢复,不影响后续流程
    });
  });

  // ---------- 步骤 4: 铸造 DID ----------
  describe("步骤4: 铸造 DID mint", function () {
    it("player1 铸造 DID 'Alice'", async function () {
      assert.strictEqual(await identity.nameAvailable("Alice"), true);
      await identity.connect(player1).mint("Alice", "ipfs://alice-profile.json");
      aliceId = await identity.tokenIdOf(player1.address);
      assert.strictEqual(aliceId, 1n);
      assert.strictEqual(await identity.nameOf(aliceId), "Alice");
      assert.strictEqual(await identity.ownerOf(aliceId), player1.address);
    });

    it("铸造后 nameAvailable('Alice') = false,'Bob' 仍可用", async function () {
      assert.strictEqual(await identity.nameAvailable("Alice"), false);
      assert.strictEqual(await identity.nameAvailable("Bob"), true);
    });

    it("同一地址重复铸造应 revert AlreadyHasDID", async function () {
      await expectCustomError(
        identity.connect(player1).mint("Alice2", ""),
        identity,
        "AlreadyHasDID"
      );
    });

    it("大小写变体 'alice' 应 revert NameTaken(大小写不敏感)", async function () {
      await expectCustomError(
        identity.connect(player2).mint("alice", ""),
        identity,
        "NameTaken"
      );
    });

    it("player2 铸造 DID 'Bob'(供 AI 人格环节使用)", async function () {
      await identity.connect(player2).mint("Bob", "ipfs://bob-profile.json");
      bobId = await identity.tokenIdOf(player2.address);
      assert.strictEqual(bobId, 2n);
    });
  });

  // ---------- 步骤 5: 穿戴 / 换装 / 卸下 ----------
  describe("步骤5: 穿戴 equip / unequip", function () {
    it("未 setApprovalForAll 时 equip 应 revert ERC1155MissingApprovalForAll", async function () {
      await expectCustomError(
        identity.connect(player1).equip(aliceId, 0, partsAddr, HEAD),
        parts,
        "ERC1155MissingApprovalForAll"
      );
    });

    it("非 DID 持有者调用 equip 应 revert NotTokenOwner", async function () {
      await expectCustomError(
        identity.connect(player2).equip(aliceId, 0, partsAddr, HEAD),
        identity,
        "NotTokenOwner"
      );
    });

    it("授权后 equip 4 个插槽成功,配件转入身份合约托管", async function () {
      await parts.connect(player1).setApprovalForAll(identityAddr, true);
      await identity.connect(player1).equip(aliceId, 0, partsAddr, HEAD);
      await identity.connect(player1).equip(aliceId, 1, partsAddr, BODY);
      await identity.connect(player1).equip(aliceId, 2, partsAddr, ACC);
      await identity.connect(player1).equip(aliceId, 3, partsAddr, PET);

      // 配件余额转移到身份合约
      assert.strictEqual(await parts.balanceOf(identityAddr, HEAD), 1n);
      assert.strictEqual(await parts.balanceOf(identityAddr, PET), 1n);
      assert.strictEqual(await parts.balanceOf(player1.address, PET), 1n);

      // getEquipped 返回 4 个插槽的 (collection, id)
      const equipped = await identity.getEquipped(aliceId);
      assert.strictEqual(equipped.length, 4);
      for (let i = 0; i < 4; i++) {
        assert.strictEqual(equipped[i].collection, partsAddr);
      }
      assert.strictEqual(equipped[0].id, HEAD);
      assert.strictEqual(equipped[1].id, BODY);
      assert.strictEqual(equipped[2].id, ACC);
      assert.strictEqual(equipped[3].id, PET);
    });

    it("slot 不匹配应 revert SlotMismatch(头部件装到身槽)", async function () {
      await expectCustomError(
        identity.connect(player1).equip(aliceId, 1, partsAddr, HEAD),
        identity,
        "SlotMismatch"
      );
    });

    it("未白名单 collection 应 revert CollectionNotApproved", async function () {
      await expectCustomError(
        identity.connect(player1).equip(aliceId, 0, stranger.address, 1),
        identity,
        "CollectionNotApproved"
      );
    });

    it("换装: 同 slot 换新件,旧件自动退回玩家", async function () {
      await parts.registerPart(HEAD2, 0, 1, 5000);
      await parts.mintPart(player1.address, HEAD2, 1);

      await identity.connect(player1).equip(aliceId, 0, partsAddr, HEAD2);
      const equipped = await identity.getEquipped(aliceId);
      assert.strictEqual(equipped[0].id, HEAD2);
      // 旧头件 1001 退回 player1(背包里原有 2 份 + 退回 1 份 = 3)
      assert.strictEqual(await parts.balanceOf(player1.address, HEAD), 3n);
      assert.strictEqual(await parts.balanceOf(identityAddr, HEAD), 0n);
      assert.strictEqual(await parts.balanceOf(identityAddr, HEAD2), 1n);
    });

    it("unequip 卸下宠物,配件退回玩家", async function () {
      await identity.connect(player1).unequip(aliceId, 3);
      const equipped = await identity.getEquipped(aliceId);
      assert.strictEqual(equipped[3].collection, ethers.ZeroAddress);
      assert.strictEqual(await parts.balanceOf(player1.address, PET), 2n);
      assert.strictEqual(await parts.balanceOf(identityAddr, PET), 0n);
    });

    it("空插槽 unequip 应 revert NothingEquipped", async function () {
      await expectCustomError(
        identity.connect(player1).unequip(aliceId, 3),
        identity,
        "NothingEquipped"
      );
    });
  });

  // ---------- 步骤 6: Soulbound 约束 ----------
  describe("步骤6: Soulbound 锁定与销毁", function () {
    it("有装备时 burn 应 revert SlotsNotEmpty", async function () {
      await expectCustomError(identity.connect(player1).burn(aliceId), identity, "SlotsNotEmpty");
    });

    it("清空插槽后、锁定状态下 transferFrom 应 revert TokenLocked", async function () {
      // _update 先校验插槽再校验锁定,需先清空插槽才能命中 TokenLocked
      await identity.connect(player1).unequip(aliceId, 0);
      await identity.connect(player1).unequip(aliceId, 1);
      await identity.connect(player1).unequip(aliceId, 2);
      await expectCustomError(
        identity.connect(player1).transferFrom(player1.address, player2.address, aliceId),
        identity,
        "TokenLocked"
      );
    });

    it("插槽全空后 burn 成功,名称仍永久保留", async function () {
      await identity.connect(player1).burn(aliceId);

      assert.strictEqual(await identity.tokenIdOf(player1.address), 0n);
      // 名称永久保留不复用,防冒名
      assert.strictEqual(await identity.nameAvailable("Alice"), false);
    });
  });

  // ---------- 步骤 7: AI 人格与操作员 ----------
  describe("步骤7: AI 人格 persona 与 agent 授权", function () {
    const personaURI = "ipfs://persona/bob-v1.json";
    const personaHash = ethers.keccak256(ethers.toUtf8Bytes('{"name":"Bob","model":"v1"}'));

    it("DID 持有者 setPersona 成功,personaOf 读回一致", async function () {
      await identity.connect(player2).setPersona(bobId, personaURI, personaHash);
      const persona = await identity.personaOf(bobId);
      assert.strictEqual(persona.uri, personaURI);
      assert.strictEqual(persona.contentHash, personaHash);
    });

    it("未授权地址 setPersona 应 revert NotAuthorized", async function () {
      await expectCustomError(
        identity.connect(stranger).setPersona(bobId, "ipfs://evil.json", personaHash),
        identity,
        "NotAuthorized"
      );
    });

    it("setAgent 授权 PERMISSION_PERSONA 后 agent 可 setPersona", async function () {
      const PERMISSION_PERSONA = await identity.PERMISSION_PERSONA();
      assert.strictEqual(PERMISSION_PERSONA, 1n);
      await identity.connect(player2).setAgent(bobId, agent.address, PERMISSION_PERSONA);

      const agentURI = "ipfs://persona/bob-v2-by-agent.json";
      await identity.connect(agent).setPersona(bobId, agentURI, personaHash);
      const persona = await identity.personaOf(bobId);
      assert.strictEqual(persona.uri, agentURI);
    });

    it("revokeAgent 后 agent 再调 setPersona 应 revert NotAuthorized", async function () {
      await identity.connect(player2).revokeAgent(bobId, agent.address);
      assert.strictEqual(await identity.agentPermissions(bobId, agent.address), 0n);
      await expectCustomError(
        identity.connect(agent).setPersona(bobId, "ipfs://persona/bob-v3.json", personaHash),
        identity,
        "NotAuthorized"
      );
    });
  });
});
