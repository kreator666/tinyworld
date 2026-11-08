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

## 5. 已知限制 / TODO

- **远期扩展(用户定调,2026-11)**:NEAR AI 官方若开放 API key 管理接口,让每个宠物创建自己的 NEAR AI key、自托管算力(自充值/自结算),彻底去平台化。当前阶段由 agentverse 统一持有 key、统一承担调用费用,按账本把成本记到每个宠物头上。
- credits 是平台账本,与 NEAR AI org 真实余额的对账靠人工(充值后记账);无自动对账脚本。
- work 的 pnl 用执行前后热钱包总价值快照差(含 stNEAR 价格波动噪声),精确归因需头寸级记账(二期)。
- 收益快照是"全局池子观"(热钱包总价值 − Σ本金)按本金比例分摊,不是逐头寸精确归因。
- leaderboard 名字取自 DB 镜像 `chain_identities`,无镜像显示 `#tokenId`。
- M4(官方 staking farm 自动化)、玩家自充值本金、链上存证/排行榜、玩具系统 = 二期。
- work pnl 与 executor 主网路径(action 接口真实执行)只经过了离线断言,未上主网跑过真实交易。
