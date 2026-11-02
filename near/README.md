# TinyWorld NEAR 合约

Agent DID 身份 NFT + 装备部件的 NEAR 实现（Rust / near-sdk 5.30），语义对齐：

- EVM 版：`contract/src/DIDIdentity.sol`（ERC-721 Soulbound）+ `DIDParts.sol`（ERC-1155）
- Solana 版：`solana/programs/tinyworld`（Anchor，SPL Token-2022）

## 与 Solana 的机制差异（重要）

| 维度 | Solana | NEAR（本合约） |
|---|---|---|
| 存储模型 | PDA + ATA + mint 账户，租金由账户余额承担 | 合约内 `store` 集合（LookupMap/UnorderedMap/LazyOption），存储成本由合约余额承担 |
| 身份载体 | SPL Token-2022 NonTransferable 扩展 | NEP-171 风格的合约内 token 记录，转账入口由合约自己控制（默认 revert 即 Soulbound） |
| token_id | mint 公钥派生（取前 8 字节） | 递增整数（对齐 EVM `_nextTokenId`，从 1 开始） |
| 铸币费 | 指令内 transfer lamports | attached deposit（多付自动退还） |
| 权限校验 | 签名者账户 | `env::predecessor_account_id()` |

## 合约功能

### 身份（每账户 1 枚，Soulbound）

- `mint_identity(name)` — permissionless；名称 1–64 字节、大小写不敏感唯一、**burn 后永久保留**；按累计铸造数收阶梯费（默认前 10 个免费、10–99 收 0.5 NEAR、之后 1 NEAR，owner 可调）
- `update_persona(token_id, persona_hash, arweave_id)` — owner 或持 `PERMISSION_PERSONA` 的 agent；hash 为 keccak256 的 hex（与 EVM/Solana 跨链同算法）
- `set_agent(token_id, agent, permissions)` / `revoke_agent` — AI 操作员授权，权限位：`1=PERSONA`、`2=SOCIAL`、`4=SKILL`
- `equip(token_id, part_id, slot)` / `unequip(token_id, slot)` — 4 插槽（0 头 / 1 身 / 2 配饰 / 3 宠物），占用时一笔交易自动退旧装新
- `burn()` — 需插槽全空；名称保留；`mint_count` 只增不减
- `claim_starter_pack()` — 新手大礼包（等价 EVM StarterPartClaim）：免费、每账户限一次（burn 不重置）、须已铸主身份；从每个槽位已注册的前 8 件（1xxx–8 / 2xxx–8 / 3xxx–8 / 4xxx–8）随机选 1 件铸造并自动穿戴（占用槽自动退旧装新）；某槽无候选或已满额时跳过。随机源 `env::random_seed()`（区块 VRF 种子，同 epoch 内恒定——仅适合低价值发放）
- `is_starter_claimed(account_id)` — 查询大礼包领取状态
- `login_challenge(nonce)` — 无状态方法，仅记录 NEP-297 事件；用于 NEAR 登录验签（见下）
- `unlock(token_id)` / `lock(token_id)` — owner 治理标记，解锁后允许 `nft_transfer`；`nft_transfer_call`、`nft_approve` 等一律不支持（Soulbound）
- NEP-171/177/181 只读接口 + NEP-297 事件（`EVENT_JSON:`）

### 装备部件（等价 ERC-1155 的简化多代币）

- `register_part(part_id, slot, rarity, max_supply)` — 仅 owner；id 区间约定：头 1xxx / 身 2xxx / 配饰 3xxx / 宠物 4xxx
- `set_part_mintable(part_id, bool)` — 绝版开关（仅 owner）
- `set_minter(account, bool)` + `mint_part(to, part_id, amount)` — owner 或 minter；`total_supply + amount <= max_supply` 硬约束，超额整笔回滚
- `part_transfer(to, part_id, amount, memo)` — 用户间转账（托管中的需先 unequip）

## 构建与测试

```bash
rustup target add wasm32-unknown-unknown
cargo test                                  # 32 个单元测试（无需本地节点）
cargo build --target wasm32-unknown-unknown --release
```

产物：`target/wasm32-unknown-unknown/release/tinyworld_near.wasm`

> 说明：near-sdk 5.x 的官方构建工具是 `cargo near build`（会设置 `cfg(near)`、嵌入 ABI/NEP-330 元数据并跑 wasm-opt）。
> 经核对，near-sdk 5.30 在 `target_family = "wasm"` 下即链接 `near_sys` 链上 host 函数，
> 上述纯 cargo 产物可直接部署运行；只是没有内嵌 ABI 元数据，wasm 体积未做 wasm-opt 压缩。
> Windows 下 `cargo install cargo-near` 目前会因 `wasm-opt-sys`（binaryen C++ 源码）编译失败而装不上，
> 需要时可换 WSL/Linux 构建，或预装 wasm-opt 二进制后自行压缩。

## 部署（testnet，无需 CLI）

首选 `scripts/deploy.mjs`（纯 near-api-js，自动建账户/复用密钥/部署/初始化/冒烟）：

```bash
cd near && cargo build --target wasm32-unknown-unknown --release
cd scripts && npm install && node deploy.mjs        # 默认部署到 tinyworld.testnet
```

已验证的部署记录（2026-10）：合约部署于 **testnet `tinyworld.testnet`**，
冒烟全通（注册装备 1001/2001 → 铸 Genesis 身份 #1 → 铸部件 → 穿戴 → 写人格），
agent 后端 `personaNear.listMintedAgents/getEquipment/getWalletAssets` 直连该合约读取验证通过。
密钥存于 `~/.near-credentials/tinyworld.testnet.json`。

备选：安装 near-cli-rs 后可用 `scripts/deploy.sh`（Windows 上 `cargo install near-cli-rs`
会因 openssl-sys 构建失败，需先装 OpenSSL；npm 版 near-cli 亦可）。

```bash
# near-cli-rs 部署示例
near contract deploy tinyworld.testnet use-file target/wasm32-unknown-unknown/release/tinyworld_near.wasm \
  with-init-call new json-args '{"owner_id": "tinyworld.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 查询示例
near contract call-function as-read-only tinyworld.testnet get_identity_by_owner \
  json-args '{"account_id": "tinyworld.testnet"}' network-config testnet now
```

## NEAR 登录验签（已实现）

NEP-413 `signMessage` 的钱包侧实现（MyNearWallet 等）只返回 `{accountId, publicKey, signature}`，
**不返回签名负载**——payload 里的 `timestamp` 由钱包生成，dApp 无法重建 borsh 做服务端验签。
因此本项目 NEAR 登录采用**链上挑战**方案（密码学强度等价 SIWE，且全网可审计）：

1. 前端 `POST /auth/nonce`（address = account_id）拿登录 nonce，构造逐行登录消息
   （`地址/随机数/时间/链`，与 EVM/Solana 同风格）
2. 前端用钱包签名一笔 `login_challenge(nonce)` 交易（指向身份合约）并广播，拿到交易哈希
3. `POST /auth/verify`，`signature` 字段携带该交易哈希
4. 后端向 NEAR RPC 按哈希核对：签名者 == 消息地址、接收方 == 身份合约、
   方法 == `login_challenge`、参数 nonce == 消息随机数、执行状态成功；通过后消费 nonce 并签发 `chain=near` 的 JWT

测试：`cd agent && npx tsx scripts/e2e-near-login.ts [--http]`（真实 testnet 交易，9 项断言含重放/冒名/错位拒绝）。

## 已知取舍（初步接入）

- **状态迁移**：near-sdk 的 `state_read` 用 `try_from_slice`（不容忍尾部字节），合约结构**追加字段必须配 `migrate()`**（按旧布局定义 `ContractStateV1` 手工读出再写回）。`deploy.mjs --code-only --migrate` 一键完成；本项目首次追加字段（starter_claimed）已实战验证，创世身份与装备数据无损
- 未实现 NEP-145 storage management（铸币费暂不承担存储质押，owner 需保证合约账户有余量；正式上线前应补）
- 部件未实现完整 NEP-245（跨合约 market/claim 需要时再补标准接口）
- NEAR 链上无可预测随机源，StarterPartClaim 式的伪随机礼包需在接入时另行设计
- 合约不可原地升级（NEAR 无 UUPS 代理），升级 = 新账户重部署 + 数据迁移

## 与产品（agent/ 后端 + web/ 前端）对接的后续工作

1. `agent/src/config.ts`：`ChainConfig.family` 扩展 `'near'`，`ALL_CHAINS` 加 testnet/mainnet 条目（chainId 用哨兵值，rpc 用 `https://rpc.testnet.fastnear.com`（rpc.testnet.near.org 已弃用））
2. `agent/src/chain/registry.ts` / `persona.ts` / `clients.ts`：按 Solana 的"自管连接"路线加 NEAR 分支（near-api-js 或裸 RPC 调 view 方法即可读身份）
3. `web/src/lib/contracts.ts` + `chainDispatch.ts`：加 NEAR 钱包（Wallet Selector / Meteor）与 `mint_identity` / `update_persona` 调用
