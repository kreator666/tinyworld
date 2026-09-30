# Avalanche 官方跨链协议调研 & Agent 接入方案

> 调研时间:2026-09 | 前置笔记:`knowledge/avax-ictt-bridge-notes.md`(ICTT 原理)
> 一句话结论:Avalanche 官方跨链栈 = **ICM(节点层 Warp 消息)→ ICM Contracts(TeleporterMessenger)→ ICTT(代币转移应用层)**,配套有 2025 年新出的**官方 TS SDK(beta)** 和 **AvaCloud Data API 消息查询**;但**没有官方运营的 canonical TokenHome**,想用桥的前提是目标资产的 Home/Remote 已被部署注册——所以我们的接入路径分「用已有桥」和「自建桥」两档。

---

## 1. 官方跨链协议实现版图(2025 末现状)

分层架构(自上而下):

```
ICTT (TokenHome/TokenRemote 锁仓-铸造)        ← 应用层,我们的主要接入点
ICM Contracts (TeleporterMessenger + Registry) ← 消息协议层,固定地址部署
ICM / AWM (AvalancheGo 内建 Warp Messaging)    ← 节点层,BLS 聚合签名
ICM Relayer (ava-labs/icm-services, Go)        ← 投递层,任何人可跑
```

| 组件 | 现状 | 关键地址 / 仓库 |
|------|------|----------------|
| ICM(原 AWM/Teleporter 底层) | 活跃,AvalancheGo 内建 | `ava-labs/avalanchego` |
| TeleporterMessenger | 活跃,非可升级,Nick's method 部署到**所有链统一地址**(仅同 major 版本互发) | 主网/Fuji 均为 `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf` |
| TeleporterRegistry | 官方注册表,按版本路由 | Fuji C-Chain `0xF86Cb19Ad8405AEFa7d09C778215D2Cb6eBfB228`;主网 `0x7C43605E14F391720e1b37E49C78C4b03A488d98` |
| ICTT 合约 | 活跃,`contracts/ictt/`;旧仓库 avalanche-interchain-token-transfer 已并入 icm-contracts;icm-contracts 正整体迁往 **icm-services** | `ava-labs/icm-contracts` → `ava-labs/icm-services` |
| **官方 TS SDK** | **2025 年新出,Developer Preview(beta)**,viem 兼容,monorepo:`@avalanche-sdk/client` / **`@avalanche-sdk/interchain`**(ICM 发消息 + ICTT 部署/转币全套 helper)/ `@avalanche-sdk/chainkit`(Glacier API 封装) | `ava-labs/avalanche-sdk-typescript` |
| CLI | `avalanche-cli` 的 `interchain` 系列命令;新 Avalanche Console(build.avax.network/console)有 ICM Setup / ICTT Bridge 可视化菜单一键建桥 | 官方文档 CLI 页 |
| ICM Relayer | 开源 reference implementation,监听源链 Warp 日志 → 收 BLS 签名 → 目标链提交;**每条目标链需配置一个出资私钥付 gas** | `ava-labs/icm-services` |
| ACP-77 | 已生效(Etna 升级),L1 验证人管理迁 P-Chain + ValidatorManager 合约 | 与跨链消息配合做 L1 生命周期管理 |
| 第三方桥(CCIP/Wormhole/Axelar/LZ) | 生态选项,不在官方 cross-chain 文档核心路径 | — |

## 2. 对「纯链下调用者」的支持度(关键事实)

- **没有 Ava Labs 官方运营、对公众开放的 canonical TokenHome**(不存在"官方 AVAX home / USDC home"地址表)。ICTT 是 permissionless 部署:home 由代币方部署,remote 任何人可部署并 `registerWithHome` 注册。Fuji 上 Academy 示例 L1(Dispatch/Echo 等)有教学部署,属示例性质。
- **用户侧转币流程**(home→remote 单跳,ERC20):
  1. `approve(TokenHome, amount + primaryFee)`(费币也要 approve);
  2. `TokenHome.send(SendTokensInput, amount)`(`NativeTokenHome.send(input)` payable);
  3. 源链 `TokensSent(teleporterMessageID, ...)` 事件 = 跨链凭证;目标链 `TokensWithdrawn` = 到账。
- `SendTokensInput` 关键字段:`destinationBlockchainID`(bytes32)、`destinationTokenTransferrerAddress`、`recipient`、`primaryFeeTokenAddress`/`primaryFee`(可选,ERC20 付费需预授权)、`secondaryFee`(multi-hop 第二跳,**只能用被转资产本身**从金额中扣)、`requiredGasLimit`、`multiHopFallback`。
- **消息状态跟踪**:
  1. **AvaCloud Data API(原 Glacier)Teleporter 端点**——官方索引器,按地址列消息、带 `status`(pending/delivered),TS 封装在 `@avalanche-sdk/chainkit`;
  2. 链上自查:源链 `TokensSent` 拿 messageID → 轮询目标链 `TokensWithdrawn`;
  3. icm-relayer 自带 `/relay`、`/health` HTTP API + Prometheus(操作接口,非查询浏览器)。
- **Relayer 与费用**:任何人可跑 relayer;协议**不强制付费**——`feeInfo` 是可选激励(fee 锁在源链,relayer 交付后凭回执 `redeemRelayerRewards` 领取,不够可 `addFeeAmount` 追加)。Ava Labs 对官方测试 L1/主网周边运行了 relayer 基础设施,但这是运营事实而非协议保证;**自建 L1 必须自行安排 relayer**。fee 全 0 = 赌有免费 relayer。
- **没有独立官方"ICM 浏览器"网页**;最接近的是 AvaCloud Data API。
- **sendAndCall**:单条消息内「转账 + 目标链合约调用」,失败时 token 转给 `fallbackRecipient` 不卡死。目标合约必须实现 `IERC20SendAndCallReceiver.receiveTokens(...)` 或 `INativeSendAndCallReceiver.receiveNativeTokens(...)`;`originSenderAddress` 仅在 originTokenTransferrer 可信时才可信。

## 3. 我们 Agent 的现状(接入设计的约束)

来自 `agent/` 代码调研(详见 `knowledge/agent-runtime-design.md` §14):

- **单链假设**:`config.chain` 全局唯一(`config.ts:32-82`,TARGET_CHAIN env 二选一),policy 硬规则直接拒绝非当前链 chainId(`policy/engine.ts:89`);`chain/defi.ts`、`aave.ts`、`persona.ts` 各自重复建 client。
- **执行骨架可复用**:hot_wallet / user_wallet 双模式、unsigned tx 组装 + 前端签名(`sign_tx` 侧信道)、审批中心(approvals 表)、熔断(估值失败拒绝执行)、tasks 审计表、回执+余额差核实——跨链 transfer 可直接套这套闭环。
- **无任何事件订阅/日志轮询基建**:所有确认都是 `waitForTransactionReceipt`;跨链「等 ICM 落地」需新写轮询。
- Skill = TS 清单对象 + `registerSkill` 一行注册,Mastra tool;新增 `crosschain-bridge` skill 成本低。
- 估值写死 AVAX 计价(`core/price.ts`),跨链场景要支持按目标链计价。

## 4. 接入方案

### 4.0 场景分档(先想清楚做哪档)

| 档 | 场景 | 前提 | 工作量 |
|----|------|------|--------|
| **A. 用已有桥** | Agent 替用户在**已部署好 Home/Remote 对**的链间转币(Fuji C-Chain ↔ 某 L1) | 找到/确认目标资产的 home/remote 地址对已在链上注册 | 小(纯链下交互) |
| **B. 自建桥(自有代币跨 L1)** | 项目发自己的 L1 后,用 ICTT 把 C-Chain 上的代币(如 USDC)引入自家 L1 当 gas 币(ERC20→Native,需 Native Minter 预编译) | 部署 L1(创世配置 Native Minter 白名单)+ 部署 TokenHome/Remote + addCollateral 补抵押 | 大(合约 + L1 运维) |
| **C. 跨链 DeFi(sendAndCall)** | 一次消息完成「跨链 + 目标链 swap/支付」 | 目标链接收合约实现 `receiveTokens` 接口 | 中(需写目标链接收合约) |

**建议路线:A → C → B(按需)**。A 是纯软件工作,先把 Agent 的跨链操作/跟踪能力做出来;C 是差异化能力(跨链 swap);B 绑定「是否发 L1」的产品决策,到时再做。

### 4.1 架构改造(三处)

1. **多链 client 工厂**:把 `config.chain` 单链全局改为 `getChainConfig(chainKey)` + `getPublicClient(chainKey)` / `getWalletClient(chainKey)`,defi/aave/persona 逐步迁移。policy 硬规则的「chainId 必须等于当前链」放宽为「chainId 必须在 `CHAINS` 表内 + 该链有对应合约配置」。
2. **新增 `agent/src/chain/ictt.ts`**:基于 viem 直接拼 ICTT 调用(ABI 从 icm-contracts 拷 `ITokenTransferrer`/`IERC20TokenHome`/`INativeTokenHome` 接口即可,**暂不引入 beta SDK**,避免 preview 依赖进生产;SDK 可作参考实现)。导出:
   - `quoteBridge(homeAddr, destChainId, remoteAddr, amount)` → 读 remote 的 `tokenBalance`/`isRegistered` + 估 fee;
   - `buildSendTx(...)` / `buildSendAndCallTx(...)` → unsigned tx,复用现有 `sign_tx` 侧信道;
   - `executeBridge(...)`(hot_wallet)→ approve + send 两步,回执核实 + 记 `TokensSent` 的 messageID;
   - `checkBridgeStatus(srcChainKey, messageId, dstChainKey)` → 轮询目标链 `TokensWithdrawn`(主),可选 AvaCloud Data API(备,需 API key)。
3. **链上合约注册表扩展**:`chains` 表/配置里加 `ictt` 字段 `{ tokenHome: {...}, tokenRemotes: { [chainKey]: {...} } }`,策略引擎白名单改为「每链一份地址表」。**Agent 只与白名单内的 Home/Remote 对交互**(home/remote 是 permissionless 的,防钓鱼 remote 全靠这层白名单)。

### 4.2 新 Skill:`crosschain-bridge`

```
manifest: { id:'crosschain-bridge', version:'0.1.0', tools:['propose_bridge','check_bridge'],
            permissions:['defi'], scope:'owner' }
```

- `propose_bridge(token, amountIn, destChainKey, recipient?, executionMode)`:
  1. 校验目标链该 token 的 remote 在白名单且已 `isRegistered`;
  2. 报价(含 fee、scaling 后实际到账额、估算时长);
  3. 组 Proposal `{ action:'bridge', protocol: tokenHome 地址, chainId: 源链, params:{ tokenIn, amountIn, destChainKey, remoteAddr, recipient, primaryFee... }, executionMode, estimatedValueUsd, reason }`;
  4. 过策略引擎 → execute / needsApproval / rejected,完全复用 defi-swap 的分发逻辑。
- `check_bridge(messageId)` → 查跨链状态(pending/delivered/超时),供主人追问"我那笔跨链到账了吗"。
- 执行(hot_wallet):`approve(home, amount+fee)` → `home.send(input, amount)`;**回执核实分两段**:源链段复用现有 receipt+余额差;目标链段由 `check_bridge_status` 轮询 `TokensWithdrawn` 事件(新写轻量 poller,不进心跳),落地后写 tasks.result 并主动通知主人。user_wallet 模式走 unsigned tx + 前端签名,不变。

### 4.3 策略引擎扩展(`policy/engine.ts`)

- 新增 `action: 'bridge'` 分支:
  - 硬规则:源/目标链都在 `CHAINS` 白名单;home/remote 地址对在该链配置内;remote `isRegistered` 为真(链上读,防未注册 remote 吞币);
  - 软规则:复用单笔/日累计/冷却;**跨链单笔默认阈值应显著低于 swap**(建议 $10 起,env 可调),needsApproval 是常态;
  - 提案必须带 `estimatedValueUsd`,估值失败熔断(现有逻辑直接复用)。
- 熔断补充:目标链 RPC 不可达、消息 pending 超 N 分钟 → 任务标记 `uncertain`,提示主人用 messageID 去浏览器自查,**Agent 不得自行重发**(防双花——重发前必须确认源链 send 未成功)。

### 4.4 里程碑

| 里程碑 | 内容 | 依赖 |
|--------|------|------|
| M5a 跨链跟踪(只读) | 多链 client 工厂 + `check_bridge` 工具 + AvaCloud API 或事件轮询 | 选定一对 Fuji 上可用的 home/remote(Academy 示例或自行部署一对测试桥) |
| M5b 跨链转账 | `propose_bridge` + 策略引擎扩展 + hot/user 双模式执行 + 两段回执核实 | M5a |
| M5c 跨链 DeFi | 目标链接收合约(`receiveTokens` 内调 DEX)+ `sendAndCall` 工具 | M5b + 写目标链接收合约 |
| M5d 自有 L1(按需) | 用 Console/CLI 建 L1(Native Minter 白名单含预先推导的 NativeTokenRemote 地址)→ deployTokenHome/Remote → addCollateral → ERC20→Native gas 币桥通 | 产品决策:是否发 L1 |

### 4.5 风险与红线

1. **没有官方 canonical 桥**:Agent 白名单外的 home/remote 一律不碰;用户自填 remote 地址必须 rejected。
2. **Native Minter 红线**(M5d):白名单除 NativeTokenRemote 外不得有任何铸币权限,否则桥抵押不足——`initialReserveImbalance` 如实填报并补抵押。
3. **Relayer 不保证免费**:M5a 先观测 Fuji 目标链消息投递延迟;生产需评估付费(feeInfo)或自建 relayer。
4. **SDK 是 beta**:`@avalanche-sdk/interchain` 只作参考,不直接依赖;所有 ABI 以 icm-contracts 仓库源码为准。
5. **仓库迁移中**:icm-contracts → icm-services,引用文档/地址时以 build.avax.network 官方文档为准。
6. **跨链不可重发**:源链 send 成功但目标链未落地时,只有 ICTT 协议的 multi-hop/回执机制能处理,Agent 侧只允许查询和上报,不允许自动重试。
