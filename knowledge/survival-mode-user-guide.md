# 生存模式(Survival Mode)完整文档

> 版本:2026-11 动作语义 v2 | 状态:主网 + 测试网均已上线 | 本文档 = 使用方法 + 用户手册 + 实现方案(权威参考)
> 前置阅读:`near-ai-cloud-notes.md`(NEAR AI Cloud 调研)、`arena-mode-design.md`(架构母版)

---

## 第一部分:使用方法(3 分钟上手)

```
1. 打开 https://agent.freetoken.xin → 导航栏链选择器切到 NEAR Mainnet(或 Testnet 试玩)
2. 连接 Meteor 钱包(网络必须与所选链一致:主网选 Mainnet)
3. 铸造 DID(若没有)—— 一只 DID 对应一只宠物
4. 进入「生存模式」→ 选本金档位(1/2/5 NEAR)→ 钱包签名支付领养费
5. 点画布里的物品与宠物互动:
   食盆=喂食加金 | 扫帚=提取收益 | 电脑桌=高风险打工 | 药箱=收益换算力 | (死亡后)复活按钮
```

零成本试玩:切到 NEAR Testnet,领测试币后同样流程,质押走 Burrow 替身链路。

---

## 第二部分:用户手册

### 2.1 页面导览

| 区域 | 内容 |
|------|------|
| 画布(左) | 像素房间 + 宠物。五个可点热点:食盆/扫帚水桶/电脑桌/药箱/宠物窝;冷却中的物品显示灰色罩 + 倒计时 |
| 状态面板(右上) | 四条状态条(饱食/清洁/心情/生命)、算力余额($)、生息本金 + 累计收益、死亡次数 |
| 资金分配(面板内) | 三只口袋:💵 算力储备(30%)/ 🏦 借贷生息(50%)/ 🌾 NEAR AI 质押(20%),各自金额与说明 |
| 动作日志 | 每次动作的决策、花费、交易哈希(nearblocks 链接) |
| 排行榜(底部) | 按累计收益排序,纯荣誉榜 |

### 2.2 宠物状态

| 状态 | 含义 | 外观 |
|------|------|------|
| 饱食/清洁 | 0–100,分别 48h / 72h 衰减归零 | 进度条 |
| 心情 | = f(饱食,清洁),弱/死时封顶 50 | 进度条 |
| 生命 | 打工消耗(−5/次);0 时衰减 ×1.5 | 进度条 |
| 算力 Credits | LLM 决策的燃料,打工每次约 $0.0004–0.002 | $ 余额 |
| weak 虚弱 | 饱食归零,24h 后死亡 | 宠物变暗、坐下低头 |
| dormant 休眠 | 算力耗尽,不能打工 | 趴窝冒 Zzz |
| dead 死亡 | 可复活,死亡次数永久记录 | 灰度躺地 + 幽灵 |

### 2.3 五个动作

**喂食(食盆)= 新存入借贷协议,生息本金变多**
- 选 0.1 / 0.2 / 0.5 NEAR → 你的钱包签名转账 → 平台代存入(Burrow 测试网 / 换 stNEAR 主网)
- 状态:饱食 +25、心情 +5 | 冷却 5 分钟 | **不消耗算力**
- 这笔钱并入 `生息本金`,以后每小时收益快照按本金比例分配,**不可提取**(见打扫)

**打扫(扫帚)= 提取收益(含利息)到金库**
- 确认弹窗会明确:**初始本金不可提取,只提取收益部分**
- 链上:Burrow withdraw(测试网)/ 卖 stNEAR(主网);收益记为「落袋收益」,**本金原封不动**
- 状态:清洁 +25、心情 +5 | 冷却 5 分钟 | 无收益时提示「暂无可提取的收益」

**打工(电脑桌)= 高风险方向性交易,可能亏损**
- 风险确认弹窗:**做多/做空 NEAR,由 NEAR AI 决策,亏损会计入宠物收益**
- 执行:NEAR AI 的 LLM 产出策略 → 白名单校验 → Ref 兑换;pnl = 执行前后金库总价值差(可负)
- 状态:生命 −5、心情 +10 | 冷却 15 分钟 | **唯一消耗算力的动作**

**治疗(药箱)= 把收益折算成 NEAR AI 算力**
- 按 NEAR AI 实时报价折算(NEAR AI 不可达时按回落价并注明),收益清零变成算力
- 状态:生命 +20、饱食 +15 | 休眠时唯一可执行的动作

**复活(死亡后按钮)= 钱包支付 0.5 NEAR 充值 NEAR AI 算力**
- 说明弹窗确认后:钱包签 0.5 NEAR 转账 → 复活,四维重置 60,**本金与收益保留**,死亡次数 +1

### 2.4 钱从哪来,到哪去

```
领养费(1/2/5 NEAR,不返还)          喂食加金(0.1/0.2/0.5,不返还)
        │                                  │
        ▼                                  ▼
┌─ 平台金库(agentverse-survival.near / 测试网 tinyworld-agent.testnet)─┐
│  30% 算力储备 ── stNEAR 生息(购 NEAR AI credits 时手工兑 USDC)      │
│  50% 借贷生息 ── stNEAR 生息(主网 Ref 买入 / 测试网 Burrow)         │
│  20% NEAR AI 质押 ── stNEAR 生息(House of Stake farm 占位)          │
│  每小时快照:池子收益 − Σ本金 = 收益,按各宠物本金比例记账 yield          │
└──────────────────────────────────────────────────────────────┘
        │ 打扫:提取收益(本金不动)      │ 治疗:收益折算
        ▼                              ▼
   落袋收益(earnings)             算力 credits ──▶ 打工决策消耗
```

### 2.5 算力经济

- 1 NEAR 本金月息约 $0.019(NEAR≈$2.5、APY≈9%),约 46 次打工决策 —— 算力是稀缺资源,这是玩法核心
- 领养赠 $0.05 启动算力(约 110 次决策);耗尽后宠物休眠,治疗(有收益时)或管理员充值可唤醒
- 定价来自 NEAR AI 公开接口 `GET cloud-api.near.ai/v1/models` 的 glm-5.3-flash 实时价

### 2.6 常见问题

| 问题 | 答案 |
|------|------|
| 钱包连上了但链不对 | Meteor 自身网络设置必须与所选链一致,页面会明确提示 |
| 签名账户和页面显示不一致 | 前端签名人双重校验会拒绝并提示切回正确账户 |
| 点了没反应 | 强刷页面(Ctrl+Shift+R);动作执行需 10–30 秒,期间有转圈;重复点击会提示「宠物正在忙」 |
| 动作日志里 noop | LLM 判市场无机会时合法降级,状态加成照给 |
| 分配头寸显示失败 | 点重试(`POST /survival/pet/:id/retry-alloc`,只重跑失败头寸) |

---

## 第三部分:实现方案

### 3.1 架构

```
web/(React + Canvas)                agent/(Hono + PGlite)                链上
┌─────────────────┐  REST/X-Chain-Key ┌────────────────────────┐  near-api-js ┌──────────────────┐
│ SurvivalPage     │ ───────────────▶ │ survival 模块           │ ───────────▶ │ NEAR 协议:        │
│ SurvivalRoom     │  JWT 鉴权        │  service/thinker/       │  热钱包签名   │ wrap/ref/burrow/ │
│ (Canvas 状态机)  │ ◀─────────────── │  executor/scheduler/    │ ◀─────────── │ meta-pool         │
└─────────────────┘  JSON DTO        │  credits/allocate       │  事件/视图    └──────────────────┘
                                     └───────┬────────────────┘
                                             │ HTTPS
                                     ┌───────▼────────────────┐
                                     │ NEAR AI Cloud           │
                                     │ cloud-api.near.ai/v1    │
                                     │ LLM 决策 + 定价查询      │
                                     └─────────────────────────┘
```

### 3.2 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 链范围 | 仅 NEAR(testnet chainId 398 / mainnet 399) | 玩法围绕 NEAR 质押与 NEAR AI 构建 |
| 经济模型 | v2 用户自费领养;v1 平台垫资保留为 admin-only 测试口 | 平台不亏、用户本金锁定生息 |
| 领养费分配 | 30% 算力储备 / 50% 借贷 / 20% NEAR AI 质押,头寸级记账 | 收益覆盖算力支出 |
| 决策大脑 | NEAR AI glm-5.3-flash(独立 env 通道);仅打工烧算力 | 其余动作是确定性金融操作 |
| 签名模式 | 领养/喂食/复活 = 用户钱包签一笔转账(两段式核验);动作执行 = 平台热钱包 | 资金托管平台,入口用户可控 |
| 热钱包 | 主网专用账户 `agentverse-survival.near` + 可吊销 FullAccess 子密钥;测试网 `tinyworld-agent.testnet` | 主私钥永不上服务器 |
| 宠物状态/账本 | PGlite(`survival_pets/actions/ledger/positions`),收益全局池子观按本金分摊 | 轻量、可迁移真 Postgres |

### 3.3 数据模型(PGlite)

```sql
survival_pets(chain_key, token_id PK, owner, status, satiety, cleanliness, mood, vitality,
  weak_since, principal_yocto, earnings_yocto, yield_yocto, credits_usd, credits_burned_usd,
  death_count, revive_count, born_at, last_action_at, last_decay_at, stake_tx, settings JSONB, ...)
survival_actions(id PK, chain_key, token_id, kind, status, plan JSONB, result JSONB, tx_hash, credit_cost_usd, pnl_yocto, created_at)
survival_ledger(id PK, chain_key, token_id, kind, -- stake|yield|topup|credit_burn|revive_fee|alloc
  amount_yocto, credits_delta, tx_hash, note, ts)
survival_positions(id PK, chain_key, token_id, kind, -- usdc_reserve|lending|nearai_farm
  token, amount_atomic, tx_hash, note, created_at)
```

### 3.4 API 路由(全部 `/survival` 前缀,X-Chain-Key 头区分链)

| 路由 | 鉴权 | 说明 |
|------|------|------|
| GET /leaderboard | 公开 | 收益降序荣誉榜 |
| GET /pet/:tokenId | 公开 | 状态 DTO(读时惰性结算衰减) |
| POST /pet/:tokenId/adopt-txs / adopt-confirm | owner | 领养两段式:返回转账交易 → 核验建宠物 + 30/50/20 分配 |
| POST /pet/:tokenId/feed-txs / feed-confirm | owner | 喂食加金两段式(0.1/0.2/0.5 档) |
| POST /pet/:tokenId/clean | owner | 提取收益(本金保护,原子记账) |
| POST /pet/:tokenId/action {work\|heal} | owner | 打工=LLM 策略烧算力;治疗=NEAR AI 报价折算 |
| POST /pet/:tokenId/revive-txs / revive-confirm | owner | 复活两段式(0.5 NEAR 精确档) |
| GET /pet/:tokenId/actions / positions | 公开 | 决策日志 / 资金分配 |
| POST /pet/:tokenId/retry-alloc | owner | 只重跑失败头寸(差额包裹) |
| PUT /pet/:tokenId/settings | owner | 风险档/单笔上限 |
| POST /admin/survival/credits / adopt-fund | admin | 人工充值记账 / legacy 垫资测试 |

### 3.5 关键流程

**领养两段式(防重放三重:宠物已存在 / 交易已用 / PK 冲突)**
```
adopt-txs → 用户签 Transfer(N NEAR → 平台账户) → adopt-confirm:
  nearWaitTxFinal 核验(signer=owner、receiver、单笔 Transfer、金额精确档位)
  → 建宠物(赠 $0.05 启动算力) → 热钱包执行 30/50/20:
     全量包裹 near_deposit(等视图可见) → 每头寸独立容错
     主网:Ref wNEAR→stNEAR(×3,池 id = from_index+页内序号)
     测试网:Burrow supply wNEAR
  → {pet, positions, failures}
```

**打工(唯一 LLM 链路,三重闸)**
```
 credits 预检 → NEAR AI glm-5.3-flash(maxTokens 900)输出结构化 plan
 → parsePlan 校验(围栏/白名单外代币/超上限 → 降级 noop)
 → executor checkStepAllowed(协议可用性/代币白名单/单笔 ≤ 本金10%)
 → refSwap / burrowSupply / stakeNear(目标合约硬编码,LLM 无法指定地址,无转账出口)
 → pnl 快照差(可负)记 earnings;按实际 token 用量烧 credits
```

**收益快照(调度器,每小时,纯 view 零交易)**
```
热钱包总价值(stNEAR 余额×价 + Burrow supplied)− Σ全体本金 = 池子收益增量
按各宠物本金比例记入 yield_yocto + ledger(kind='yield')
credits < 单次决策估算 → 标 dormant
```

### 3.6 主网 vs 测试网差异

| 项 | near-mainnet | near-testnet |
|----|-------------|--------------|
| 热钱包 | agentverse-survival.near(子密钥) | tinyworld-agent.testnet |
| 生息载体 | stNEAR(Ref 买入) | wNEAR(Burrow supply) |
| 算力储备 | stNEAR(购 credits 时手工兑 USDC) | Burrow 暂存(测试网无 USDC 池流动性) |
| NEAR AI 质押 | stNEAR(farm 占位) | Burrow 暂存 |
| 主网特有坑 | Meta Pool deposit 最低 1 NEAR(故走 Ref);原生 USDC 池薄 | Burrow execute 需 1 yocto;Withdraw 全取不传 max_amount |

### 3.7 配置项(agent/.env)

| env | 默认 | 说明 |
|-----|------|------|
| SURVIVAL_ENABLED | true | 总开关 |
| SURVIVAL_LLM_BASE_URL / API_KEY / MODEL | 回落全局 LLM_* | 决策通道;配 NEAR AI 时指向 cloud-api.near.ai |
| SURVIVAL_NEARAI_BASE_URL | cloud-api.near.ai/v1 | 定价查询 |
| SURVIVAL_STARTER_CREDITS_USD | 0.05 | 领养启动算力 |
| SURVIVAL_ALLOC_USDC/LENDING/NEARAI_PCT | 30/50/20 | 分配比例(和必须 100,启动校验) |
| SURVIVAL_ADOPTION_RECEIVER | 热钱包账户 | 领养费/喂食/复活收款账户 |
| SURVIVAL_METAPOOL_CONTRACT | meta-pool.near | 主网质押合约 |
| AGENT_NEAR_MAINNET_ACCOUNT_ID / _KEYS | — | 主网热钱包 + 子密钥 JSON |
| SURVIVAL_*DECAY/COOLDOWN | 48h/72h/24h,5/5/15min | 衰减与冷却 |

### 3.8 已知限制与 TODO(下一阶段)

- **House of Stake farm 接入**(nearai_farm 头寸目前用 stNEAR 占位):前置 = NEAR 账户登录 cloud.near.ai 绑定 org(spike 步骤见 near-ai-cloud-notes §12),接入后平台垫资归零
- **NEAR AI 开放 key 管理后** → 宠物自建 key 自托管算力(远期,去平台化)
- credits 是平台账本,NEAR AI 真实额度靠人工仪表盘充值 + `/admin/survival/credits` 记账,无自动对账
- work 的 pnl 是快照差(含价格波动噪声),精确归因需头寸级记账
- 玩家充值 credits(非领养费)、收益提现规则:未定义,二期
- leaderboard 名字取自 DB 镜像 `chain_identities`

### 3.9 资金安全红线

1. 执行器目标合约全部硬编码映射(refToken/burrowContract/metaPool/wrap),LLM 与用户传参无法引入新地址
2. 用户签名的只有 Transfer(金额/收款人由服务端固定),链上分配由平台热钱包执行
3. 打扫提取额 ≤ 已记账收益,本金永不触碰(原子 UPDATE + 离线断言)
4. 主网热钱包子密钥与主钥匙分离,可在线 delete-key 吊销(脚本 `agent/scripts/near-mainnet-subkey.ts`)
5. 领养/喂食/复活全部两段式 + 金额精确档位 + txHash 防重放
