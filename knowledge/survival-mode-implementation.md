# 生存模式(Survival Mode)实现文档

> 立项:2026-11 | 状态:M1–M3 代码完成,待真实环境联调 | 依赖:`knowledge/near-ai-cloud-notes.md`(NEAR AI Cloud 调研,§12 有 spike 记录)、`knowledge/arena-mode-design.md`(架构母版)
> 玩法:NEAR DID agent = 电子宠物。平台垫资 NEAR → Meta Pool 流动质押 → 收益换算力(credits)→ 玩家点画布物品(喂食/打扫/打工/治疗)→ agent 用 NEAR AI LLM 决策在 NEAR DeFi 真实执行赚钱 → 再质押/充值,维持算力不断档。算力耗尽 = 休眠,虚弱 24h = 死亡(记次数,0.5 NEAR 复活费,收益不够则 demo 免费)。

## 1. 已定案的玩法参数

| 项 | 值 |
|----|----|
| 链 | 仅 near-mainnet(质押)/ near-testnet(Burrow 替身模拟) |
| 领养本金 | 1 / 2 / 5 NEAR 三档(平台热钱包垫资) |
| 衰减 | 饱食 48h 归零(0 → weak);清洁 72h;vitality=0 时衰减 ×1.5;weak 持续 24h → dead;mood=f(饱食,清洁),弱/死封顶 50 |
| 动作加成 | feed +25 饱食/+5 心情;clean +25 清洁/+5 心情;work −5 生命/+10 心情(pnl 允许为负);heal +20 生命/+15 饱食(yield 按 NEAR 价折算成 credits) |
| 冷却 | feed/clean 5min,work 15min(按动作独立记) |
| 复活 | 0.5 NEAR 从 earnings 扣(不足 demo-waived),四维重置 60,death_count 保留 |
| 决策模型 | `z-ai/glm-5.3-flash`(env 可改);一次决策 ≈ $0.00041(2026-11 价) |
| credits 制 | 平台账本(USD 两位小数),非 NEAR AI org 真余额;burn 按 `/v1/models` 实时价 × 实际 token,拉取失败回落 $0.001 |
| 资金安全 | 执行目标硬编码映射(refExchange/burrow/metapool),LLM 无法指定任意地址,无裸转账出口 |

## 2. 代码地图

### 后端 `agent/`

| 文件 | 职责 |
|------|------|
| `src/config.ts`(改) | config.survival 段:SURVIVAL_ENABLED、SURVIVAL_PRINCIPAL_CHOICES、SURVIVAL_LLM_BASE_URL/API_KEY/MODEL、SURVIVAL_NEARAI_BASE_URL、SURVIVAL_META_POOL_CONTRACT、衰减/冷却参数 |
| `src/db/index.ts`(改) | initSchema 加 3 表:survival_pets / survival_actions / survival_ledger |
| `src/db/survival.ts` | CRUD(NUMERIC 字符串往返,仿 db/arena.ts) |
| `src/chain/metapool.ts` | Meta Pool `deposit_and_stake`(payable)/`ft_balance_of`/`get_st_near_price`;testnet 自动分发 Burrow supply wNEAR(wrap.testnet) |
| `src/core/survivalCredits.ts` | 原子 burnCredits、topupCredits、/v1/models 定价缓存(5min TTL)、healConvert |
| `src/core/survivalThinker.ts` | 无状态决策 prompt + 纯函数校验器 parsePlan/validateStep(非法 → NOOP_PLAN);onUsage 按实际用量扣 credits |
| `src/core/survivalExecutor.ts` | checkStepAllowed(协议可用性/代币白名单/单笔 ≤ maxSingleYocto)+ 逐步执行,失败不中断记 partial |
| `src/core/survival.ts` | 服务层:computeDecay(纯函数)、adoptPet、doAction、revivePet、getState/toDto、leaderboard;SurvivalError(status) |
| `src/core/survivalScheduler.ts` | 每 survivalTickSeconds(默认 60s):applyDecay 物化 → 每小时收益快照(池子收益按本金分摊,游标 settings.lastYieldAt)→ dormant 判定。纯代码不烧 credits |
| `src/core/llm.ts`(改) | CompleteOptions 加可选 baseUrl/apiKey(向后兼容) |
| `src/index.ts`(改) | 8 条路由 + main() 启停调度器 + SurvivalError 分支 |

### 前端 `web/`

| 文件 | 职责 |
|------|------|
| `src/lib/survivalApi.ts` | 7 接口封装(X-Chain-Key + JWT),SurvivalApiError 带 status |
| `src/components/SurvivalRoom.tsx` | Canvas 像素房间(960×640,dpr 自适应),五热点(食盆/扫帚/电脑桌/药箱/宠物窝),宠物状态机 idle→goto→act→finale→idle,weak 变暗/dormant 趴窝/dead 灰度+幽灵 |
| `src/pages/SurvivalPage.tsx` | 左画布 + 右面板(状态条/credits/质押收益/日志)+ 可折叠排行榜;15s 轮询;领养卡/复活按钮 |
| `NavBar.tsx` / `App.tsx`(改) | 导航项(仅 near 家族)+ 路由 |
| `i18n/locales/{zh,en}/survival.ts` | 全量文案 |

## 3. API(与前端契约)

```
GET  /survival/leaderboard?limit=50        公开
GET  /survival/pet/:tokenId                公开(读时惰性结算衰减)
POST /survival/pet/:tokenId/adopt          {principal:1|2|5}   auth+owner
POST /survival/pet/:tokenId/action         {kind:feed|clean|work|heal}  auth+owner,同步(LLM+链上 10-30s)
POST /survival/pet/:tokenId/revive         auth+owner(dead 才可)
GET  /survival/pet/:tokenId/actions?limit  公开
PUT  /survival/pet/:tokenId/settings       {riskProfile?,maxSinglePct?}  auth+owner
POST /admin/survival/credits               {chainKey?,tokenId,usd,note}  admin(人工充值记账)
```
owner 校验走 `assertAgentOwnership`;cooldowns 为 ms epoch(0=可执行);yocto 金额一律字符串。

## 4. 上线前操作清单(按序)

1. **NEAR AI Cloud**:注册 cloud.near.ai → 充值最低额度 → 生成 API key → 配 `SURVIVAL_LLM_API_KEY`(决策)+ 记录 org 余额。决策模型默认 glm-5.3-flash,1 美元 ≈ 2400 次决策。
2. **主网质押验证**:`AGENT_NEAR_PRIVATE_KEY`/`AGENT_NEAR_ACCOUNT_ID`(主网,≥1.05N)→ `npx tsx scripts/e2e-survival-stake.ts`(质押 1 NEAR + 快照对账,**未运行**)。
3. **开放领养**:e2e 过后前端直接可用;首个宠物 adopt 即真实质押。
4. **credits 充值闭环**:NEAR AI 真实充值(仪表盘,无 API)→ `POST /admin/survival/credits` 记账;宠物也可 heal 把质押收益折算进 credits。
5. (可选)切 NEAR 链登录后运行:测得 farm 可用则进 M4(自动收益转 credits),见 near-ai-cloud-notes §12。

## 5. 下一阶段 TODO:经济模型 v2 + 用户自费领养(用户定调,2026-11,未实施)

> 当前阶段(2026-11)维持 agentverse 托管运营:平台垫资本金、统一持有 NEAR AI key(`SURVIVAL_LLM_*`)、账本制 credits。
> 本节整块是下一个阶段的改造清单,避免遗忘。

### 6.1 领养改为用户付费(不再平台垫资)

- 前端弹用户钱包签名广播(NEAR `user_wallet` 模式,基建已有:`buildRefSwapTxs`/`buildBurrow*Txs`/`NearUnsignedTx` → wallet-selector 签名链路)
- 用户支付领养费(1/2/5 NEAR 档位),**该费用用户取不回**(不是托管本金,无退款承诺——这是平台收入)
- 链上动作:资金按 §6.2 分配执行,全程用户钱包签名,agentverse 只组装交易

### 6.2 领养费分配比例(以 1 NEAR 为例)

| 比例 | 去向 | 用途 |
|------|------|------|
| **30%** | 经 Ref 换成 USDC | **直接购 NEAR AI credits**,作为宠物初期算力(覆盖启动期高频互动) |
| **50%** | 存入 Burrow 借贷 | 持续生息,利息每小时折算 credits(长期口粮) |
| **20%** | NEAR AI 质押(House of Stake farm) | 收益自动变成 NEAR AI token/credits |

- 收益统一**每小时折算**进宠物 credits(延续现有快照机制,只是资金来源从"单一质押池"变三个头寸)
- 头寸级记账:现有"全局池子观"分摊不够,需按 30/50/20 三个头寸分别记收益(依赖 §5 的 pnl 精确归因)

### 6.3 配套改造清单

1. 领养 API 改造:`POST /survival/pet/:tokenId/adopt` 返回待签名交易组(Ref swap + Burrow supply + farm deposit),用户签名后 `/survival/pet/:tokenId/adopt-confirm` 回执确权(仿竞技场 register/register-confirm 两段式)
2. 前端领养卡:签名校验流程(仿现有 SignTxAction 交互)
3. 三个头寸的部署/记账:`survival_positions` 表(kind: usdc_reserve/burrow_lending/nearai_farm)替代单一 `stake_tx`
4. House of Stake farm 接入(M4,前置:NEAR 登录 cloud.near.ai 绑定 org,见 near-ai-cloud-notes §12);在 farm 可用前,20% 那部分暂存 Meta Pool stNEAR 或 Burrow
5. USDC 购 credits:NEAR AI 无公开购买 API,维持"人工仪表盘充值 + `POST /admin/survival/credits` 记账",账本轮询 NEAR AI org 余额做对账
6. 启动算力 $0.05 保留(有 30% 预购 credits 后不构成亏损)
7. 平台垫资保险丝仍保留(全局未结算垫资 > $X 暂停兑换)

### 6.4 远期(再下一阶段)

- **宠物自托管算力**:NEAR AI 官方若开放 API key 管理接口,每个宠物创建自己的 key、自充值/自结算,彻底去平台化(见 §5)
- 收益提现(本金不可动的前提已随"领养费"模式消解;未花完的 credits 提现规则待定义)
- 排行榜/链上存证/玩具系统

## 6. 已知限制 / TODO

- **远期扩展(用户定调,2026-11)**:NEAR AI 官方若开放 API key 管理接口,让每个宠物创建自己的 NEAR AI key、自托管算力(自充值/自结算),彻底去平台化。当前阶段由 agentverse 统一持有 key、统一承担调用费用,按账本把成本记到每个宠物头上。
- credits 是平台账本,与 NEAR AI org 真实余额的对账靠人工(充值后记账);无自动对账脚本。
- work 的 pnl 用执行前后热钱包总价值快照差(含 stNEAR 价格波动噪声),精确归因需头寸级记账(二期)。
- 收益快照是"全局池子观"(热钱包总价值 − Σ本金)按本金比例分摊,不是逐头寸精确归因。
- leaderboard 名字取自 DB 镜像 `chain_identities`,无镜像显示 `#tokenId`。
- M4(官方 staking farm 自动化)、玩家自充值本金、链上存证/排行榜、玩具系统 = 二期。
- work pnl 与 executor 主网路径(action 接口真实执行)只经过了离线断言,未上主网跑过真实交易。
