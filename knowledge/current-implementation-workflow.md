# TinyWorld 当前实现流程(精简版)

> 已与合约代码和前端逐项核对,与《contract-design-and-workflow.md》的最初设计一致。
> 链:Sepolia | DIDIdentity: `0x363AF72fC15af43BfEA47C1ED09128Cd994946c1` | DIDParts: `0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959`

## 两个合约

- **DIDParts(ERC-1155)**:配件。同款多份,共 120 种(头/身/配饰/宠物 × 30)。
- **DIDIdentity(ERC-721 + Soulbound)**:DID 主身份。每地址限 1 枚,名字唯一,默认锁定不可转账;持有 4 个插槽,穿戴=把 1155 配件转入合约托管。

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
| 铸造工坊 | tokenIdOf / balanceOfBatch(显示持有态) | `DIDIdentity.mint` |
| 资产背包 | tokenIdOf / nameOf / getEquipped / balanceOfBatch | `setApprovalForAll`(首次)+ `equip` / `unequip` |
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

`contract/test/full-flow.test.js`(Hardhat + ethers v6,29 个用例)覆盖完整链路:
部署白名单 → registerPart 权限与约束 → mintPartBatch 与 maxSupply/mintable 强约束 → DID mint 与名称唯一性(含 `nameAvailable`)→ 授权/穿戴/换装/卸下 → Soulbound 锁定与销毁 → `setPersona` 持有者与 agent 权限。

运行: `cd contract && npx hardhat test test/full-flow.test.js`
