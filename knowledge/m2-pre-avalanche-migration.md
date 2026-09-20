# M2-pre:合约迁移 Avalanche 方案与计划

> 在 M2(记忆+技能)之前执行。目标:合约部署到 Avalanche C-Chain(先 Fuji 测试网),前端与 agent 服务支持按链配置,全链路在 Fuji 上验证通过后再开始 M2。
> 依据:[Avalanche Primary Network 官方文档](https://build.avax.network/docs/primary-network)

## 1. 为什么部署在 C-Chain

Avalanche Primary Network 有三条链:

| 链 | 职责 | 是否适合我们 |
|----|------|-------------|
| **C-Chain** | EVM 合约链(Geth API 兼容,Solidity) | ✅ 就是它 |
| P-Chain | 验证者/L1 管理、质押 | ❌ 平台层操作 |
| X-Chain | Avalanche 原生资产(非 EVM) | ❌ 不支持 Solidity |

我们的 DIDIdentity(ERC-721+Soulbound)和 DIDParts(ERC-1155)是纯 EVM 合约,C-Chain 完全兼容,**合约源码零改动**。

## 2. 网络参数

| | Fuji 测试网(先) | Avalanche 主网(后) |
|---|---|---|
| chainId | **43113** (0xa869) | **43114** (0xa86a) |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` | `https://api.avax.network/ext/bc/C/rpc` |
| 浏览器 | `https://testnet.snowtrace.io` | `https://snowtrace.io` |
| Gas Token | 测试 AVAX(faucet 免费领) | AVAX |
| viem 内置链 | `avalancheFuji` | `avalanche` |

水龙头:Avalanche 官方 Faucet(`https://core.app/tools/testnet-faucet/`,可选 coupon 加速)。

## 3. 合约层改动(很小)

`contract/` 目录:

1. **hardhat.config.js**:`networks` 增加 `avalancheFuji` / `avalanche` 两项(RPC + PRIVATE_KEY 读 .env,与现有 sepolia 模式一致);`etherscan` verify 配置加 Snowtrace(走 Routescan API,需要时在 `.env` 配 `SNOWTRACE_API_KEY`,不验证也能跑)。
2. **evmVersion 确认**:当前 `cancun`。C-Chain 已跟进以太坊 Cancun 升级,但**部署后第一时间跑冒烟交易验证**;若遇到 opcode 不兼容,降级为 `shanghai` 重新编译部署(编译器输出会变,属预案,预期用不上)。
3. 部署脚本复用 `scripts/deploy.js`:`npx hardhat run scripts/deploy.js --network avalancheFuji`。
4. 测试:现有 `test/full-flow.test.js`(29 用例)本地跑保持不变;部署后在 Fuji 上用 `scripts/seed.js` + 管理员后台做真实冒烟。

## 4. 前端改动(web/)——已按修正后的设计实施

> 修正(2026-09-19):切链不是环境变量,而是**导航栏按钮**;合约地址以**后端 chains 表 + GET /chains** 为准,前端本地数据兜底;**素材全链统一一套**(角色库/装备目录与链无关,Fuji 已注册全量 120 件,与 Sepolia 完全一致)。

1. `contracts.ts` = 纯数据(本地兜底副本):`CONTRACTS_BY_KEY`(sepolia/fuji)+ ABI + 配件注册表。
2. `store/chainConfigStore.ts` = 激活链状态:`active`/`chains`/`setActive`/`hydrateFromApi`(启动时拉 `GET /chains`,按 chain_id 匹配合并,服务不可达静默用本地)。
3. `chain.ts` 全部读写函数改为运行时 `getActiveChain()` 取当前链的地址/RPC,不再有任何静态链常量。
4. NavBar 新增切链下拉按钮:切换 → 钱包跟随切链(`ensureTargetChain`)→ 链上数据自动重拉。
5. agent 服务:`chains` 表(启动时种子 upsert)+ `GET /chains` 接口。

## Fuji 全量装备注册(2026-09-19)

- `contract/scripts/fuji-register-all.js`:按目录规则(4 类 × 30 件,稀有度 12/9/6/3)注册,幂等
- 结果:新注册 88 + 跳过 32 = **120/120 全部注册**;另给管理员铸造 12 件演示装备(每类前 3 件)

## 5. agent 服务改动(agent/)

`config.ts` 目前是单个 `identityAddress`/`sepoliaRpc`,改为与前端同源的"按链配置"表(或抽 `@agentverse/chain-config` 共享包,二选一,先用各自维护的小表控制改动面),同样用环境变量 `TARGET_CHAIN` 选择。

## 6. 执行计划(按序)

| 步骤 | 内容 | 验收 |
|------|------|------|
| 1 | hardhat 配置加 Fuji 网络;.env 模板补 `FUJI_RPC_URL`/`SNOWTRACE_API_KEY` 说明 | ✅ 已完成 |
| 2 | Fuji faucet 领测试 AVAX(部署地址) | ✅ 部署地址已有 0.5 AVAX |
| 3 | `deploy.js --network avalancheFuji` 部署 DIDParts + DIDIdentity + 白名单 | ✅ 已部署(见下) |
| 4 | Fuji 冒烟:mint DID → setPersona → registerPart ×2 → mintPartBatch → approve → equip → unequip(脚本或管理员页) | ✅ `scripts/fuji-smoke.js` 全部通过 |
| 5 | 前端/agent 接入按链配置,`VITE_TARGET_CHAIN=fuji` 跑通:连接钱包自动切 Fuji、铸造、背包、广场、消息页 | ✅ 已完成(前端默认目标链=fuji) |
| 6 | agent 服务在 Fuji 上验证:人格装载 + 对话 | ✅ 已验证(Fuji 人格装载 fromChain:true,对话符合人格;Sepolia 回退 TARGET_CHAIN=sepolia 实测可用) |
| 7 | (可选)snowtrace verify 合约源码 | 待执行 |
| 8 | 更新知识库文档里的地址表;主网(43114)部署留作上线前单独执行 | 部分完成 |

## Fuji 部署结果(2026-09-18)

- DIDIdentity: [`0x15dC02b5678b8454C75EeA0208C1C027b1903d9c`](https://testnet.snowtrace.io/address/0x15dC02b5678b8454C75EeA0208C1C027b1903d9c)
- DIDParts: [`0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2`](https://testnet.snowtrace.io/address/0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2)
- 部署者/owner: `0xfEfd84C7e1c225EBA02DCaA3A822e648ADe23766`
- Cancun EVM 兼容(全部交易成功);冒烟已铸造 tokenId=1 "Diego" 并完成人格上链与四槽穿戴验证
- 冒烟脚本: `contract/scripts/fuji-smoke.js`(可重复执行,幂等)

**回退策略**:Sepolia 配置保留在表中,`VITE_TARGET_CHAIN=sepolia` 即可整体切回,互不干扰。

## 7. 风险与注意

- **Sepolia 上的已有数据(3 个 Agent、装备注册)不会迁移**,Fuji 是全新起点;旧数据靠切链配置回看。
- Snowtrace 的合约 verify 走 Routescan,与 Etherscan API 略有差异,验证失败不阻塞流程。
- MetaMask 的 EIP-7702 智能账户/委托行为在 Fuji 上同样透明(此前 Sepolia 已验证),无需处理。
- C-Chain 出块约 2 秒且最终性快,前端 `waitForTransactionReceipt` 体验会比 Sepolia 更好。
