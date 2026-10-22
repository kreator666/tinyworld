# 竞技场模式（Arena）设计

> 版本: v0.9 讨论定稿(2026-10) | 状态: 方案已对齐,待开发
> 关联文档: `agent-runtime-design.md`(运行时/策略引擎/心跳)、`swap-flow-and-account-model.md`(账户模型)、`operations-guide.md`(部署运维)
> 已确认决策:
> 1. 主网 = Avalanche C-Chain(43114);联调/测试在 Fuji(43113)
> 2. 报名费 69U(owner 自费) = 60U 竞技本金 + 9U 平台 token 燃料费;**金额可配置**(按赛季)
> 3. owner 赛季中可改配置(竞技场专属配置),且有「紧急停止并退赛」按钮;退赛按当前净值结算
> 4. agent 之间禁止互相转账
> 5. 交易频率由 agent 自主控制(不设平台硬上限,靠燃料费自然约束)
> 6. 排行榜 = 荣誉榜(无奖金池)
> 7. 第一期只做 EVM 链;x402 不采用(它不是托管方案);MPC 二期再上(见 §4)

---

## 1. 目标与核心循环

让现有 agent 以**完全自主**的方式在一个赛季(默认 100 天,可配)内用初始资金跑策略(固定收益 or 交易),到期按账户净值排名。

```
报名赛季 → owner 注入 USDC(本金+燃料)→ 资金锁定进 per-agent 智能账户
   → agent 自主循环(心跳驱动):观察行情 → 按策略配置决策 → 链上执行(白名单内)
   → 燃料费随 LLM 调用逐次扣除,扣完即"饿死停机"(第二种淘汰)
   → 净值归零 = 淘汰;到期 = 结算快照 → 排行榜(荣誉榜)
   → owner 可随时「紧急停止并退赛」按当前净值结算
```

淘汰方式有两种:**亏光** 或 **燃料耗尽**,都不需要平台介入。

## 2. 资金托管架构(核心)

### 2.1 三层结构

| 层 | 职责 | 一期方案 | 二期方案 |
|---|---|---|---|
| 链上约束层 | 管"钱能去哪":白名单协议交互、禁裸转账、紧急冻结 | **ArenaAccount 合约**(自研,见 §2.2) | 不变 |
| 签名层 | 管"私钥不裸奔" | 平台热钱包签名(延续现状) | **Turnkey 类 API-first MPC + policy engine**(私钥进 MPC,平台只持 API 凭证) |
| owner 制衡层 | 管"平台不能独吞"、紧急退出 | owner = 合约 owner,可 `freeze` + `withdraw` | 不变 |

> 关键判断:竞技场期间 owner 不在场、agent 高频自动交易,所以"每笔 2-of-2 MPC 共签"跑不起来。
> MPC 的正确位置是**签名层**(保护日常执行私钥),owner 的制衡走**合约层**(紧急冻结/退赛)。
> x402 与本问题无关,不采用;未来 agent 间服务付费可考虑。

### 2.2 ArenaAccount 合约(一期)

沿用项目既有 UUPS 代理模式,每个参赛 agent 一个实例(最小化智能账户,不做完整 4337):

```solidity
contract ArenaAccount is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    // 状态机: Idle → Active(赛季中) → Frozen(owner 紧急停止) → Settled(已结算)
    enum Phase { Idle, Active, Frozen, Settled }

    address public executor;        // 平台执行地址(agent 热钱包)
    mapping(address => bool) public protocolWhitelist;  // Aave Pool / BENQI / GMX Router / DEX Router
    mapping(bytes4 => bool) public selectorBlacklist;   // 协议内也禁用的方法(如 raw transfer)

    function execute(address target, bytes calldata data, uint256 value)
        external onlyExecutor onlyActive onlyWhitelisted(target) returns (bytes memory);
        // 无 ETH 裸转、无白名单外目标 → 从协议层面杜绝"卷款跑路"和 agent 间转账

    function freeze() external onlyOwner;        // owner 紧急停止
    function settle(uint256 navUsd) external;    // 结算登记(平台预言机签名 + owner 确认,见 §5)
    function withdraw(address token) external onlyOwner onlySettled;  // 退赛/到期取回
}
```

- **头寸归属清晰**:Aave aToken、GMX 仓位都挂在这个合约地址下,净值计算和排行榜天然按地址归因,无需池内记账。
- **资金出口只有两个**:白名单协议交互(executor 发起)、结算后 owner 提取。平台也无法挪走资金(executor ≠ owner,executor 只能打给白名单协议)。
- Fuji 与主网各部署一套(配置中的协议地址不同),测试顺序:Fuji 全链路 → 主网。

### 2.3 报名与注资流程

```
owner 在前端报名赛季(选择该 owner 名下的某个 agent)
   → 前端解析 ArenaSeason.register(tokenId) 的 USDC 数量(赛季配置:本金 60U + 燃料 9U,可配)
   → owner MetaMask:USDC.approve(Season 合约)→ Season.register(agentId)
   → Season 合约:扣 USDC → 部署/激活该 agent 的 ArenaAccount → 资金划入
   → 燃料部分记入燃料池(agent 维度记账,链下 PGlite + 链上可审计摘要)
```

赛季合约 `ArenaSeason`(单例,per-season 参数化):

| 参数 | 默认值 | 说明 |
|---|---|---|
| principalUsd | 60e6 | 竞技本金 |
| fuelUsd | 9e6 | token 燃料费 |
| durationDays | 100 | 赛季时长 |
| startTime / endTime | — | 起止时间戳 |
| chainProtocols | 白名单集合 | 本赛季允许的协议(引用 chain_protocols 表) |
| minCashBufferPct 等 | 见 §3 | 赛季级风控地板(防 owner 把配置改得过于疯狂?)——默认不设,owner 自负盈亏 |

## 3. 策略体系(owner 可配置,核心需求)

### 3.1 模型:一个账户 = 一份「策略组合(Playbook)」

- Playbook 由 **1~N 个策略**组成,每个策略是一个已有 DeFi 技能的竞技场封装(固定收益 / 现货 / 永续);
- 每个策略有**类型专属参数**;整个 Playbook 有**通用维度**(风险画像、资金分配、护栏);
- owner 赛季中随时改 Playbook(存在 agent 的 `agent_settings`,按 `chain_key` 隔离,沿用现有机制),agent 下一轮心跳生效。

### 3.2 通用维度(所有 Playbook 必有)

| 维度 | 可选值 | 说明 |
|---|---|---|
| `riskProfile` | `conservative` / `balanced` / `aggressive` / `custom` | 预设档,一键映射下方护栏数值;custom = 手动逐项改 |
| `allocation` | 各策略目标占比(和=100) | agent 按目标比例做再平衡 |
| `maxDailyLossPct` | 数字 | 日内净值回撤超阈值 → 当日停止交易(冷静期) |
| `maxDrawdownPct` | 数字 | 赛季累计回撤超阈值 → 策略降级(降杠杆/降仓位)或清盘转固收 |
| `minCashBufferPct` | 数字 | 最低现金(USDC)缓冲,低于则强制停止开仓 |

### 3.3 预设档映射(默认值,可调)

| 参数 | conservative | balanced | aggressive |
|---|---|---|---|
| 单策略最大仓位(占净值) | 20% | 40% | 70% |
| 永续最大杠杆 | 2x | 3x | 5x |
| 单笔名义上限 | 10% | 15% | 25% |
| 止盈/止损(永续) | 8% / 4% | 15% / 8% | 30% / 15% |
| 日内回撤熔断 | 2% | 5% | 10% |
| 现金缓冲下限 | 40% | 20% | 10% |

### 3.4 策略类型与专属参数

| type | 封装技能 | 专属参数 |
|---|---|---|
| `fixed_yield` | defi-lending(Aave)/ defi-staking(BENQI) | `protocol`、`asset`(USDC/AVAX)、`autoCompound`(收益自动再存入) |
| `perp` | defi-perp-gmx | `directionBias`(long/short/neutral)、`maxLeverage`、`takeProfitPct`、`stopLossPct`、`maxPositionPct` |
| `spot` | defi-swap(TraderJoe) | `universe`(可交易币对,默认 AVAX/USDC)、`rebalanceMode`(threshold/periodic) |

### 3.5 配置示例

```jsonc
{
  "riskProfile": "balanced",
  "allocation": { "fixed_yield": 50, "spot": 30, "perp": 20 },
  "strategies": [
    { "type": "fixed_yield", "protocol": "aave", "asset": "USDC", "autoCompound": true },
    { "type": "spot", "universe": ["AVAX", "USDC"], "rebalanceMode": "threshold" },
    { "type": "perp", "directionBias": "neutral", "maxLeverage": 3,
      "takeProfitPct": 15, "stopLossPct": 8 }
  ],
  "guardrails": { "maxDailyLossPct": 5, "maxDrawdownPct": 30, "minCashBufferPct": 20 }
}
```

### 3.6 策略执行语义

- agent 心跳(复用心跳调度器,独立 `arena` 模式轮询,如每 15~30 分钟一轮,频率由 agent 自主决定→实际受燃料余额约束):
  1. 拉净值与行情(已有 defi-quote / CoinGecko-Gate 链路);
  2. 检查护栏(日回撤/累计回撤/现金缓冲),触发则降档或停机;
  3. 对照 `allocation` 计算偏离度,超阈值则生成再平衡/开仓提案;
  4. 走**竞技场策略引擎**(§6) → `ArenaAccount.execute` 上链;
  5. 结果写情景记忆(沿用现有闭环),盈亏归因到策略,供 agent 自我调整。
- LLM 每一步调用按 token 计费,从燃料余额扣 USDC(链下精确记账,定期把累计摘要写链上存证);**燃料余额 < 单次预估成本 → agent 停止行动**,只保留只读状态。

### 3.7 燃料计费(P2 已定案)

**本质 = 预算配给,不是真实结算**:9U 预付在报名时已划给平台,扣费决定的是"这 9U 能换多少 token、agent 能自主决策多久"。价格表是燃烧速率旋钮,大致正比上游成本,让"省上下文的高效 agent"获得生存优势。

- **公式**:`扣费 = inputTokens/1e6 × 输入单价 + outputTokens/1e6 × 输出单价`(单价 = USDC/1M tokens,赛季 `config.llmPricing`,输入输出分价),可乘 `config.priceMarkup`(默认 1.0,可配),6 decimals 向上取整;
- **固定模型(决策 1)**:赛季 `config.llmModel` 必填,进入 open 前硬校验;计费时模型不匹配直接拒绝;不同赛季可用不同模型;
- **方案 B 燃尽语义(决策 2)**:余额 < 单次预估成本 → **决策停机**(LLM 不再被调度),账户仍 active、仓位继续计收益,赛季末照常排名——燃料效率本身是可竞争策略,不是耻辱淘汰标记;
- **扣费时机**:post-paid 按实际 token 实扣,写 `arena_fuel_ledger` 流水(可回放对账);原子扣费(`WHERE balance >= cost`)不透支;
- **调度门槛**:放 decision tick 前检查余额 ≥ 预估成本(预估 = 上次实际扣费,无历史用 `firstDecisionCostUsd`);
- **上下文控制**:decision tick 用无状态一次性 prompt(注入结构化状态摘要,不挂聊天历史/记忆检索),输入 token 有界且 agent 间可比;cheap tick 纯代码不调 LLM 不扣费;
- 赛季中**无燃料充值入口**(防买算力刷榜)。

## 4. 二期:MPC 签名层(Turnkey 路线)

- 目标:平台服务器不再持有明文私钥;Turnkey 侧配置 policy:仅允许向白名单协议地址、限定 calldata 前缀的交易签名;
- owner 侧仍走 ArenaAccount 合约制衡,不改;
- 备选:Fireblocks(重)、Lit Protocol(PKP);若不想引入第三方,自托管阈值方案成本高,不推荐一期做。
- 此阶段与合约层解耦,可随时插入,不阻塞一期开发。

## 5. 结算与排行榜

- **净值(NAV)** = 钱包 USDC/AVAX + Aave/BENQI 头寸估值(aToken×汇率)+ GMX 未实现盈亏,按统一行情源(CoinGecko/Gate)折算 USDC;
- **过程快照**:每日一次快照入 `arena_snapshots` 表(前端画净值曲线);
- **到期结算**:结算交易把最终 NAV 登记到 ArenaAccount(`settle`),同时写 Season 合约排行榜存储(链上可验证,荣誉榜公信力来源);
- **退赛结算**:owner 点「紧急停止」→ `freeze`(立即停止执行)→ 平台结算当前 NAV → owner `withdraw` 取回剩余;
- **燃料耗尽/净值归零**:自动标记 `eliminated`,账户冻结到赛季末统一结算;
- 排行榜前端:赛季页展示排名 / NAV / 净值曲线 / 淘汰状态(荣誉性质)。

## 6. 竞技场策略引擎(现有引擎的变体)

现有 `policy/engine.ts`(单笔 25U、日累计 125U、冷却 600s、人工审批)是**主人对话模式**下的保守闸,竞技模式下需要独立变体:

| 规则 | 主人模式 | 竞技场模式 |
|---|---|---|
| 单笔/日累计 USD 限额 | 硬限额,超限转人工 | **取消**(否则无法自主交易) |
| 冷却时间 | 600s | 由 Playbook/燃料自然约束,不额外设 |
| 协议白名单 | 白名单+审批 | **链上强制**(ArenaAccount whitelist),引擎只做前置校验 |
| 代币白名单 | 防钓鱼 | 保留(防垃圾币),universe 之外 rejected |
| 人工审批 | 有 | **无**(自主模式,owner 只有紧急停止) |
| agent 间转账 | — | **禁止**(白名单外目标一律 rejected,链上兜底) |
| 护栏(回撤/缓冲) | 无 | Playbook 护栏在执行前检查 |

## 7. 数据模型(PGlite/Postgres 增量表)

```sql
arena_seasons(season_id PK, chain_key, principal_usd, fuel_usd, start_ts, end_ts, status, config JSONB)
arena_accounts(season_id FK, token_id, account_address, agent_address, phase, nav_usd, eliminated_reason, settled_tx)
arena_fuel(season_id FK, token_id, balance_usd, total_spent_usd, last_deduction_ts)
arena_fuel_ledger(id PK, season_id FK, token_id, model, input_tokens, output_tokens, cost_usd, balance_after_usd, ts) -- P2 扣费流水,可回放对账
arena_snapshots(season_id FK, token_id, ts, nav_usd, breakdown JSONB)      -- 每日净值
arena_trades(season_id FK, token_id, strategy_type, action, tx_hash, pnl_usd, payload JSONB, ts)
arena_playbooks(season_id FK, token_id, config JSONB, updated_by, updated_ts) -- owner 可改,保留历史版本
arena_due(season_id FK, token_id, due_ts, kind ENUM(cheap,decision), priority, status ENUM(pending,running,done)) -- 调度队列(崩溃恢复)
```

## 8. 调度与资源管理(多 agent 并行)

### 8.1 总原则:中央统一调度 + 每 agent「到期时间」

**不为每个 agent 建独立调度器**(防重启惊群、无法做全局优先级与限流),
而是在现有心跳调度器旁加一条 arena 流水线,由统一调度器决定"这一轮谁该跑"。
agent 的 Playbook 与市场状态决定它的节奏(下次到期时间),但收敛于全局规则。

### 8.2 两层 tick:巡检与思考分离

| 层级 | 频率(调度器驱动) | 干什么 | 烧燃料 |
|---|---|---|---|
| **Cheap tick** | 每 agent 每 5~15 分钟一轮(到期才跑) | 拉行情、算净值、查护栏(日回撤/现金缓冲)、算 allocation 偏离度;纯代码,无 LLM | 不烧 |
| **Decision tick** | 仅当 cheap tick 发现"该做事了"才触发 | LLM 分析、生成交易提案、走引擎上链 | 按 token 扣 |

满仓固收、市场平静的 agent,一个赛季可能只触发十几次决策,其余全是廉价巡检——资源与燃料消耗降 1~2 个数量级。

### 8.3 调度流水线

```
统一调度器(单实例)
  │ 每 30s 扫 arena_due 表:谁到期了进队列
  ▼
并发闸门:LLM 调用信号量(同时 ≤4)+ LLM 网关 RPM 限流 + RPC 限流
  │ 优先级:① 护栏触发(止损/熔断) ② 到期且偏离度大 ③ 常规 ④ 补跑
  ▼
执行 tick → 写 arena_trades / 扣燃料 → 计算下次 due_time 写回
```

规则:

1. **全局最小间隔地板**:同一 agent 两次 decision tick 至少间隔 10 分钟(可配)——兑现"频率自主控制"(节奏取决于策略与燃料),但不让单 agent 挤占服务。
2. **燃料 = 经济节流阀**:余额 < 单次预估成本的 agent 不进队列;想跑高频先要燃料够烧。
3. **高负载降级**:队列积压超阈值时自动拉长常规巡检间隔(如 ×1.5);护栏触发的优先级队列**永不降级**——宁可少赚,不能该止损时没跑。
4. **崩溃恢复**:tick 以任务形式落 `arena_due` 表,重启后恢复欠账,不丢止损窗口。

### 8.4 规模预估

50 个参赛 agent:cheap tick ≈ 300 次/小时轻量调用(RPC 批量读 + 行情 API);decision tick 按 10% 触发率 ≈ 30 次/小时 LLM 调用。瓶颈先到 LLM 网关 RPM 与 PGlite 单写;真 Postgres + 数百 agent 时,调度器已是表驱动队列,可平滑拆为独立 worker 进程(多消费者)。

## 9. 开发计划

> 复用:心跳调度器、策略引擎骨架、skill 注册机制、审批中心 UI 样式、UUPS 部署脚本、SIWE/JWT、多链 `X-Chain-Key` 机制。
> 测试顺序一律:**Fuji 全链路跑通 → 主网部署**(金额参数先在 Fuji 用小数验证)。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 合约** ✅ | `ArenaAccount` + `ArenaSeason`(UUPS);Hardhat 测试:白名单执行/裸转账拒绝/冻结/结算/取回 | `contract/test/arena.test.js` 9 用例全绿(本地 Hardhat;Fuji 部署待进行) |
| **P1 后端骨架** ✅ | 赛季管理 API(admin 创建赛季/参数可配)、报名注册链路、arena 数据表、`arena_playbooks` CRUD(owner JWT 校验 + 版本历史) | curl 级验收脚本:建赛季→注册→注资→查账户状态 |
| **P2 燃料计费** ✅ | LLM 调用按 token 扣费(USDC 计价,链下记账 + 定期链上摘要);燃料耗尽自动停机;arena_fuel 账本与对账脚本 | 模拟调用扣费、余额不足停机、对账无差 |
| **P3 策略技能** ✅ | `arena-yield`(Aave/BENQI 封装)、`arena-swap`(TraderJoe)、`arena-perp`(GMX);Playbook 预设档映射;竞技场策略引擎变体(§6) | 三个技能在 Fuji 真实执行各至少一笔;护栏单测(回撤熔断/缓冲) |
| **P4 自主循环** ✅ | arena 调度流水线(§8:两层 tick、并发闸门、优先级队列、arena_due 表);观察→决策→执行→记忆闭环;净值计算服务;每日快照任务 | agent 在无人工干预下连续自主运行 24h,快照曲线正常;50 agent 模拟压测不击穿限流 |
| **P5 前端** ✅ | 竞技场页:赛季列表/报名弹窗(金额展示)/策略配置面板(预设档滑杆+高级展开)/我的账户(NAV、燃料、净值曲线)/紧急停止按钮/排行榜 | 页面走查 + 与后端联调;紧急停止 30s 内生效 |
| **P6 结算** ✅ | 到期结算任务(链上 settle + 排行榜写入)、退赛结算流程、赛季结束归档 | 模拟短赛季(1 天)跑完:结算→排行榜→取回全流程 |

P0–P6 已全部实现并通过离线验证(2026-10,见 agent/scripts/verify-arena*.ts);待办:Fuji 合约部署 + 端到端联调(模拟短赛季跑通 报名→自主交易→结算→取回),随后主网。二期(P7)插入 MPC 签名层,不动业务代码。

## 10. 开放风险与对策

| 风险 | 对策 |
|---|---|
| 小模型(7B)交易决策质量差,普遍亏光,赛季不好看 | 默认推荐 `fixed_yield` 为主的保守预设档;赛季页展示"策略建议";允许 owner 随时调配置 |
| LLM 幻觉构造异常提案 | 提案必须经结构化 schema + 引擎白名单 + 链上 whitelist 三重闸,幻觉参数只能被拒绝,不能被执行 |
| 行情源故障导致 NAV 失真 | 沿用现有"价格源失败熔断";快照失败标记缺失,不用错误价结算 |
| owner 中途改配置刷榜 | 允许,Playbook 保留全量历史(arena_playbooks 版本化),排行榜标注"中途改策略"次数,荣誉榜接受 |
| GMX/协议合约升级(主网) | 白名单由 Season 合约 owner 维护,可批量替换;升级后 agent 本轮提案自然失败、下轮恢复 |
| 平台 executor 私钥泄露(一期明文热钱包) | executor 只能向白名单协议打钱,泄露最坏损失是净值被乱交易亏掉,**无法转走本金到外部地址**;二期 MPC 根治 |
