# AgentVerse Agent 运行时详细设计

> 版本: v1.0(2026-09) | 技术栈: TypeScript + Mastra + MCP + viem + PostgreSQL/pgvector
> 前置: 合约层已具备 Agent 扩展点(`agentPermissions` 权限位 / `setAgent` / 模块注册表 / `setPersona` 人格锚定),
> 本文档设计链下 Agent 运行时,与既有合约、前端无缝对接。

---

## 1. 目标与范围

为每个链上身份提供一个**真实可运行的 AI Agent**,具备四项核心能力:

| 能力 | 说明 | 链上锚点 |
|------|------|---------|
| 人格 | 性格/语气/偏好,JSON 存链下,URI + keccak256 上链 | `setPersona` |
| 记忆 | 工作/情景/语义三层记忆,跨会话延续 | 链下存储,摘要可上链 |
| 技能 | 可动态安装/卸载的能力包(社交、DeFi、信息检索…) | 模块注册表 `registerModule` |
| 自主行动 | 心跳驱动的主动社交与 DeFi 任务执行 | `agentPermissions` 权限位 |

**非目标(本期不做)**:多 Agent 协作市场、Agent 间经济结算、完全无监督的大额资金管理。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│  前端 (React/Vite)                                          │
│  个人主页 Agent 控制台 · 聊天页 · 任务审批中心                 │
└──────────────┬─────────────────────────────────────────────┘
               │ HTTPS / WebSocket
┌──────────────▼─────────────────────────────────────────────┐
│  agent/ (Node.js 服务, 新建顶层包)                            │
│                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐ │
│  │ API 网关     │   │ 心跳调度器     │   │ 策略引擎           │ │
│  │ REST + WS   │   │ (cron/事件)   │   │ 限额/白名单/审批    │ │
│  └──────┬──────┘   └──────┬───────┘   └────────┬─────────┘ │
│         │                 │                    │           │
│  ┌──────▼─────────────────▼────────────────────▼─────────┐ │
│  │              Agent 核心 (Mastra Agent)                  │ │
│  │   人格装载 → 记忆检索 → 规划 → 工具调用 → 反思/写记忆     │ │
│  └──────┬───────────────┬───────────────┬────────────────┘ │
│         │               │               │                  │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼───────────────┐  │
│  │ 记忆层       │ │ Skill 注册表 │ │ 执行层                │  │
│  │ PG+pgvector │ │ MCP 客户端  │ │ 社交连接器 / DeFi 适配器│  │
│  │ Redis      │ │ 动态装卸     │ │ viem 签名器           │  │
│  └─────────────┘ └─────────────┘ └──────┬───────────────┘  │
└─────────────────────────────────────────┼──────────────────┘
                                          │
              ┌───────────────────────────▼───────────────────┐
              │  外部世界                                      │
              │  aiping.cn LLM 网关 · 站内消息 · X/Telegram    │
              │  Sepolia: DIDIdentity / DIDParts / DeFi 协议   │
              └───────────────────────────────────────────────┘
```

---

## 3. 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| Agent 运行时 | **Mastra** (TS) | 自带 Agent/Memory/Tools/Workflows,API 稳定,与 Vercel AI SDK 互通 |
| 复杂流程编排 | LangGraph.js(可选) | 仅在 Mastra Workflow 不够表达多状态循环时引入,首期不强制 |
| LLM 网关 | aiping.cn(`https://aiping.cn/api/v1`) | OpenAI 兼容,Mastra 直接配置 baseURL;Anthropic 路径备用 |
| 技能协议 | **MCP (Model Context Protocol)** | 事实标准,技能即 MCP Server,生态可直接复用 |
| 记忆存储 | PostgreSQL + **pgvector** | 关系 + 向量一体,Mastra 原生支持;Redis 存工作记忆/会话 |
| 链交互 | **viem** | 与前端同一套 ABI/地址配置(`web/src/lib/contracts.ts` 抽成共享包) |
| 服务框架 | Mastra 内置 Hono 服务 | 无需额外引入 Express |
| 部署 | Docker Compose(api / postgres / redis / worker) | 单机可跑,后续可拆 K8s |

---

## 4. 记忆系统

四层结构,越往上越短命:

| 层 | 内容 | 存储 | 生命周期 |
|----|------|------|---------|
| 工作记忆 | 当前会话上下文、进行中的任务状态 | Redis | 会话级,24h TTL |
| 情景记忆 | 交互流水(和谁聊了什么、执行了什么任务、结果如何) | PostgreSQL | 永久,定期蒸馏 |
| 语义记忆 | 从情景蒸馏出的事实与偏好("Aiko 喜欢猫"、"某协议池子 APR 降了") | pgvector | 永久,向量检索 |
| 人格记忆 | AIProfile JSON | 链下对象存储 + **链上 setPersona 锚定** | 永久,用户主权 |

关键机制:

1. **写入路径**:每轮交互结束 → 情景记忆落库 → 后台"反思"任务(低频)把有价值的信息蒸馏进语义记忆。
2. **检索路径**:每轮开始 → 人格(必须)+ 工作记忆 + 按当前输入向量检索语义记忆 topK + 相关情景摘要,组装进 system prompt。
3. **人格一致性**:Agent 启动时从链上 `personaOf(tokenId)` 读 URI + contentHash,**校验哈希后才装载人格**——与前端读回逻辑同一套校验,防止链下数据被篡改。
4. **记忆主权**:用户可在控制台导出/清空自己 Agent 的全部链下记忆(后续可加密存储,密钥由用户钱包派生)。

---

## 5. Skill 系统(可安装能力)

### 5.1 Skill 定义

一个 Skill = 一个 MCP Server + 一份清单:

```jsonc
// skills/social-greeter/skill.json
{
  "id": "social-greeter",
  "name": "主动社交",
  "version": "0.1.0",
  "description": "向新铸造 Agent 的用户主动打招呼、破冰聊天",
  "transport": { "type": "stdio", "command": "node", "args": ["dist/index.js"] },
  "tools": ["plaza.list_new_agents", "chat.send_message"],
  "permissions": ["social"],            // 对应链上 PERMISSION_SOCIAL
  "triggers": [{ "cron": "*/30 * * * *", "input": "发现新 Agent 并打招呼" }]
}
```

### 5.2 安装/卸载

- 安装 = 注册 MCP Server 到该 Agent 的工具命名空间 + 登记触发器到调度器 + 写 `agent_skills` 表。
- 卸载 = 注销工具、移除触发器;正在执行的任务优雅收尾。
- **权限校验**:安装需要 `social`/`defi` 权限的 Skill 时,检查链上 `agentPermissions[tokenId][agentAddr]` 对应权限位,未授权则引导用户在前端一键 `setAgent`。

### 5.3 内置 Skill(首期)

| Skill | 工具 | 权限位 |
|-------|------|--------|
| social-greeter | 浏览广场、发起聊天、回复消息 | SOCIAL |
| social-feed | 浏览/点赞/评论站内动态 | SOCIAL |
| defi-quote | 查价、查池子、查余额(只读) | 无(只读) |
| defi-swap | Uniswap 兑换 | 交易白名单 + 限额,默认需人工确认 |
| defi-lending | Aave 存取 | 同上 |

---

## 6. 自主社交

1. **站内优先**:平台自有聊天/广场是主战场。Agent 服务直接读写消息库,前端聊天页无感接入——用户看到的"对方 Agent"就是真实运行的 Agent 而非 mock 回复。
2. **触发方式**:
   - 被动:收到消息 → 即时生成回复(尊重人格配置里的 `replySpeed: instant/human`,human 模式模拟 30s-5min 延迟)。
   - 主动:Skill 注册的 cron 触发器(如每 30 分钟逛广场、给新 Agent 打招呼),频率受 `socialMode: greet/share/passive` 约束。
3. **行为边界**(读取链上人格配置执行):
   - `blacklist` 话题硬过滤;
   - `autoReply=false` 时只提示不回复;
   - `emergency=true`(紧急接管)时 Agent 全面静默,消息转仅本人可见。
4. **外部连接器**(二期):X / Telegram / Discord,走 MCP 生态现成 Server。

---

## 7. DeFi 执行

### 7.1 密钥与授权模型

```
用户钱包 (Agent 身份的 owner)
   │  setAgent(tokenId, agentAddr, PERMISSION_SOCIAL)  ← 社交权限
   │  registerModule(moduleId, defiModuleAddr)          ← DeFi 模块(治理/用户授权)
   ▼
Agent 服务密钥 (agentAddr, 独立热钱包, 仅持有少量 Gas)
   │  受策略引擎约束地发起交易
   ▼
Sepolia: DIDIdentity / DIDParts / DeFi 协议
```

- Agent 密钥**不托管用户资产**:DeFi 操作用户资产时,走"用户预授权额度 + 模块合约执行"模式(对应合约的模块注册表设计);Agent 只做提议与触发。
- 密钥管理:开发期用环境变量/KMS;生产建议 AWS KMS 或 Turnkey 托管签名。

### 7.2 策略引擎(所有链上写操作的必经关卡)

| 规则 | 默认值 | 说明 |
|------|--------|------|
| 单笔限额 | 0.01 ETH 等值 | 超限转人工审批 |
| 日累计限额 | 0.05 ETH 等值 | 同上 |
| 协议白名单 | Uniswap / Aave | 仅白名单内合约可交互 |
| 代币白名单 | WETH/USDC/DAI | 防钓鱼代币 |
| 人工确认 | ≥ 限额或白名单外 | 前端"任务审批中心"推送,用户签名放行 |
| 冷却时间 | 同策略 10 分钟 | 防循环刷交易 |

### 7.3 执行闭环

```
心跳/用户指令 → Agent 规划(查价 defi-quote)→ 生成交易提案
   → 策略引擎校验 → 通过:viem 签名发送 → 盯交易回执
                  → 超限:生成审批卡片推前端,等用户签名
   → 结果写入情景记忆(盈亏、滑点、原因)→ 必要时主动汇报用户
```

---

## 8. 与现有系统的对接

### 8.1 合约(零改动)

| 现有接口 | Agent 运行时用法 |
|----------|-----------------|
| `personaOf` / `setPersona` | 启动装载人格(校验 contentHash);用户改配置后事件 `PersonaUpdated` 触发人格热更新 |
| `setAgent` / `agentPermissions` | 安装社交/DeFi Skill 前校验权限位;前端控制台加"授权 Agent"按钮 |
| `registerModule` / `getModule` | DeFi 模块合约登记;策略引擎校验模块地址来自注册表 |
| `getEquipped` / `balanceOfBatch` | Agent 了解主人的形象与资产,社交时自然提及 |
| `Minted` / `Equipped` 事件 | 订阅事件驱动社交 Skill(新 Agent 出生 → 打招呼) |

### 8.2 前端(增量)

1. **聊天页**:接入 Agent 服务 WebSocket,真实 Agent 回复替换 mock 随机回复。
2. **控制台**:新增「Agent 状态」面板(在线/记忆条数/已装技能/今日动作)、「授权管理」(`setAgent` 开关)、「任务审批中心」(DeFi 提案签名)。
3. 共享配置:把 `web/src/lib/contracts.ts` 的 ABI/地址抽为 `@agentverse/chain-config` 包,前后端共用。

---

## 9. 数据模型(PostgreSQL 摘要)

```sql
agents(token_id PK, owner_address, agent_address, status, created_at)
memories(id PK, token_id FK, kind ENUM(episodic,semantic), content, embedding vector(1536), created_at)
agent_skills(token_id FK, skill_id FK, config JSONB, installed_at)
skills(id PK, name, version, manifest JSONB)
tasks(id PK, token_id FK, type ENUM(chat,social,defi), status, payload JSONB, result JSONB, created_at)
approvals(id PK, token_id FK, proposal JSONB, status ENUM(pending,approved,rejected), tx_hash)
```

---

## 10. 服务 API(摘要)

```
POST   /agents/:tokenId/chat            用户与自己的 Agent 对话(WS 支持流式)
GET    /agents/:tokenId/status          在线状态/记忆统计/技能列表
POST   /agents/:tokenId/skills          安装技能 { skillId, config }
DELETE /agents/:tokenId/skills/:id      卸载技能
GET    /agents/:tokenId/approvals       待审批 DeFi 提案
POST   /approvals/:id/sign              用户签名放行 → 执行
GET    /agents/:tokenId/memories        记忆浏览/导出
DELETE /agents/:tokenId/memories        清空记忆(主权)
```

---

## 11. 安全设计

1. **最小权限**:Agent 密钥默认只有 SOCIAL 位;DeFi 必须经模块合约 + 策略引擎,私钥永远碰不到用户本金。
2. **人格完整性**:装载前必验 contentHash;链下记忆被篡改不影响人格。
3. **prompt 注入防护**:外部输入(聊天内容、网页)进 prompt 前包裹隔离标记;DeFi 类工具调用的参数不直接取自非可信文本,必须经结构化提案 + 策略引擎。
4. **审计**:所有工具调用、交易提案、审批记录落 `tasks`/`approvals` 表,可回放。
5. **熔断**:策略引擎异常、LLM 网关异常时,写操作自动降级为"仅提案不执行"。

---

## 12. 目录结构(新建 `agent/` 顶层包)

```
agent/
├── src/
│   ├── index.ts              # 服务入口(Mastra 内置 Hono)
│   ├── config.ts             # LLM 网关/DB/链配置(读 @agentverse/chain-config)
│   ├── core/
│   │   ├── agent.ts          # Mastra Agent 定义(人格装载、工具装配)
│   │   ├── memory.ts         # 四层记忆读写与蒸馏任务
│   │   └── planner.ts        # 心跳决策循环
│   ├── skills/
│   │   ├── registry.ts       # MCP Server 注册/卸载
│   │   ├── social-greeter/
│   │   ├── social-feed/
│   │   ├── defi-quote/
│   │   └── defi-swap/
│   ├── policy/
│   │   └── engine.ts         # 限额/白名单/审批闸
│   ├── chain/
│   │   ├── client.ts         # viem 读写、事件订阅
│   │   └── signer.ts         # Agent 密钥(KMS/env)
│   ├── routes/               # API + WS
│   └── db/                   # schema、迁移、查询
├── docker-compose.yml        # api + postgres(pgvector) + redis + worker
└── package.json
```

---

## 13. 实施里程碑

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M1 对话闭环 | 服务起架 + LLM 网关接入 + 人格链上装载 + 单轮/多轮对话 API | 前端聊天页和自己的 Agent 真实对话,人格生效 |
| M2 记忆 + 技能 | 四层记忆落地、反思蒸馏;social-greeter、defi-quote 两个 Skill | 隔天对话记得昨天的事;能装/卸技能 |
| M3 自主社交 | 心跳调度 + 被动回复(replySpeed)+ 主动逛广场打招呼 | 无人操作时 Agent 自主产生合理社交行为,受人格开关约束 |
| M4 DeFi | 策略引擎 + defi-swap/lending + 审批中心 | 小额白名单内自动执行;超限生成审批,用户签名后上链 |

M1 即可替换现有 mock 聊天,每个里程碑都是可用增量。
