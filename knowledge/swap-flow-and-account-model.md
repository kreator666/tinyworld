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

**当前 swap 全部用热钱包自有资金执行,用户钱包不参与交易。**
操作用户资产的未来路径见 §4(授权模型)。

## 2. 意图 → Swap 完成的全流程

```
① 前端(助手页 /assistant)
   用户消息 → POST /conversations/:id/chat

② 上下文装配(agent 服务, conversation.ts / agent.ts)
   ├─ messages 表读该会话最近 20 轮历史
   ├─ 链上装载人格: personaOf → keccak256 校验 → ownerOf(识别主人地址)
   ├─ 人格开关检查(emergency / autoReply)
   ├─ 记忆检索: fastembed 向量查语义记忆 + 最近情景记忆 → 注入 system prompt
   └─ buildInstructions: 人格 + 身份上下文 + "有工具必须调工具"规则

③ 模型决策(Kimi-K2)
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
   swapExactAVAXForTokens(amountOutMin, [WAVAX→USDC], 热钱包, deadline=now+600s)
   → value 附带原生币 → waitForTransactionReceipt
   → 核实 USDC 余额真实增加(防假成功)
   → 写 tasks 审计表

⑦ 回复生成
   工具结果(txHash/amountOut)回给模型 → 口语化中文回复

⑧ 落库收尾
   ├─ 问答写入 messages 表(会话历史)
   ├─ 写情景记忆(积累 10 条触发蒸馏成语义记忆)
   └─ 返回前端展示
```

## 3. 超限额时的审批分支

⑤ 判定 needsApproval 时:提案写 `approvals` 表(pending)→ 前端控制台「任务审批中心」20s 轮询展示
→ 用户点「放行并执行」→ `POST /approvals/:id/approve` → 走同一套 ⑥⑦⑧ → status=executed 带 tx_hash。
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

- Fuji 测试池流动性失真,汇率不代表真实行情(链路本身真实可用)
- Sepolia 上 defi-swap 需另注 Sepolia ETH 且确认 Uniswap V2 池子流动性
- M4 暂只支持 原生币→代币;代币→原生币需 approve + swapExactTokensFor*(后续)
