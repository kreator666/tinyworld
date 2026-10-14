// 新手装备免费领养(StarterPartClaim, A 方案 v2)端到端测试
// 覆盖: 正常领取 / 二次领取 / 无 DID / 池外 id / maxSupply 硬顶 / 未授权 minter
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

// 新手池: 头/身/配饰/宠物 各一件普通装(与 seed.js 的演示配件一致)
const POOL = [1001n, 2001n, 3001n, 4001n];
const HEAD = 1001n, BODY = 2001n, ACC = 3001n, PET = 4001n;

describe("StarterPartClaim 新手装备免费领养", function () {
  let owner, alice, bob, carol;
  let parts, identity, claim;
  let partsAddr, identityAddr, claimAddr;

  before(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

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
    claim = await StarterPartClaim.deploy(partsAddr, identityAddr, POOL);
    await claim.waitForDeployment();
    claimAddr = await claim.getAddress();

    // 注册池内 4 件装备(ACC 用很小的 maxSupply 验证硬顶;名称唯一)
    await parts.registerPart(HEAD, 0, 0, 10000);
    await parts.registerPart(BODY, 1, 0, 10000);
    await parts.registerPart(ACC, 2, 0, 2); // 只有 2 份,验证领满后 revert MaxSupplyExceeded
    await parts.registerPart(PET, 3, 0, 10000);
  });

  it("部署后 pool() 与只读状态正确", async function () {
    const pool = await claim.pool();
    assert.deepStrictEqual([...pool].map(Number), POOL.map(Number));
    assert.strictEqual(await claim.parts(), partsAddr);
    assert.strictEqual(await claim.identity(), identityAddr);
    assert.strictEqual(await claim.claimed(alice.address), false);
  });

  it("未授权 minter 时 claim 应 revert NotMinter", async function () {
    await identity.connect(alice).mint("StarterAlice", "");
    await expectCustomError(claim.connect(alice).claim(HEAD), parts, "NotMinter");
  });

  it("owner setMinter 授权后正常领取:balanceOf=1,claimed=true,emit Claimed", async function () {
    await parts.setMinter(claimAddr, true);

    const tx = await claim.connect(alice).claim(HEAD);
    const receipt = await tx.wait();
    const events = receipt.logs
      .map((l) => {
        try {
          return claim.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const ev = events.find((e) => e.name === "Claimed");
    assert.ok(ev, "应 emit Claimed 事件");
    assert.strictEqual(ev.args.account, alice.address);
    assert.strictEqual(ev.args.partId, HEAD);

    assert.strictEqual(await parts.balanceOf(alice.address, HEAD), 1n);
    assert.strictEqual(await claim.claimed(alice.address), true);
  });

  it("同一地址二次领取应 revert AlreadyClaimed", async function () {
    await expectCustomError(claim.connect(alice).claim(BODY), claim, "AlreadyClaimed");
  });

  it("无 DID 的地址领取应 revert NoIdentity", async function () {
    await expectCustomError(claim.connect(bob).claim(BODY), claim, "NoIdentity");
  });

  it("池外 id 应 revert NotInPool", async function () {
    await identity.connect(bob).mint("StarterBob", "");
    await expectCustomError(claim.connect(bob).claim(9999n), claim, "NotInPool");
    // 已注册但不在池内的 id 同样拒绝
    await parts.registerPart(5001, 0, 0, 100);
    await expectCustomError(claim.connect(bob).claim(5001n), claim, "NotInPool");
  });

  it("maxSupply 硬顶仍然生效:领满后下一次 revert MaxSupplyExceeded", async function () {
    // ACC maxSupply=2:bob 领第 1 份,carol 领第 2 份,第 3 个地址应触顶
    await identity.connect(carol).mint("StarterCarol", "");
    const [, , , , dave] = await ethers.getSigners();
    await identity.connect(dave).mint("StarterDave", "");

    await claim.connect(bob).claim(ACC);
    await claim.connect(carol).claim(ACC);
    assert.strictEqual(await parts["totalSupply(uint256)"](ACC), 2n);

    // dave 有 DID、未领取、id 在池内,但供应量已满 -> 透传 DIDParts 的 MaxSupplyExceeded,且 claimed 不置位
    await expectCustomError(claim.connect(dave).claim(ACC), parts, "MaxSupplyExceeded");
    assert.strictEqual(await claim.claimed(dave.address), false);
  });

  it("每个地址限领一次:carol 换池内其他 id 也应 revert AlreadyClaimed", async function () {
    await expectCustomError(claim.connect(carol).claim(PET), claim, "AlreadyClaimed");
  });
});
