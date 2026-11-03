# NEAR 测试网 DeFi 接入方案（调研 + 分期计划）

> 2026-11 调研。背景：M2 之后产品已有 EVM（DEX/Aave/Benqi/GMX）与 Solana（Jupiter/Meteora/Drift）
> 两套 DeFi 技能体系，本方案为 NEAR 链补齐同样的能力。合约存活状态均经 fastnear testnet RPC 实测。

## 1. 测试网协议存活情况（实测）

| 协议 | 类型 | 测试网合约 | 状态 | SDK |
|---|---|---|---|---|
| **Ref Finance** | AMM DEX（含集中流动性 DCL） | `exchange.ref-dev.testnet`（v2）、`ref-finance-101.testnet`（v1，13.9MB）、`dclv2.ref-dev.testnet` | ✅ 全部存活 | `@ref-finance/ref-sdk`（npm，testnet 配置内置上述地址与代币清单） |
| **Burrow** | 借贷（存/借/还） | `contract.burrow.testnet` + `oracle.burrow.testnet` | ✅ 存活 | `burrow-sdk`（官方），前端仓库 near/burrow 可参考交互编码 |
| **Spin** | 订单簿现货 + 永续 | `contract.spin-fi.testnet`、`spot.spin-fi.testnet`、`v1.spin-fi.testnet`、`perp.spin-fi.testnet` | ✅ 合约存活 | `@spinfi/core` / `@spinfi/node` |
| ~~Meta Pool~~ | 流动质押 | `meta-pool.testnet` 等候选均为空账户 | ❌ 找不到存活合约 | — |
| 工具代币 | wNEAR / 假币 | `wrap.testnet`、`usdc/usdt/dai/weth/wbtc.fakes.testnet` | ✅（ref-sdk 内置清单） | — |

**结论：Ref（兑换）+ Burrow（借贷）可落地，Spin 合约虽在但项目已转向（主网 perp 由 Orderly 接手），仅列作可选调研项。**

## 2. 与现有架构的对接面

复用现有技能框架，不新造轮子：

- **技能注册**：`agent/src/skills/protocolSeeding.ts` 从 ChainConfig 自动 seeding `chain_protocols` 表；
  NEAR 侧给 `ChainConfig` 加 `near?: { refExchange?: string; burrow?: string }` 字段，
  协议 key 沿用现有约定风格：`ref-swap`（kind: `swap-near`）、`burrow`（kind: `lending`）。
- **权限门控**：`skills/registry.ts` 的 `protocolRequired/protocol` 机制对 near 链自动生效，无需改动。
- **策略引擎**：`policy/engine.ts`（单笔 $25 / 日累计 $125 / 冷却）链无关，直接复用。
- **执行模式**（对齐 Solana 的 split-brain）：
  - `hot_wallet`：agent 用 NEAR 热钱包私钥（新增 env `AGENT_NEAR_PRIVATE_KEY`，ed25519）经 near-api-js 直接签名广播 —— 需要新建 agent 侧 NEAR 写路径（当前只读）；
  - `user_wallet`：agent 组装 FunctionCall 交易 → 前端 wallet-selector（Meteor）签名广播 —— `chainNear.nearSignAndSend` 已具备该能力。
- **前端**：`chainNear.ts` 加 `refQuote/refSwap`、`burrowSupply` 等，`chainDispatch.ts` 分派；`ArenaPage` 的 Agent DeFi 展示链无关。

## 3. NEAR DeFi 特有的注意点

1. **NEP-145 存储注册**：Ref/Burrow 要求每个账户先存 ~0.1–0.25 NEAR 的 storage deposit（可退还）才能交易。
   接入必须含一步幂等的 `storage_deposit` 注册（写入路径第一件事，缺注册的交易会报 `InsufficientStorage`）。
2. **ft_transfer_call 模式**：NEP-141 代币兑换走 `ft_transfer_call(msg 带 swap 指令)`，单交易完成，比 EVM approve+swap 更简单；
   但需处理失败的 refund（合约自动退，agent 侧按最终余额对账）。
3. **报价**：Ref v2 view `get_return(pool_id, token_in, amount_in)`；ref-sdk 的 `fetchPools`/`getStablePools` 走 indexer API
   （indexer 对 testnet 支持弱，建议直接 view 调用 + 本地选池）。
4. **测试网固有坑**：流动性薄（报价滑点大、可能无对手盘）；fakes 代币无价值，策略引擎的金额上限形同虚设（演示性质）。

## 4. 分期计划

### P0：NEAR 写路径基建（前置，1 次性）
- `agent/src/chain/nearWrite.ts`：near-api-js（转 runtime deps）+ FailoverRpc + FunctionCall 签名广播；
  热钱包地址经 `AGENT_NEAR_PRIVATE_KEY` 注入；storage_deposit 注册助手。
- `config.ts`：`ChainConfig.near` 扩展 `refExchange/burrow` 字段；`ALL_CHAINS.near-testnet` 填入上表地址。
- `protocolSeeding.ts`：near 协议行自动 seeding。
- 验证：热钱包注册 Ref storage + 一笔 wNEAR→USDC(fakes) 兑换（测试网真钱仅 gas）。

### P1：Ref 兑换技能（核心演示价值）
- agent：`chain/ref.ts` —— `quote()`（view get_return）+ `swap()`（ft_transfer_call，双执行模式）+ 技能 `ref-swap` 注册进 makeTools。
- 前端：`chainNear.refQuote/refSwap` + chainDispatch；user_wallet 模式走 Meteor 签名。
- 验收：Agent 对话"把 1 wNEAR 换成 USDC"全链路（报价→策略引擎→执行→对账）。

### P2：Burrow 存借技能
- agent：`chain/burrow.ts` —— supply/withdraw/borrow/repay + `get_account` 健康度视图；技能 `burrow`。
- 验收：存入 USDC(fakes) → 借出 wNEAR → 偿还，账户健康因子可读。

### P3（可选）：Spin 合约
- 仅在前两项稳定后评估；先验证其 testnet API（place_order 是否可用、做市深度），大概率放弃。

## 5. 风险提示

- **钱包通道是最大不确定项**：当前 Meteor testnet 后端间歇 -32601，user_wallet 模式会同样受阻；
  hot_wallet 模式不依赖钱包，P1 建议优先做 hot_wallet 保证演示可用。
- 测试网协议随时可能停维护（MyNearWallet 退役是前车之鉴）；本方案所有投入应以"可平移到主网"为原则
  （合约地址走配置、不硬编码；主网 Ref/Burrow 均为活跃协议，迁移只需换地址+真币代币表）。
- 若后续上主网，fakes 代币表需替换为真实代币（USDC/USDT/wNEAR 合约地址），storage deposit 为真实资金（可退还）。
