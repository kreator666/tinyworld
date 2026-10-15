// 装备铸造直售市场(PartsMarket)测试:P2C 铸造直售 + maxSupply 硬顶防超卖 + 多付少付拒付
// 风格对齐 starter-claim.test.js(assert + selector 匹配自定义 error)
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

describe("PartsMarket 装备铸造直售市场", function () {
  let owner, buyer, stranger;
  let parts, identity, market;
  let partsAddr, marketAddr;
  const HEAD = 1001n, BODY = 2001n, ACC = 3001n, PET = 4001n;
  const PRICE = ethers.parseEther("0.01");

  before(async function () {
    [owner, buyer, stranger] = await ethers.getSigners();

    const DIDParts = await ethers.getContractFactory("DIDParts");
    parts = await DIDParts.deploy("https://api.didaiverse.example/parts/{id}.json");
    await parts.waitForDeployment();
    partsAddr = await parts.getAddress();

    const DIDIdentity = await ethers.getContractFactory("DIDIdentity");
    identity = await DIDIdentity.deploy("DID AI Verse Identity", "DIDAI", "https://api.didaiverse.example/metadata/did/", "https://api.didaiverse.example/metadata/contract.json");
    await identity.waitForDeployment();

    const PartsMarket = await ethers.getContractFactory("PartsMarket");
    market = await PartsMarket.deploy(partsAddr);
    await market.waitForDeployment();
    marketAddr = await market.getAddress();

    // 注册装备(ACC 用小 maxSupply 验证硬顶)
    await parts.registerPart(HEAD, 0, 0, 10000);
    await parts.registerPart(BODY, 1, 0, 10000);
    await parts.registerPart(ACC, 2, 0, 3); // maxSupply=3,买第 4 份必 revert
    await parts.registerPart(PET, 3, 0, 10000);
  });

  it("部署后状态正确;未授权 minter 时 buy revert NotMinter", async function () {
    assert.strictEqual(await market.parts(), partsAddr);
    assert.strictEqual(await market.owner(), owner.address);
    assert.strictEqual(await market.listPriceOf(HEAD), 0n);
    await market.setPrice(HEAD, PRICE);
    await expectCustomError(market.connect(buyer).buy(HEAD, 1, { value: PRICE }), parts, "NotMinter");
  });

  it("setMinter 授权后 buy 成功:balance 增加、合约余额累计、emit Sold", async function () {
    await parts.setMinter(marketAddr, true);
    const receipt = await (await market.connect(buyer).buy(HEAD, 2, { value: PRICE * 2n })).wait();
    const events = receipt.logs
      .map((l) => {
        try {
          return market.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const sold = events.find((e) => e.name === "Sold");
    assert.ok(sold, "应 emit Sold 事件");
    assert.strictEqual(sold.args.buyer, buyer.address);
    assert.strictEqual(sold.args.id, HEAD);
    assert.strictEqual(sold.args.quantity, 2n);
    assert.strictEqual(sold.args.price, PRICE);

    assert.strictEqual(await parts.balanceOf(buyer.address, HEAD), 2n);
    assert.strictEqual(await ethers.provider.getBalance(marketAddr), PRICE * 2n);
  });

  it("未上架 revert NotListed;下架后同样 revert", async function () {
    await expectCustomError(market.connect(buyer).buy(BODY, 1, { value: PRICE }), market, "NotListed");
    await market.setPrice(BODY, PRICE); // 上架
    await market.setPrice(BODY, 0); // 下架
    await expectCustomError(market.connect(buyer).buy(BODY, 1, { value: PRICE }), market, "NotListed");
  });

  it("价格不符 revert WrongValue:多付少付都 revert,精确等值才通过", async function () {
    await market.setPrice(BODY, PRICE);
    await expectCustomError(market.connect(buyer).buy(BODY, 1, { value: PRICE - 1n }), market, "WrongValue");
    await expectCustomError(market.connect(buyer).buy(BODY, 1, { value: PRICE + 1n }), market, "WrongValue");
    await expectCustomError(market.connect(buyer).buy(BODY, 2, { value: PRICE }), market, "WrongValue"); // 数量×单价不符
    await market.connect(buyer).buy(BODY, 2, { value: PRICE * 2n }); // 精确等值 OK
    assert.strictEqual(await parts.balanceOf(buyer.address, BODY), 2n);
  });

  it("maxSupply 硬顶封顶:小 maxSupply 装备买超 revert", async function () {
    await market.setPrice(ACC, PRICE);
    // maxSupply=3,先买 3 份
    await market.connect(buyer).buy(ACC, 3, { value: PRICE * 3n });
    assert.strictEqual(await parts["totalSupply(uint256)"](ACC), 3n);
    // 第 4 份触发 mintPart 的 MaxSupplyExceeded,整笔回滚(含退款)
    await expectCustomError(market.connect(buyer).buy(ACC, 1, { value: PRICE }), parts, "MaxSupplyExceeded");
    assert.strictEqual(await ethers.provider.getBalance(marketAddr), PRICE * 7n, "超卖失败不应增加合约余额");
  });

  it("mintable=false 的装备 revert PartNotMintable", async function () {
    await parts.setPartMintable(PET, false);
    await market.setPrice(PET, PRICE);
    await expectCustomError(market.connect(buyer).buy(PET, 1, { value: PRICE }), parts, "PartNotMintable");
    await parts.setPartMintable(PET, true); // 恢复
  });

  it("quantity=0 revert InvalidQuantity", async function () {
    await expectCustomError(market.connect(buyer).buy(HEAD, 0, { value: 0 }), market, "InvalidQuantity");
  });

  it("非 owner setPrice/withdraw revert NotOwner", async function () {
    await expectCustomError(market.connect(stranger).setPrice(HEAD, PRICE), market, "NotOwner");
    await expectCustomError(market.connect(stranger).withdraw(), market, "NotOwner");
  });

  it("withdraw:owner 提走全部余额", async function () {
    const before = await ethers.provider.getBalance(owner.address);
    const rc = await (await market.withdraw()).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const after = await ethers.provider.getBalance(owner.address);
    assert.strictEqual(after - before + gas, PRICE * 7n, "owner 应收到全部销售额");
    assert.strictEqual(await ethers.provider.getBalance(marketAddr), 0n);
  });

  it("setPrices 批量上架/改价,等长校验", async function () {
    await expectCustomError(market.setPrices([HEAD, BODY], [PRICE]), market, "InvalidPrice");
    await market.setPrices([HEAD, BODY, PET], [PRICE, PRICE * 2n, 0]);
    assert.strictEqual(await market.listPriceOf(HEAD), PRICE);
    assert.strictEqual(await market.listPriceOf(BODY), PRICE * 2n);
    assert.strictEqual(await market.listPriceOf(PET), 0n, "price=0 即下架");
    const receipt = await (await market.setPrice(HEAD, PRICE)).wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return market.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .find((e) => e.name === "PriceUpdated");
    assert.ok(ev, "改价应 emit PriceUpdated");
  });
});
