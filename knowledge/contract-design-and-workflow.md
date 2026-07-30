# TinyWorld 合约设计思想与使用流程

## 1. 为什么要先 `registerPart`？

`registerPart` 的存在把**“定义一种装备”**和**“把装备发出去”**这两件事分开了。

### ① 装备元数据需要被链上约束

```solidity
struct PartInfo {
    uint8 slot;       // 0=头 1=身 2=配饰 3=宠物
    uint8 rarity;     // 0=普通 ... 3=传说
    uint96 maxSupply; // 最大供应量，必须 >0
    bool mintable;    // 是否还能继续铸（可绝版）
    bool registered;  // 是否已经上架
}
```

- `slot`：保证“头部装备”不能穿到“身体”位置。
- `rarity`：虽然不能自动约束掉落概率，但给市场和渲染提供了链上标准。
- `maxSupply`：硬顶，铸造时 `totalSupply > maxSupply` 会直接 revert，做真正的稀缺性。
- 没有 `registerPart`，任何人都可能用一个随意的 `chainId` 绕过这些校验去 mint。

### ② 权限分离

- `registerPart` → `onlyOwner`：只有部署者/治理方能决定“游戏里有哪几种装备”。
- `mintPart` / `mintPartBatch` → `onlyMinter`：owner 可以把卖货/空投权限授权给另一个合约或地址，自己不必每笔都签名。

这样未来可以接“预售合约”“抽奖合约”“任务奖励合约”，它们只负责 mint，不需要 owner 私钥。

### ③ 绝版控制

`setPartMintable(id, false)` 可以让某个装备停止铸造。适合限时活动、赛季装备等场景。

---

## 2. 整体使用流程

```
部署 DIDParts → 部署 DIDIdentity → DIDIdentity 把 DIDParts 加入白名单
       ↓
owner 调用 registerPart 上架装备（例如 120 件）
       ↓
owner/授权 minter 调用 mintPartBatch 把装备发给玩家
       ↓
玩家调用 DIDIdentity.mint 铸造自己的 DID 主身份
       ↓
玩家调用 DIDParts.setApprovalForAll 授权 DIDIdentity 托管
       ↓
玩家调用 DIDIdentity.equip 把配件穿到 DID 上
```

### 对应到前端页面

| 页面 | 实际链上操作 | 说明 |
|------|-------------|------|
| 铸造工坊 | `DIDIdentity.mint` | 只铸造 DID 主身份；装备选择只是本地预览 |
| 资产背包 | `DIDParts.balanceOf` + `DIDIdentity.equip` | 读取已持有配件并穿戴到 DID |
| 管理员后台 | `DIDParts.registerPart` + `DIDParts.mintPartBatch` | owner/minter 发行真正的装备 |

---

## 3. 为什么用 ERC-1155 而不是 ERC-721？

装备不是“每一件都独一无二”，而是“同一款式可以有很多人持有”：

- `head-1` 可以有 10000 份，大家穿的都是同一个款式。
- ERC-1155 的 `balanceOf(address, id)` 天然适合这种“同款多份”。
- 只有 DID 主身份是 ERC-721，因为它是每地址唯一的身份容器。

---

## 4. 当前设计代价与优化方向

代价就是上架装备需要发很多交易。120 件装备需要 120 笔 `registerPart`。

如果想优化，未来重新部署合约时可以加批量函数：

```solidity
function registerPartBatch(
    uint256[] ids,
    uint8[] slots,
    uint8[] rarities,
    uint96[] maxSupplies
) external onlyOwner;
```

当前合约已部署在 Sepolia，所以只能前端/脚本一笔一笔调。管理员后台的“按类别注册”按钮就是把这些交易串起来执行并显示进度。

---

## 5. 装备 ID 与稀有度规划（当前实现）

- 头部：`1001–1030`
- 身体：`2001–2030`
- 配饰：`3001–3030`
- 宠物：`4001–4030`

每个类别 30 件：

| 稀有度 | 数量 | 默认每件铸造量 | maxSupply |
|--------|------|---------------|-----------|
| 普通   | 12   | 200           | 10000     |
| 稀有   | 9    | 50            | 2000      |
| 史诗   | 6    | 20            | 500       |
| 传说   | 3    | 5             | 100       |
