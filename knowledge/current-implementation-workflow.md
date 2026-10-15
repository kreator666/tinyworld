# TinyWorld 当前实现流程(精简版)

> 已与合约代码和前端逐项核对,与《contract-design-and-workflow.md》的最初设计一致。
> 链:Sepolia | DIDIdentity: `0x363AF72fC15af43BfEA47C1ED09128Cd994946c1` | DIDParts: `0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959`

## 两个合约

- **DIDParts(ERC-1155)**:配件。同款多份,共 120 种(头/身/配饰/宠物 × 30)。
- **DIDIdentity(ERC-721 + Soulbound)**:DID 主身份。每地址限 1 枚,名字唯一,默认锁定不可转账;持有 4 个插槽,穿戴=把 1155 配件转入合约托管。
- **StarterPartClaim(2026-10 新增)**:新手装备免费领养合约。owner 授 minter 权限后,持有 DID 的地址可自签领取池内 4 件普通装之一(每地址一次)。用户钱包自签自付 gas,Agent 热钱包不参与。测试:`contract/test/starter-claim.test.js`(8 用例);部署:`contract/scripts/deploy-claim.js`(部署后自动 `setMinter`)。

## 装备编号

| 类别 | chainId | slot |
|------|---------|------|
| 头部 | 1001–1030 | 0 |
| 身体 | 2001–2030 | 1 |
| 配饰 | 3001–3030 | 2 |
| 宠物 | 4001–4030 | 3 |

每类 30 件 = 普通 12(maxSupply 10000)+ 稀有 9(2000)+ 史诗 6(500)+ 传说 3(100)。

## 端到端流程

```
[部署]  Deploy.s.sol
        部署 DIDParts → 部署 DIDIdentity → setCollectionApproved 白名单
            ↓
[发行]  管理员后台(需 owner/minter)
        registerPart ×120(逐笔,页面带进度)   ← 定义装备:插槽/稀有度/上限
        mintPartBatch(按稀有度分 4 组)       ← 把装备发给玩家
            ↓
[玩家]  铸造工坊
        DIDIdentity.mint(name, bio)          ← 只铸 DID;选装备只是本地预览
            ↓
        资产背包
        balanceOfBatch 读取持有 → equip 穿戴
        (首次穿戴前端自动先 setApprovalForAll 授权托管;换装一笔交易,旧件自动退回)
```

## 页面对照

| 页面 | 读的链上数据 | 写的链上操作 |
|------|-------------|-------------|
| 铸造工坊 | tokenIdOf / balanceOfBatch(显示持有态) | `DIDIdentity.mint`;无装备选择(2026-10 起移除:选择本就不上链,装备改由新手大礼包随机发放) |
| 资产背包 | tokenIdOf / nameOf / getEquipped / balanceOfBatch | `setApprovalForAll`(首次)+ `equip` / `unequip`、StarterPartClaim.`claim`(新手装备领取,四选一,需先有 DID) |
| 管理员后台 | parts(id) / totalSupply(id) | `registerPart`(逐笔)+ `mintPartBatch` |
| 个人主页 | tokenIdOf / nameOf / getEquipped(本地 did 为空时回退) | 无 |

## 关键约束(合约强制)

- 未注册的 id 不能铸造、不能穿戴;插槽不匹配直接 revert。
- 铸造后 `totalSupply > maxSupply` 整体回滚 → 稀缺性硬约束。
- DID 转账/销毁前必须清空 4 个插槽,否则托管配件会卡死。
- 名称 burn 后仍永久保留,防冒名。

## 已知偏差(不影响主流程)

1. 合约还有 Soulbound 治理解锁、AI Agent 授权(`setAgent`/`setPersona`)、模块注册表等扩展,设计文档未覆盖,属增强。
2. ~~铸造页的名称查重是本地 mock 列表~~ **已修复**:连接 Sepolia 后走合约 `nameAvailable`(防抖 400ms),未连接时才用本地兜底;链上 mint 的 `NameTaken` 仍是最终约束。
3. ~~个人主页"保存人格配置"只写本地~~ **已修复**:连接 Sepolia 且已有 DID 时调 `setPersona(tokenId, uri, contentHash)` 真正上链;人格 JSON 以 data URI 形式作为 uri,链上存 keccak256 内容哈希保证完整性。

## 自动化测试

`contract/test/full-flow.test.js`(Hardhat + ethers v6,29 用例)覆盖完整链路:
部署白名单 → registerPart 权限与约束 → mintPartBatch 与 maxSupply/mintable 强约束 → DID mint 与名称唯一性(含 `nameAvailable`)→ 授权/穿戴/换装/卸下 → Soulbound 锁定与销毁 → `setPersona` 持有者与 agent 权限。

`contract/test/starter-claim.test.js`(8 用例)覆盖新手领取:池校验/重复领取/无 DID/未授权 minter/maxSupply 硬顶。

运行: `cd contract && npx hardhat test test/full-flow.test.js`

## 新手装备领取(2026-10,A 方案 v2)

- 合约 `StarterPartClaim`:`claim(partId)` 校验 池内 id + 未领过 + `tokenIdOf != 0`,然后 `mintPart` 1 件;池子 4 件普通装(默认 1001/2001/3001/4001,部署时可 env `CLAIM_POOL_IDS` 覆盖)。
- 用户 MetaMask 自签自付 gas;防刷全靠链上(claimed mapping + DID 门槛 + maxSupply 硬顶),无 DB 表。
- 前端:背包页「领取新手装备」卡片(evm 链 + 链配置含 `partsClaim` + 有 DID + 未领过才显示),`lib/chain.ts` 的 `fetchStarterClaimState`/`claimStarterPart`。
- 配置链路:合约地址写 agent chains 表 `config.partsClaim`(PUT /admin/chains/:key/config),前端 hydrateFromApi 透传;`web/src/lib/contracts.ts` 本地兜底字段 `partsClaim`。
- 部署(每链,owner key):`PARTS_ADDRESS=... IDENTITY_ADDRESS=... npx hardhat run scripts/deploy-claim.js --network <net>`(脚本内自动 setMinter)。

### 大礼包 v2(2026-10-15):随机四件套 + 自动穿戴

- **Fuji 当前权威地址**:DIDIdentity v2 `0x3ef5218e6D15b755c9bDC4298d0721b9886551eb`、
  StarterPartClaim v2 `0x3D98d0Ff048a82a387FDdfF0A4e10a1EF6FBe0f2`(DIDParts 不变 0x884d…0267)。
  旧 identity(0x386b…/0x15dC…)与旧 claim(0x03e5…/0x0DAb…)全部作废,minter 权限已撤销。
- DIDIdentity v2 语义变化:`equip` 放宽为 owner 或授权 operator(getApproved 单 token /
  isApprovedForAll),新增 `equipBatch` 一笔穿 4 槽;`unequip` 仍仅 owner。
- `claimPack()`:从每槽前 8 件(1001-1008 等)各随机 1 件(blockhash 伪随机)铸造并自动穿戴;
  未授权时领取成功但 dressed=false,前端引导手动穿。
- 新用户流程(最多 3 签名):setApprovalForAll(parts→identity) + approve(claim, tokenId) + claimPack。
- 端到端验证:`npx hardhat run scripts/e2e-fuji-starter-pack.js --network localhost`
  (需先 `npx hardhat node --fork <fuji-rpc> --fork-block-number <最新块>`,claimPack 显式 gasLimit 跳过 estimateGas——
  fork 上 estimateGas 对 blockhash 调用会挂);mainnet 未部署此功能。

## 装备铸造直售市场(2026-10-15)

- 合约 `PartsMarket`(P2C 铸造直售,原生币计价 chain-agnostic):owner 定价上架 `setPrice(s)`,
  用户 `buy(id, quantity)` 精确等值付款(不找零),合约现场铸新品(稀缺性由 maxSupply 硬顶保证),
  `withdraw` 提现。Fuji: `0xA0323a6E825912736F2C7b7e64920c71d8d27A31`(minter 权限已授)。
- 上架:普通装 48 件(1001-1012/2001-2012/3001-3012/4001-4012)各 0.01 AVAX;稀有以上不上架。
- **多链 native 配置**:服务端 chains.config `market:{address}`(只存地址,价格一律链上 listPriceOf 为准);
  前端价格展示/支付值用 `active.chain.nativeCurrency`(symbol/decimals),无 AVAX/18 硬编码。
  协议目录 seeding 新增 `market` 行(cfg.market 存在时推导)。
- 前端:背包页购买按钮接通——上架装备显示「购买 · 0.01 AVAX」;未上架保留原提示。
- 部署:`npx hardhat run scripts/deploy-market.js --network <net>`,支持 `MARKET_PRICES=1001:0.01,...` 批量上架。
- 注意:PGlite 脚本写库后必须 `await closeDb()` 再退出,否则 WAL 未落盘进程退出即丢(踩过)。
