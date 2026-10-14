// 新手大礼包 v2(StarterPartClaim)端到端测试:随机四件套 + 一键自动穿戴 + equipBatch
// 覆盖: 正常领取(授权齐全自动穿上)/ 未授权托管( dressed=false 装备落钱包 )/ 二次领取 /
//       无 DID / 未授权 minter / maxSupply 硬顶 / equipBatch 批量与 operator 语义
// 注意: 环境未安装 hardhat-chai-matchers,custom error 断言复用 full-flow.test.js 的 selector 匹配实现
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

// 随机池区间:头 1001-1008 / 身 2001-2008 / 配饰 3001-3008 / 宠物 4001-4008
const RANGES = [
  [1001n, 1008n],
  [2001n, 2008n],
  [3001n, 3008n],
  [4001n, 4008n],
];
const SLOT_NAMES = ["头", "身", "配饰", "宠物"];

/** 断言 4 个 id 逐槽落在对应区间内 */
function assertPackInRanges(ids) {
  assert.strictEqual(ids.length, 4);
  for (let i = 0; i < 4; i++) {
    const [lo, hi] = RANGES[i];
    assert.ok(ids[i] >= lo && ids[i] <= hi, `${SLOT_NAMES[i]}槽 id ${ids[i]} 应在 [${lo}, ${hi}]`);
  }
}

describe("StarterPartClaim 新手大礼包 v2 + equipBatch", function () {
  let owner, alice, bob, carol, dave, operator;
  let parts, identity, claim;
  let partsAddr, identityAddr, claimAddr;

  before(async function () {
    [owner, alice, bob, carol, dave, operator] = await ethers.getSigners();

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

    const StarterPartClaim = await ethers.getContractFactory("StarterPartClaim");
    claim = await StarterPartClaim.deploy(partsAddr, identityAddr);
    await claim.waitForDeployment();
    claimAddr = await claim.getAddress();

    // 配件合约加入身份合约白名单
    await identity.setCollectionApproved(partsAddr, true);

    // 注册随机池 32 件:头/身/宠物大供应量;配饰 maxSupply=5(留给硬顶测试顶格)
    for (let base of [1001n, 2001n, 4001n]) {
      for (let r = 0n; r < 8n; r++) await parts.registerPart(base + r, Number(base / 1000n) - 1, 0, 10000);
    }
    for (let r = 0n; r < 8n; r++) await parts.registerPart(3001n + r, 2, 0, 5);
  });

  /** 解析 StarterPackClaimed 事件,返回 { ids, dressed } */
  async function parsePackEvent(receipt) {
    const events = receipt.logs
      .map((l) => {
        try {
          return claim.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const ev = events.find((e) => e.name === "StarterPackClaimed");
    assert.ok(ev, "应 emit StarterPackClaimed 事件");
    return { ids: [...ev.args.partIds], dressed: ev.args.dressed };
  }

  it("部署后只读状态正确", async function () {
    assert.strictEqual(await claim.parts(), partsAddr);
    assert.strictEqual(await claim.identity(), identityAddr);
    assert.strictEqual(await claim.claimed(alice.address), false);
  });

  it("未授权 minter 时 claimPack 应 revert NotMinter", async function () {
    await identity.connect(alice).mint("PackAlice", "");
    await expectCustomError(claim.connect(alice).claimPack(), parts, "NotMinter");
  });

  it("授权齐全:claimPack 随机 4 件套并自动穿戴(dressed=true)", async function () {
    await parts.setMinter(claimAddr, true);
    const tokenId = await identity.tokenIdOf(alice.address);

    // 两个授权:配件托管 + identity 授权 claim 代为换装
    await parts.connect(alice).setApprovalForAll(identityAddr, true);
    await identity.connect(alice).approve(claimAddr, tokenId);

    const receipt = await (await claim.connect(alice).claimPack()).wait();
    const { ids, dressed } = await parsePackEvent(receipt);
    assertPackInRanges(ids);
    assert.strictEqual(dressed, true, "授权齐全时应自动穿戴成功");
    assert.strictEqual(await claim.claimed(alice.address), true);

    // 四槽全部就位,托管在 identity 合约
    const equipped = await identity.getEquipped(tokenId);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(equipped[i].collection, partsAddr, `${SLOT_NAMES[i]}槽应已装备`);
      assert.strictEqual(equipped[i].id, ids[i]);
      assert.strictEqual(await parts.balanceOf(alice.address, ids[i]), 0n, "已托管,用户余额应为 0");
      assert.strictEqual(await parts.balanceOf(identityAddr, ids[i]), 1n, "identity 合约应持有该件");
    }
  });

  it("无托管授权:claimPack 成功但 dressed=false,装备留在钱包", async function () {
    await identity.connect(bob).mint("PackBob", "");
    const tokenId = await identity.tokenIdOf(bob.address);

    const receipt = await (await claim.connect(bob).claimPack()).wait();
    const { ids, dressed } = await parsePackEvent(receipt);
    assertPackInRanges(ids);
    assert.strictEqual(dressed, false, "未授权托管,穿戴应失败但不 revert");

    const equipped = await identity.getEquipped(tokenId);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(equipped[i].collection, ethers.ZeroAddress, `${SLOT_NAMES[i]}槽应为空`);
      assert.strictEqual(await parts.balanceOf(bob.address, ids[i]), 1n, "装备应留在用户钱包");
    }
  });

  it("已授权托管但 identity 未授权 claim:同样 dressed=false", async function () {
    await identity.connect(carol).mint("PackCarol", "");
    await parts.connect(carol).setApprovalForAll(identityAddr, true); // 只批准托管,不 approve claim
    const tokenId = await identity.tokenIdOf(carol.address);

    const receipt = await (await claim.connect(carol).claimPack()).wait();
    const { dressed } = await parsePackEvent(receipt);
    assert.strictEqual(dressed, false, "claim 不是 operator,自动穿戴应失败");
    const equipped = await identity.getEquipped(tokenId);
    assert.strictEqual(equipped[0].collection, ethers.ZeroAddress);
  });

  it("二次领取应 revert AlreadyClaimed", async function () {
    await expectCustomError(claim.connect(alice).claimPack(), claim, "AlreadyClaimed");
  });

  it("无 DID 的地址领取应 revert NoIdentity", async function () {
    const [, , , , , , stranger] = await ethers.getSigners();
    await expectCustomError(claim.connect(stranger).claimPack(), claim, "NoIdentity");
  });

  it("maxSupply 硬顶仍然生效:配饰池顶格后领取 revert MaxSupplyExceeded 且不置位", async function () {
    // 把 3001-3008 全部顶到 maxSupply(5):不管随机到哪件配饰都必然超限
    for (let r = 0n; r < 8n; r++) {
      const id = 3001n + r;
      const total = await parts["totalSupply(uint256)"](id);
      const remain = 5n - total;
      if (remain > 0n) await parts.mintPart(owner.address, id, remain);
      assert.strictEqual(await parts["totalSupply(uint256)"](id), 5n);
    }

    await identity.connect(dave).mint("PackDave", "");
    await parts.connect(dave).setApprovalForAll(identityAddr, true);
    await expectCustomError(claim.connect(dave).claimPack(), parts, "MaxSupplyExceeded");
    assert.strictEqual(await claim.claimed(dave.address), false, "revert 后不应置位 claimed");
  });
});

// 独立套件:mocha 在同一 suite 内先跑完全部 it 再跑嵌套 describe,
// equipBatch 测试依赖未顶格的供应量,故单独部署一套合约
describe("DIDIdentity equipBatch 批量换装与 operator 语义", function () {
  let owner, user, operator, parts, identity;
  let partsAddr, identityAddr;
  let tokenId;
  const HEAD = 1001n, BODY = 2001n, ACC = 3001n, PET = 4001n;

  before(async function () {
    [owner, user, operator] = await ethers.getSigners();
    const DIDParts = await ethers.getContractFactory("DIDParts");
    parts = await DIDParts.deploy("https://api.didaiverse.example/parts/{id}.json");
    await parts.waitForDeployment();
    partsAddr = await parts.getAddress();

    const DIDIdentity = await ethers.getContractFactory("DIDIdentity");
    identity = await DIDIdentity.deploy("DID AI Verse Identity", "DIDAI", "https://api.didaiverse.example/metadata/did/", "https://api.didaiverse.example/metadata/contract.json");
    await identity.waitForDeployment();
    identityAddr = await identity.getAddress();

    await identity.setCollectionApproved(partsAddr, true);
    await parts.registerPart(HEAD, 0, 0, 10000);
    await parts.registerPart(1002n, 0, 0, 10000);
    await parts.registerPart(1003n, 0, 0, 10000);
    await parts.registerPart(BODY, 1, 0, 10000);
    await parts.registerPart(2002n, 1, 0, 10000);
    await parts.registerPart(ACC, 2, 0, 10000);
    await parts.registerPart(PET, 3, 0, 10000);
    await parts.registerPart(4002n, 3, 0, 10000);

    await identity.connect(user).mint("BatchUser", "");
    tokenId = await identity.tokenIdOf(user.address);
    // 发 4 件装备(每槽一件)
    await parts.mintPart(user.address, HEAD, 1);
    await parts.mintPart(user.address, BODY, 1);
    await parts.mintPart(user.address, ACC, 1);
    await parts.mintPart(user.address, PET, 1);
    await parts.connect(user).setApprovalForAll(identityAddr, true);
  });

  it("owner equipBatch 一次穿 4 件", async function () {
    await identity.connect(user).equipBatch(
      tokenId,
      [0, 1, 2, 3],
      [partsAddr, partsAddr, partsAddr, partsAddr],
      [HEAD, BODY, ACC, PET]
    );
    const equipped = await identity.getEquipped(tokenId);
    assert.deepStrictEqual(
      equipped.map((e) => e.id),
      [HEAD, BODY, ACC, PET]
    );
    assert.strictEqual(await parts.balanceOf(identityAddr, PET), 1n);
  });

  it("数组长度不匹配/空数组应 revert", async function () {
    await expectCustomError(
      identity.connect(user).equipBatch(tokenId, [0], [partsAddr, partsAddr], [HEAD, BODY]),
      identity,
      "ArrayLengthMismatch"
    );
    await expectCustomError(
      identity.connect(user).equipBatch(tokenId, [], [], []),
      identity,
      "InvalidBatchLength"
    );
  });

  it("getApproved 单 token 授权的 operator 可 equip / equipBatch 换装", async function () {
    // 换一套新装备(同槽换新件,旧件自动退回 user)
    await parts.mintPart(user.address, 1002n, 1);
    await parts.mintPart(user.address, 2002n, 1);
    await identity.connect(user).approve(operator.address, tokenId); // 单 token 授权

    await identity.connect(operator).equip(tokenId, 0, partsAddr, 1002n);
    let equipped = await identity.getEquipped(tokenId);
    assert.strictEqual(equipped[0].id, 1002n);
    assert.strictEqual(await parts.balanceOf(user.address, HEAD), 1n, "旧头件应退回 user");

    await identity.connect(operator).equipBatch(tokenId, [1], [partsAddr], [2002n]);
    equipped = await identity.getEquipped(tokenId);
    assert.strictEqual(equipped[1].id, 2002n);
  });

  it("isApprovedForAll 授权的 operator 也可 equipBatch", async function () {
    await parts.mintPart(user.address, 4002n, 1);
    await identity.connect(user).approve(ethers.ZeroAddress, tokenId); // 清掉单 token 授权
    await identity.connect(user).setApprovalForAll(operator.address, true);
    await identity.connect(operator).equipBatch(tokenId, [3], [partsAddr], [4002n]);
    const equipped = await identity.getEquipped(tokenId);
    assert.strictEqual(equipped[3].id, 4002n);
  });

  it("未授权第三方 equip/equipBatch 应 revert NotTokenOwner", async function () {
    const third = await ethers.getSigners().then((s) => s[8]);
    await parts.mintPart(user.address, 1003n, 1);
    await expectCustomError(identity.connect(third).equip(tokenId, 0, partsAddr, 1003n), identity, "NotTokenOwner");
    await expectCustomError(
      identity.connect(third).equipBatch(tokenId, [0], [partsAddr], [1003n]),
      identity,
      "NotTokenOwner"
    );
  });

  it("operator 不可 unequip(仍仅 owner);owner unequip 正常", async function () {
    await expectCustomError(identity.connect(operator).unequip(tokenId, 0), identity, "NotTokenOwner");
    await identity.connect(user).unequip(tokenId, 0);
    const equipped = await identity.getEquipped(tokenId);
    assert.strictEqual(equipped[0].collection, ethers.ZeroAddress);
    assert.strictEqual(await parts.balanceOf(user.address, 1002n), 1n, "卸下应退回 user");
  });
});
