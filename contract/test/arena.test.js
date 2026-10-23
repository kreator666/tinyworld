// 竞技场(ArenaAccount + ArenaSeason)测试:
//   资金出口收敛(白名单方法级校验/裸转账拒绝) + owner 制衡(freeze/withdraw) + 注册注资拆分 + 结算登记
// 风格对齐 parts-market.test.js(assert + selector 匹配自定义 error)
// 时间处理:一律以链上最新区块时间为基准(evm_setNextBlockTimestamp 单调递增,墙钟会与链时间脱节)
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

const S = (sig) => ethers.id(sig).slice(0, 10); // 方法签名 → 4字节 selector

describe("Arena 竞技场合约", function () {
  let admin, executor, feeRecipient, user1, user2, stranger;
  let usdc, accountImpl, protocol, season;
  const PRINCIPAL = 60n * 10n ** 6n; // 60U
  const FUEL = 9n * 10n ** 6n; // 9U
  const ERC1967 =
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

  const ts = async () => (await ethers.provider.getBlock("latest")).timestamp;
  // 把链时间推到 absoluteTs 之后(绝对时间,单调安全)
  async function travelTo(absoluteTs) {
    const cur = await ts();
    await ethers.provider.send("evm_setNextBlockTimestamp", [Math.max(absoluteTs, cur + 1)]);
    await ethers.provider.send("evm_mine");
  }

  async function deploySeason(opts = {}) {
    const start = opts.start ?? (await ts()) + 3600;
    const end = opts.end ?? start + 100 * 24 * 3600;
    const ArenaSeason = await ethers.getContractFactory("ArenaSeason");
    const impl = await ArenaSeason.deploy();
    const data = impl.interface.encodeFunctionData("initialize", [
      admin.address,
      await usdc.getAddress(),
      await accountImpl.getAddress(),
      executor.address,
      feeRecipient.address,
      opts.principal ?? PRINCIPAL,
      opts.fuel ?? FUEL,
      start,
      end,
    ]);
    const ERC1967Proxy = await ethers.getContractFactory(ERC1967);
    const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), data);
    return ArenaSeason.attach(await proxy.getAddress());
  }

  async function register(season_, user, tokenId = 1n) {
    // 备付幂等处理:每个新赛季合约都需独立 mint+approve
    await usdc.mint(user.address, 10000n * 10n ** 6n);
    await usdc.connect(user).approve(await season_.getAddress(), ethers.MaxUint256);
    const tx = await season_.connect(user).register(tokenId);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((l) => {
        try {
          return season_.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Registered");
    return event.args.account;
  }

  async function deploySeasonWithWhitelist() {
    const s = await deploySeason();
    await s.setAllowedCalls(
      [await protocol.getAddress(), await protocol.getAddress(), await usdc.getAddress()],
      [S("deposit(address,uint256)"), S("withdraw(address,uint256)"), S("approve(address,uint256)")],
      [true, true, true]
    );
    return s;
  }

  const attachAccount = async (addr) => (await ethers.getContractFactory("ArenaAccount")).attach(addr);

  before(async function () {
    [admin, executor, feeRecipient, user1, user2, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    const ArenaAccount = await ethers.getContractFactory("ArenaAccount");
    accountImpl = await ArenaAccount.deploy();
    const MockProtocol = await ethers.getContractFactory("MockProtocol");
    protocol = await MockProtocol.deploy();

    // 默认赛季:1 小时后开始,100 天
    season = await deploySeason();

    // 白名单:MockProtocol.deposit / withdraw;USDC.approve(供协议 transferFrom 扣款)
    await season.setAllowedCalls(
      [await protocol.getAddress(), await protocol.getAddress(), await usdc.getAddress()],
      [S("deposit(address,uint256)"), S("withdraw(address,uint256)"), S("approve(address,uint256)")],
      [true, true, true]
    );

    // 用户注资备付(各赛季累计报名费用远超 69U)
    for (const u of [user1, user2]) {
      await usdc.mint(u.address, 10000n * 10n ** 6n);
      await usdc.connect(u).approve(await season.getAddress(), ethers.MaxUint256);
    }
  });

  it("注册:克隆账户、拆分本金与燃料、记录参赛者", async function () {
    const accountAddr = await register(season, user1, 42n);
    const account = await attachAccount(accountAddr);

    assert.strictEqual(await usdc.balanceOf(accountAddr), PRINCIPAL, "本金应全部进账户");
    assert.strictEqual(await usdc.balanceOf(feeRecipient.address), FUEL, "燃料应进平台燃料池");
    assert.strictEqual(await account.owner(), user1.address);
    assert.strictEqual(await account.executor(), executor.address);
    assert.strictEqual(await account.season(), await season.getAddress());
    assert.strictEqual(await account.phase(), 0n, "新建账户应为 Active");

    const p = await season.participantOf(accountAddr);
    assert.strictEqual(p.owner, user1.address);
    assert.strictEqual(p.agentTokenId, 42n);
    assert.strictEqual(p.principal, PRINCIPAL);
    assert.strictEqual(await season.participantCount(), 1n);
  });

  it("白名单内 execute 成功,头寸变化可核实", async function () {
    const accountAddr = await register(season, user2, 7n);
    const account = await attachAccount(accountAddr);
    await travelTo(Number(await season.startTime()) + 10); // 开赛

    // 先 approve(白名单内),再 deposit
    await account
      .connect(executor)
      .execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("approve", [await protocol.getAddress(), 30n * 10n ** 6n]));
    await account
      .connect(executor)
      .execute(await protocol.getAddress(), 0n, protocol.interface.encodeFunctionData("deposit", [await usdc.getAddress(), 30n * 10n ** 6n]));

    assert.strictEqual(await usdc.balanceOf(accountAddr), 30n * 10n ** 6n, "应剩 30U");
    assert.strictEqual(await protocol.balanceOf(accountAddr), 60n * 10n ** 6n, "应得 2x 份额");
  });

  it("白名单外目标 / 未放行方法一律 revert(含 ERC20 裸转账)", async function () {
    const s = await deploySeasonWithWhitelist();
    const accountAddr = await register(s, user1, 43n);
    const account = await attachAccount(accountAddr);

    // 目标不在白名单
    await expectCustomError(
      account.connect(executor).execute(stranger.address, 0n, "0xdeadbeef"),
      account,
      "CallNotAllowed"
    );
    // USDC 在白名单但 transfer 方法未放行 → agent 间转账/卷款在链上被堵死
    await expectCustomError(
      account
        .connect(executor)
        .execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("transfer", [stranger.address, 10n ** 6n])),
      account,
      "CallNotAllowed"
    );
    // execute 只能由 executor 发起
    await expectCustomError(
      account.connect(stranger).execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("approve", [stranger.address, 1n])),
      account,
      "NotAuthorized"
    );
  });

  it("赛季未开始禁止交易;管理员熔断后禁止新开", async function () {
    const s = await deploySeason(); // 未开赛
    await s.setAllowedCall(await usdc.getAddress(), S("approve(address,uint256)"), true);
    const accountAddr = await register(s, user1, 44n);
    const account = await attachAccount(accountAddr);

    await expectCustomError(
      account
        .connect(executor)
        .execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("approve", [await protocol.getAddress(), 1n])),
      account,
      "TradingClosed"
    );

    // 快进到开赛后可执行
    await travelTo(Number(await s.startTime()) + 10);
    await account
      .connect(executor)
      .execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("approve", [await protocol.getAddress(), 1n]));

    // 管理员熔断
    await s.haltTrading();
    await expectCustomError(
      account
        .connect(executor)
        .execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("approve", [await protocol.getAddress(), 1n])),
      account,
      "TradingClosed"
    );
  });

  it("owner 紧急冻结:execute 停止,结算后 owner 取回剩余", async function () {
    const s = await deploySeasonWithWhitelist();
    const accountAddr = await register(s, user1, 45n);
    const account = await attachAccount(accountAddr);

    // 未结算不能提取
    await expectCustomError(account.connect(user1).withdraw(await usdc.getAddress()), account, "NotSettled");

    // 陌生人不能冻结
    await expectCustomError(account.connect(stranger).freeze(), account, "OwnableUnauthorizedAccount");

    // 冻结 → 任何执行被禁
    await account.connect(user1).freeze();
    assert.strictEqual(await account.phase(), 1n, "应为 Frozen");
    await expectCustomError(
      account
        .connect(executor)
        .execute(await usdc.getAddress(), 0n, usdc.interface.encodeFunctionData("approve", [await protocol.getAddress(), 1n])),
      account,
      "NotActive"
    );

    // 冻结后即可提前结算(退赛路径),owner 取回
    await s.recordResult(accountAddr, 55n * 10n ** 6n);
    assert.strictEqual(await account.phase(), 2n, "应为 Settled");
    assert.strictEqual(await account.settledNavUsd(), 55n * 10n ** 6n);

    const before = await usdc.balanceOf(user1.address);
    await account.connect(user1).withdraw(await usdc.getAddress());
    assert.strictEqual((await usdc.balanceOf(user1.address)) - before, PRINCIPAL, "应取回全部剩余本金");
    assert.strictEqual(await usdc.balanceOf(accountAddr), 0n);
  });

  it("到期结算:未冻结账户在 endTime 后可 recordResult,拒绝提前结算", async function () {
    const start = (await ts()) + 3600;
    const shortSeason = await deploySeason({ start, end: start + 7200 });
    await shortSeason.setAllowedCall(await usdc.getAddress(), S("approve(address,uint256)"), true);
    const accountAddr = await register(shortSeason, user2, 99n);

    // 提前结算被拒
    await expectCustomError(shortSeason.recordResult(accountAddr, PRINCIPAL), shortSeason, "SettlementNotOpen");

    await travelTo(start + 7201);
    await shortSeason.recordResult(accountAddr, 61n * 10n ** 6n);

    const p = await shortSeason.participantOf(accountAddr);
    assert.strictEqual(p.settled, true);
    assert.strictEqual(p.navUsd, 61n * 10n ** 6n);

    // 重复结算被拒
    await expectCustomError(shortSeason.recordResult(accountAddr, 61n * 10n ** 6n), shortSeason, "AlreadySettled");
  });

  it("非参赛者结算被拒 / 开赛后可中途加入 / 赛季结束后不可报名", async function () {
    await expectCustomError(season.recordResult(stranger.address, 1n), season, "NotParticipant");

    // 中途加入:开赛后(未到结束)报名应成功
    const s2 = await deploySeason();
    await travelTo(Number(await s2.startTime()) + 10);
    const midAccount = await register(s2, user1, 77n);
    assert.ok(midAccount, "开赛后报名应成功(中途加入)");

    // 赛季结束后不可报名
    await travelTo(Number(await s2.endTime()) + 10);
    await expectCustomError(s2.connect(user1).register(78n), s2, "RegistrationClosed");
  });

  it("UUPS 升级权限:owner 可升级;陌生人经代理被 Ownable 拦截;直调实现被 onlyProxy 拦截", async function () {
    const ArenaSeason = await ethers.getContractFactory("ArenaSeason");
    const newImpl = await ArenaSeason.deploy();
    const proxy = await ethers.getContractAt("ArenaSeason", await season.getAddress());

    // 陌生人经代理升级 → onlyOwner 拦截
    await expectCustomError(
      proxy.connect(stranger).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      proxy,
      "OwnableUnauthorizedAccount"
    );
    await proxy.upgradeToAndCall(await newImpl.getAddress(), "0x"); // owner 升级不抛错即通过

    // 直接对实现合约调 upgradeToAndCall → onlyProxy 拦截(OZ 5.6 行为)
    const ArenaAccount = await ethers.getContractFactory("ArenaAccount");
    const newAccImpl = await ArenaAccount.deploy();
    await expectCustomError(
      accountImpl.connect(stranger).upgradeToAndCall(await newAccImpl.getAddress(), "0x"),
      accountImpl,
      "UUPSUnauthorizedCallContext"
    );
  });

  it("管理员可提取合约内滞留代币(withdrawFee),陌生人不可", async function () {
    const s = await deploySeasonWithWhitelist();
    const accountAddr = await register(s, user1, 88n);
    // 有人误向赛季合约转入 USDC(模拟极端情况)
    await usdc.connect(user1).transfer(await s.getAddress(), 5n * 10n ** 6n);
    assert.strictEqual(await usdc.balanceOf(await s.getAddress()), 5n * 10n ** 6n, "合约应持有误转入的 USDC");

    // 陌生人不可提取
    await expectCustomError(
      s.connect(stranger).withdrawFee(await usdc.getAddress(), stranger.address, 5n * 10n ** 6n),
      s,
      "OwnableUnauthorizedAccount"
    );
    // owner 提取到指定地址
    const before = await usdc.balanceOf(feeRecipient.address);
    await s.withdrawFee(await usdc.getAddress(), feeRecipient.address, 5n * 10n ** 6n);
    assert.strictEqual((await usdc.balanceOf(feeRecipient.address)) - before, 5n * 10n ** 6n, "owner 应能提取滞留代币");
    assert.strictEqual(await usdc.balanceOf(await s.getAddress()), 0n);
    void accountAddr;
  });

  it("金额可配置:不同赛季可用不同 principal/fuel", async function () {
    const s = await deploySeason({ principal: 100n * 10n ** 6n, fuel: 15n * 10n ** 6n });
    const accountAddr = await register(s, user1, 1n);
    assert.strictEqual(await usdc.balanceOf(accountAddr), 100n * 10n ** 6n);
    assert.strictEqual(await s.principalUsd(), 100n * 10n ** 6n);
    assert.strictEqual(await s.fuelUsd(), 15n * 10n ** 6n);
  });
});
