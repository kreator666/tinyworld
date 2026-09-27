# Avalanche 跨链桥(ICTT)学习心得

> 学习来源:[Academy 课程 — Native Token Bridge](https://docs.avax.network/academy/avalanche-l1/native-token-bridge)、[ICTT 官方协议文档](https://build.avax.network/docs/cross-chain/interchain-token-transfer/overview)、[avalanche-interchain-token-transfer 合约仓库](https://github.com/ava-labs/avalanche-interchain-token-transfer)
> 一句话概括:ICTT(Interchain Token Transfer)是 Avalanche 原生的跨 L1 代币转移协议,通过「Home 锁仓 / Remote 铸造」的抵押模型 + ICM 跨链消息实现,无需中心化桥。

## 1. 核心心智模型:TokenHome / TokenRemote

| | TokenHome(源头链) | TokenRemote(目标链) |
|---|---|---|
| 部署位置 | 资产原本所在的链 | 想引入该资产的其他 L1 |
| 职责 | 锁仓(lock)/ 释放(unlock) | 铸造(mint)/ 销毁(burn) |
| 数量关系 | 1 个 Home 可对应 N 个 Remote | 每个 Remote 只认 1 个 Home |

- **转移本质**:在 Home 链锁仓资产作为抵押,在 Remote 链铸造等量代币;转回时销毁 Remote 代币、解锁 Home 抵押。
- **注册**:Remote 部署后调用 `registerWithHome` 发 ICM 消息给 Home 完成注册,之后才能收发。注册是无许可的——任何人可部署 Remote,但用户需自行评估每个 Remote 的安全性。
- **Home 记账**:Home 合约跟踪发往每个 Remote 的余额,这是多跳转账和赎回的基础。

## 2. 抵押原则(1:1 背书)

Remote 上铸造的每一个代币,都必须有 Home 上锁仓的真实资产背书,否则就是无锚增发。课程里反复强调 **collateralization(抵押)**:

- 首次启用某个 Remote 前,要调用 Home 的 `addCollateral` 补足抵押;
- 抵押补全时 Home 发出 `CollateralAdded` 事件(`remaining = 0`),此后才能双向转账。

## 3. Native Minter Precompile:原生币铸造的关键

当目标是把某代币变成 L1 的**原生 gas 币**时(EAVM 原生币没有 burn 接口),需要启用 Native Minter 预编译:

- 在 L1 创世配置里,把**预先推导出的 NativeTokenRemote 合约地址**(按部署者 nonce 推算)加入 `mintNativeCoin` 白名单;
- **安全红线**:除 NativeTokenRemote 外,任何账户都不得有铸币权限,否则桥会抵押不足(undercollateralized);
- 销毁靠把原生币转到无主地址(`BURNED_FOR_TRANSFER_ADDRESS`);作为 gas 烧掉的部分通过 `reportBurnedTxFees` 报告回 Home,烧掉对应抵押。

### initialReserveImbalance(初始储备缺口)

如果创世块里预分配了一批原生币(比如 100 个),这部分没有 Home 抵押背书,构造 Remote 时要如实填写 `initialReserveImbalance = 100`,并在注册后通过 `addCollateral` 补足,否则 Home 会拒绝向该 Remote 放行转账。

## 4. 四种组合模式

Home/Remote 各自可以是 ERC20 或原生币,自由组合:

- ERC20 → ERC20(最普通)
- **ERC20 → Native(课程问题 1)**:把 Fuji C-Chain 的 USDC 变成自己 L1 的 gas 币
- **Native → ERC20(课程问题 2)**:把自己 L1 的原生币导出到 C-Chain 当 ERC20 用
- **Native → Native(课程问题 3)**:把 C-Chain 的 AVAX 变成自己 L1 的 gas 币

小数位差异用 **scaling** 处理,例如 USDC(6 位)在远端作为原生币(18 位)时按比例换算。

## 5. 进阶能力

- **Multi-hop(多跳)**:两个 Remote 之间转账(Ra → Rb)不是直连,而是 Ra → Home 记账 → Home 自动路由到 Rb。
- **ICM 消息费**:可给跨链消息附加费用激励 relayer 投递。单跳任意 ERC20 作费(需预授权);多跳时第二跳的费用**只能用被转移资产本身**从转账额中扣(因为中间链的交易不由用户钱包发起)。如果第二跳想用别的币付费,就拆成两次单跳。
- **sendAndCall**:一次 ICM 消息内完成「转账 + 合约调用」(如跨链直接 swap、付服务费);若目标合约调用失败,代币转入 fallback 地址,不会丢。
- 合约有 upgradeable(ERC7201 命名空间存储)与不可升级两个版本。

## 6. 实操要点(课程实验准备)

- Fuji C-Chain 测试 AVAX(水龙头)+ Core Wallet 插件;
- 问题 1 用 [Circle Faucet](https://faucet.circle.com/) 领真实测试 USDC(每次 1 个);
- 问题 1/3 需要创建带 Native Minter 预编译的 L1(用 `avalanche` CLI)。

## 7. 与 TinyWorld 的关联

- 我们当前部署在 Fuji C-Chain(合约 + Agent 的 defi-swap),属于「单链内操作」;ICTT 是「跨 L1」层的协议,两者不冲突。
- 若未来项目要发自己的 L1(此前 M2-pre 调研过 Primary Network),ICTT 就是让用户把 C-Chain 上的 USDC/AVAX 带进我们 L1 当 gas 币的标准路径(问题 1/3 的路线),也能把我们 L1 的代币导出到 C-Chain 进 DeFi(问题 2 的路线)。
- 抵押模型和「策略引擎/审批中心」的思路相通:都是「先锁定/授权,再放行」——ICTT 在资产层做 1:1 背书,我们的 Agent 在行为层做限额风控。

## 8. 关键词速查

`ICTT` `ICM(原 Teleporter)` `TokenHome/TokenRemote` `registerWithHome` `addCollateral / CollateralAdded` `Native Minter precompile` `initialReserveImbalance` `multi-hop` `sendAndCall` `BURNED_FOR_TRANSFER_ADDRESS`
