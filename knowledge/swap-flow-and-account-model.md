# Swap 完整流程与账户模型

> 记录一次"意图 → 兑换完成"的端到端链路,以及热钱包/用户钱包的关系。
> 实例:用户在助手页说"0.01 avax换usdc" → Fuji 链真实成交(tx 0x5b0656f5…75a9)。

## 1. 账户模型

| | 用户钱包(如 0xfEfd…3766) | Agent 热钱包(0xD79d…0363) |
|---|---|---|
| 私钥 | 用户的 MetaMask | agent 服务 .env 的 `AGENT_PRIVATE_KEY` |
| 资金来源 | 用户自己 | 用户/部署者注资(0.05 AVAX,tx 0xefc72605…aeb8f) |
| 角色 | 资产所有者 | Agent 的操作账户,只放少量资金 |
| 风险边界 | 永远不暴露私钥 | 被攻击/幻觉最多损失热钱包余额 |

**当前 swap 有两种执行模式,可在个人主页「Agent 控制台 → 兑换执行模式」切换:**

| 模式 | 出资方 | 签名方 | 适用方向 | 说明 |
|---|---|---|---|---|
| hot_wallet | Agent 热钱包 | Agent 服务自动签名 | AVAX→USDC、USDC→AVAX | 热钱包内只放少量测试资金,限额内自动执行 |
| user_wallet | 用户钱包 | 用户通过 MetaMask 签名 | AVAX→USDC、USDC→AVAX | Agent 只组装交易,用户签名后由前端直接发送 |

- hot_wallet 的 USDC→AVAX 需要用户先 approve Agent 热钱包,审批中心放行时弹钱包授权。
- user_wallet 的 USDC→AVAX 需要用户直接 approve Router,再签名 swap,两笔都在 MetaMask 逐笔确认。

操作用户资产的更多授权路径见 §4(授权模型)。

## 2. 意图 → Swap 完成的全流程

### 2.1 热钱包自动模式(hot_wallet)

```
① 前端(助手页 /assistant)
   用户消息 → POST /conversations/:id/chat

② 上下文装配(agent 服务, conversation.ts / agent.ts)
   ├─ messages 表读该会话最近 20 轮历史
   ├─ 链上装载人格: personaOf → keccak256 校验 → ownerOf(识别主人地址)
   ├─ 人格开关检查(emergency / autoReply)
   ├─ 记忆检索: fastembed 向量查语义记忆 + 最近情景记忆 → 注入 system prompt
   └─ buildInstructions: 人格 + 身份上下文 + "有工具必须调工具"规则

③ 模型决策
   识别兑换意图 → 调用工具 propose_swap(tokenIn=AVAX, tokenOut=USDC, amountIn, reason)

④ defi-swap 工具(skills/defi-swap)
   ├─ 报价: Router.getAmountsOut(amountIn, [WAVAX, USDC])   (链上只读)
   ├─ 滑点保护: amountOutMin = 报价 × 99.5%
   ├─ 估值: 行情 API(CoinGecko/Gate.io) → estimatedValueUsd
   └─ 生成结构化提案 JSON { action, protocol, chainId, params, estimatedValueUsd, reason }

⑤ 策略引擎(policy/engine.ts)——所有写操作的必经关卡
   ├─ 协议白名单: router 地址精确匹配            → 不符 rejected
   ├─ 代币白名单: WAVAX/USDC                     → 不符 rejected
   ├─ 单笔限额 POLICY_MAX_TX_USD=25              ┐
   ├─ 日累计 POLICY_DAILY_LIMIT_USD=125           ├→ 超限 needsApproval
   ├─ 冷却 POLICY_COOLDOWN_SECONDS=600            │   (进审批中心等主人放行)
   ├─ 价格源失败熔断                               ┘
   └─ 全部通过 → verdict = execute

⑥ 上链执行(chain/defi.ts,热钱包签名)
   AVAX→USDC: swapExactAVAXForTokens(amountOutMin, [WAVAX→USDC], 热钱包, deadline=now+600s)
   USDC→AVAX: transferFrom(用户→热钱包) → approve(Router) → swapExactTokensForAVAX
   → waitForTransactionReceipt
   → 核实余额真实变化(防假成功)
   → 写 tasks 审计表

⑦ 回复生成
   工具结果(txHash/amountOut)回给模型 → 口语化中文回复

⑧ 落库收尾
   ├─ 问答写入 messages 表(会话历史)
   ├─ 写情景记忆(积累 10 条触发蒸馏成语义记忆)
   └─ 返回前端展示
```

### 2.2 用户钱包签名模式(user_wallet)

步骤 ①~⑤ 与热钱包模式相同,区别在执行阶段:

```
⑥ Agent 只组装 unsigned transactions(不触碰私钥)
   AVAX→USDC: unsigned swapExactAVAXForTokens(target=用户钱包)
   USDC→AVAX: 如 allowance 不足,先 unsigned approve(Router);再 unsigned swapExactTokensForAVAX(target=用户钱包)
   → propose_swap 返回 verdict=sign + sign_tx action(含 proposal 快照)

⑦ 前端交互(MyAgentPage.tsx)
   → 聊天区出现「签名并发送」按钮
   → 用户点击 → MetaMask 逐笔弹窗确认(approve+swap 会先等 approve 确认再发 swap)
   → 前端拿到 txHash 后调用 POST /agents/:tokenId/sign-confirm 回写后端
   → 后端记录 tasks 表(保证日累计/单笔限额生效)

⑧ 回复生成与落库
   → 模型根据已签名上链的结果组织回复(如给出 Snowtrace 链接)
   → 问答写入 messages 表,更新情景/语义记忆
```

## 3. 超限额时的审批分支

⑤ 判定 needsApproval 时:提案写 `approvals` 表(pending)→ 前端控制台「任务审批中心」20s 轮询展示。

- **hot_wallet 超限额/熔断**:用户点「放行并执行」→ `POST /approvals/:id/approve` → 走热钱包执行分支 → status=executed 带 tx_hash。
- **hot_wallet 的 USDC→AVAX 额度不足**:审批单带 `signatureRequest`(ERC-20 approve);用户点放行时先弹 MetaMask 完成 approve,再由后端 transferFrom+swap。
- **user_wallet 模式**:不生成 approvals 超限单,一律通过用户签名完成,签名即视为用户授权。

拒绝则 status=rejected,不可再执行(重复操作返回 409)。

## 4. 未来:Agent 操作用户资产的授权模型

当前热钱包模式升级为"操作用户资产"时,有三条路径(可组合):

| 方案 | 机制 | 边界控制 | 适用 |
|------|------|---------|------|
| A. ERC-20 approve 额度 | 用户 `approve(模块/热钱包, 限额)` | 额度即上限,用完即止 | 简单直接,首期推荐 |
| B. 模块注册表 + 权限位 | DIDIdentity 已预留 `registerModule` + `setAgent` 权限位 | 只有注册表内的模块合约能代表身份行动 | 装备/身份相关操作 |
| C. EIP-7702 委托(MetaMask 智能账户) | 用户签一份带 caveat 的委托(限定目标合约/单日额度/有效期),Agent 通过 DelegationManager 凭委托执行 | 链上 enforcer 强制约束,可随时撤销 | 用户已是 7702 智能账户,最自然 |

无论哪条路径,**策略引擎与审批中心不变**:授权决定"Agent 能不能碰这笔钱",策略引擎决定"这笔具体交易合不合规",审批中心保留人的最终决策权。

## 5. 已知注意事项

- Fuji 测试池流动性失真,汇率不代表真实行情(链路本身真实可用)。
- Sepolia 上 defi-swap 需另注 Sepolia ETH 且确认 Uniswap V2 池子流动性;当前 Sepolia 配置中 USDC 为零地址,实际 swap 需先替换为真实测试 USDC 地址。
- user_wallet 模式目前记录 amountOut='0'(因为前端未解析 receipt 中的真实输出),仅用于审计和限额统计;如需精确金额,可在 sign-confirm 时补充 receipt 解析。
