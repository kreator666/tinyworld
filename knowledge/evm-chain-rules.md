# EVM 链体系规则总整理(2026-10-15)

> 适用范围:Sepolia / Fuji / Avalanche C-Chain 主网及未来新增 EVM 链。
> 一句话主线:**装备先注册进 DIDParts,再经三条路径之一到用户手里,最后穿戴进 DIDIdentity**。
> 本文是 EVM 侧的唯一权威规则文档;与旧文档冲突处以本文为准。

---

## 1. 合约清单(现役)

| 合约 | Fuji (43113) | 主网 (43114) | 职责 |
|------|-------------|-------------|------|
| DIDParts | `0x884dA9E2E1681Ada159e5DA0ddBb19bc858E0267` | `0xa3fB106DD25c02bf18170d6657EdF4804bf5D924` | 装备 ERC-1155:注册表 + 铸造 + maxSupply 硬顶 |
| DIDIdentity v3 | `0x38FE7970A66E98C6a1611951d1E7f5f510feE821` | `0xd04268d288b4981A40285e99fd42374D71f10949` | DID ERC-721:身份 + 四槽穿戴托管 + PERMISSION_SKILL |
| StarterPartClaim v2 | `0x3D98d0Ff048a82a387FDdfF0A4e10a1EF6FBe0f2` | `0x3510D466852a41Ed729Bbf2199b0B3743B627844` | 新手大礼包(仍指向旧 identity,如需配合新 identity 需重新部署) |
| PartsMarket | `0xA0323a6E825912736F2C7b7e64920c71d8d27A31` | `0xa5eF8B7b48f4b62c5834576b4C5CF5004B470377` | 铸造直售(原生币计价,价格未上主网) |

**已作废(勿交互)**:Fuji 旧 identity `0x386b…`/`0x15dC…`/`0x3ef5…`、旧 claim `0x03e5…`/`0x0DAb…`;主网旧 identity `0xf9111CbC…f3fE`/`0x0928…`。
主网另有 DIDReputation `0x319202A6…` / DIDValidation `0xfAEb8174…`(服役中,与装备经济无关)。

## 2. 权限模型(minter 体系)

- DIDParts 铸造权 = `owner` + `minters` 映射(`setMinter` 授权,`onlyMinter` 校验)。
- **现役 minter**:每条链两个——StarterPartClaim、PartsMarket;owner 隐式拥有。
- **已撤销**:Fuji 旧 claim 两代(`0x03e5…` 2026-10-15 撤、`0x0DAb…` 同日撤,txHash 可查运维手册)。
- **授权纪律**:任何新合约拿 minter 前必须确认其铸造路径收窄(claim 只铸池内 32 个 id;market 只铸已上架且已付款的 id);退役合约第一时间 `setMinter(addr, false)`。
- owner 私钥分工(严禁混用):
  - `contract/.env` 的 `PRIVATE_KEY` = `0xfEfd84C7…23766`(Fuji 部署者,Fuji Parts owner)
  - `contract/.keys/mainnet-owner.key` = `0x784D68dB…4018`(主网 owner,也是服务端 admin 白名单引导地址)
  - **主网一切操作必须显式 `PRIVATE_KEY=$(cat .keys/mainnet-owner.key)` 覆盖**,否则 hardhat 默认读 .env 的 Fuji key(主网余额为 0,且签名身份错误)。

## 3. 装备数据模型

- 120 件 = 4 类 × 30:头 `1001–1030`(slot 0)/ 身 `2001–2030`(1)/ 配饰 `3001–3030`(2)/ 宠物 `4001–4030`(3)。
- 每类 30 件 = 普通 12(maxSupply 10000)/ 稀有 9(2000)/ 史诗 6(500)/ 传说 3(100)。
- 注册(`registerPart`/`registerPartBatch`,onlyOwner)是任何 id 进入经济体系的**唯一入口**:未注册不能铸、不能穿、不能卖、不能进礼包池。
- 两个软开关:`mintable=false` 绝版(链上 still 可转);`maxSupply` 硬顶,铸造超量整笔回滚(稀缺性唯一真源)。
- 素材目录(名称/图)全链统一一套,链无关;链上只认 id。

## 4. 三条分发路径(互斥定位,不可混用)

### 4.1 新手大礼包(免费,拉新)
- `claimPack()`:每槽前 8 件各随机 1 件(blockhash 伪随机,测试网价值下可接受),铸 4 件给用户并**自动 equipBatch 穿上**。
- 防刷全链上:每地址一次(`claimed` mapping)+ 必须有 DID(`tokenIdOf≠0`)+ maxSupply 硬顶;无 DB。
- 硬规则:池内 32 个 id 必须全部 registered 且 mintable,**缺一即整笔回滚**(原子);owner 可 `setPartMintable` 关池。
- 穿戴前置:用户需先完成两授权(DIDParts→identity 托管、identity→claim 合约 operator);未授权领取仍成功但 `dressed=false`,前端兜底引导。
- 新用户动线:铸造工坊铸 DID(已无装备选择)→ 自动跳背包 → 开箱(最多 3 签名)。

### 4.2 铸造直售市场(付费,常规获取)
- `buy(id, quantity)` payable:精确等值付款(`msg.value == price × qty`,不找零);合约现场铸新品——**无库存概念,稀缺性由 maxSupply 硬顶保证**。
- 价格只存在于链上(`listPriceOf`),服务端/前端只存合约地址;`setPrice(s)` onlyOwner。
- 上架纪律:Fuji 已上普通装 48 件 × 0.01 AVAX;稀有以上不上架(保稀缺);**主网价格未上架**(真实币定价属产品决策,定后用 `MARKET_PRICES` 一条命令上)。
- chain-agnostic:原生币计价,换 EVM 链不改合约;前端 symbol/decimals 一律取 `active.chain.nativeCurrency`,禁止硬编码 AVAX/18。

### 4.3 运营铸造(后台 mintPartBatch,定向免费)
- 唯一适用场景:活动空投 / 中奖 / 补偿等**定向发放**。
- 红线:禁止做大规模常规分发——绕过市场定价与大礼包限领,破坏经济可预测性(后台页面已写此警告)。
- 页面定位:register 是高频(出新装备必用);mintPartBatch 是低频运营工具。

## 4.5 BENQI 流动性质押(主网专属,2026-10-15)

- 合约(双用途:质押逻辑+sAVAX 代币同一地址,官方文档+链上双源核实):`0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE`(主网)。
- 机制:`submit()` payable 即时铸 sAVAX(无最小额);赎回 `redeem()` 两段式——**15 天冷却 + 2 天领取窗口**过期重排;AMM 卖出可即时退出。
- 技能 `defi-staking`(主网专属,protocolRequired):`propose_stake`(报价→策略引擎→双模式执行)+ `staking_status`(只读);赎回工具未开放(v2 配 ticket 追踪+到期提醒)。
- 真实 e2e:0.1 AVAX → 0.077508555 sAVAX,与链上报价分毫不差(tx `0x8e01…d575`)。
- 不在默认安装清单(主网资产操作,手动安装)。

## 5. 身份层规则(DIDIdentity v2)

- 每地址限 1 枚、名称唯一(大小写不敏感,burn 后名字永久保留)、默认 Soulbound 锁定。
- **equip operator 语义**(v2 起):`equip`/`equipBatch` 可由 owner 或其授权 operator 调用(`getApproved` 单 token 或 `isApprovedForAll`)——这是大礼包自动穿戴的基石;`unequip` 仍仅 owner。
- 穿戴 = 1155 转入 identity 托管(前置:`setApprovalForAll(identity)`);换装一笔交易,旧件自动退回;DID 转让前必须清空四槽。
- 未注册 id / 插槽不匹配一律 revert。

## 6. 服务端链配置体系(多 EVM 链的地基)

```
chains 表(固有列:chain_key/chain_id/name/family/rpc/explorer/identity_address/parts_address/enabled)
  └─ config JSONB: defi / aave / market{address} / partsClaim / nativePriceId / nativeGatePair / rpcFallbacks / solana
chain_protocols 表: (chain_key, protocol_key, kind, config JSONB, enabled, updated_by, updated_at)
```

- **DB 是权威**:`seedChains` 启动 upsert(固有列覆盖更新,**config 列只在 INSERT 时写**——存量库的 config 变更必须走 admin API);`registry.ts` 启动时 `applyDbChains`(支持 DB-only 新链免重启热注册)+ `applyDbChainConfigs`(config overlay 深合并 defi/aave/solana)。
- **协议注册表**:协议 key 约定 `dex`/`lending`/`market`/`starter-claim`/`benqi-staking`/`jupiter`/`meteora`/`drift`;启动时对无行的链从 ChainConfig 自动 seeding(幂等,尊重人工停用)。主网专属协议的技能 manifest 需 `protocolRequired: true`(无协议行即隐藏,防止回落 family 逻辑误显示)。
- **技能 gating 三态优先级**:协议表 disabled 行 > enabled 行(接管) > 无行(回落老配置检查)。
- 前端:`GET /chains` 组装两层(chains + protocols)返回;本地 `contracts.ts` 只作服务不可达时的兜底。
- native token:前端展示/支付一律 `active.chain.nativeCurrency`;服务端估值用 `nativePriceId/nativeGatePair` 行情源。

## 7. 治理(admin API)

- 鉴权 = **管理员钱包签名**(SIWE JWT + `admin_whitelist` 表),废弃静态 token;admin 路由跨链全局、不校验 X-Chain-Key;每次写操作落 `admin_audit`。
- 引导:服务端 `.env` 的 `ADMIN_ADDRESS`(公钥,当前 = 主网 owner 0x784D…);白名单为空时所有 admin 接口不可用(无后门)。
- 端点:`POST /admin/chains`(动态加链,免重启)、`PUT /admin/chains/:key/config`、`PUT/DELETE/GET …/protocols[/:pkey]`、`GET/POST/DELETE /admin/admins`(拒删最后一个)。
- 现成配置脚本:`node contract/scripts/admin-put-chain-config.mjs <chainKey> '<json>'`(用主网 owner key 签 SIWE 走正规 API)。
- nginx 反代必须含 `/admin`(2026-10-15 补,漏了会 405)。

## 8. 新增一条 EVM 链的操作手册

1. 部署 DIDParts → `registerPartBatch` 注册装备目录(或脚本批量);
2. 部署 DIDIdentity v2 → `setCollectionApproved(parts)`;
3. 部署 StarterPartClaim v2 + PartsMarket → 分别 `setMinter(true)`;
4. 服务端:`POST /admin/chains` 插链(含 identity/parts 固有列;**免重启热注册**),`PUT …/config` 写 defi/aave/market/nativePriceId;
5. 前端:`contracts.ts` 本地兜底加同 key 条目(chain 定义用 viem 内置或自定义 Chain);
6. 可选:`deploy-market.js MARKET_PRICES=…` 上架;大礼包池自动可用(前提:对应 id 已注册)。

## 9. 运维红线

- **PGlite 禁止双进程并发访问**:agent 服务运行时,绝不独立 tsx 直连 `agent/data` 改库(两实例各写 WAL,旧快照覆盖新数据,改动无声丢失——已踩过)。改配置只走 admin API;脚本直改仅限服务停止时且必须 `await closeDb()` 后退出。
- 部署命令(Fuji 用 .env 默认 key;主网必须显式覆盖):
  - 大礼包:`DEPLOY_IDENTITY_V2=1 PARTS_ADDRESS=… npx hardhat run scripts/deploy-claim.js --network <net>`
  - 市场:`PARTS_ADDRESS=… [MARKET_PRICES=…] npx hardhat run scripts/deploy-market.js --network <net>`
- 每次部署后链上四查:双 minter、identity 配件白名单、池/上架状态、claim claimed 状态。
- 测试币:Fuji owner `0xfEfd…`(core.app 水龙头);主网 owner 余额见运维手册 §11。

## 10. 相关文档索引

- 部署与故障:`operations-guide.md`(§10 多链架构、§11 主网部署记录)
- Agent 运行时与技能:`agent-runtime-design.md`(§11 多链、§14 现状)
- 合约测试:`current-implementation-workflow.md`(自动化测试段)
- 礼包 v2 与市场细节:`current-implementation-workflow.md` §新手装备领取 / §装备铸造直售市场
