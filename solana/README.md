# TinyWorld Solana —— 铸造工坊（Soulbound DID + 装备）

Solana 版本的「铸造工坊」，与 `contract/` 下 EVM 合约（DIDIdentity.sol / DIDParts.sol）语义对齐。
单一 Anchor 程序 `tinyworld`，NFT 资产层使用 **SPL Token-2022**（未接 Metaplex，后续可通过 Token-2022 元数据扩展升级）。

## 版本组合

| 组件 | 版本 |
| --- | --- |
| solana-cli / test-validator / cargo-build-sbf | 1.18.1（platform-tools v1.39，rustc 1.72） |
| anchor-cli | 0.31.1 |
| anchor-lang / anchor-spl（crate 实际解析） | 0.31.2（Cargo `"0.31.1"` 语义化版本匹配） |
| solana-program | 固定 `~2.1`（2.1.16） |
| spl-token-2022 | 6.0.0（anchor-spl `token_2022` feature 引入） |
| Node / TS | node 22 + ts-mocha |

### 版本决策与关键 workaround（Windows 无管理员权限环境）

anchor 0.31 强制 solana-program ^2，而本机 build-sbf 工具链（platform-tools v1.39）是
rustc 1.72，因此做了如下组合（均已固化，重装机器后需重做）：

1. **solana crate 固定 2.1 线** + 一批传递依赖降版（见 `programs/tinyworld/Cargo.toml`
   注释）：`blake3 ~1.7`、`zeroize_derive ~1.4`、`proc-macro-crate =3.2.0`、`indexmap ~2.9`、
   `unicode-segmentation =1.12.0`、`thiserror =2.0.0`、`borsh ~1.5`、`serde =1.0.218`——
   排除 edition 2024 / MSRV 过高的版本。
2. **`Cargo.lock` 保持 v3**：由工具链 cargo 生成（`cargo +solana generate-lockfile`），
   宿主 cargo 1.88 只做增量解析、不改写 lock 版本。
3. **platform-tools cargo wrapper**：`~/.cache/solana/v1.39/platform-tools/rust/bin/cargo.exe`
   是 wrapper（真身为 cargo-real.exe），对 `cargo +solana build` 自动注入
   `--ignore-rust-version`。
4. **solana CLI shim**：`C:/Users/tiger/bin/solana.exe` 剥离 anchor-cli 0.31 传给
   solana-cli 1.18 不支持的 `--with-compute-unit-price / --max-sign-attempts / --use-rpc`。
5. **build-sbf 缓存目录联接**：`<solana-release>/bin/sdk/sbf/dependencies/platform-tools`
   是指向 `~/.cache/solana/v1.39/platform-tools` 的目录联接（mklink /J，Windows
   创建符号链接无权限时的替代）。
6. **`solana-test-validator` 必须以 `--log` 启动**：否则它创建 validator.log 符号链接
   会因无权限崩溃（os error 1314）。
7. 本机 validator 的 `requestAirdrop` RPC 不可用（Internal error），测试改用
   genesis 已充值的 provider 钱包直接转账领水。

> 更省事的长期方案：装 solana 2.1.x LTS 工具链或开发者模式，即可去掉 3/4/5/6。

## 账户布局（PDA）

| 账户 | seeds | 空间（字节） | 说明 |
| --- | --- | --- | --- |
| Config | `[b"config"]` | 107 | authority、version、bump、mint_auth_bump、reserved[64]；`initialize_config` 时建立 |
| MintAuth | `[b"mint-auth"]` | —（仅 PDA 签名） | 所有身份/装备 mint 的 mint_authority，铸完不撤销（保留给 burn 语义用） |
| Identity | `[b"identity", owner]` | 字段和 + 256 冗余（≈858 - 名称余量） | 每钱包 1 枚，见下方字段 |
| NameRecord | `[b"name-record", name_hash]` | 145 | 名称占用记录，与身份同寿（close_identity 一并关闭释放名字，租金退 owner） |
| PartConfig | `[b"part", part_id(u64 LE)]` | 132 | part_id 区间沿用 EVM：头 1001–1030 / 身 2001–2030 / 配饰 3001–3030 / 宠物 4001–4030（仅文档约定，程序不强制） |
| Minter | `[b"minter", wallet]` | 42 | enabled；bump；owner 可 set / remove（close） |
| AgentPermission | `[b"agent-permission", identity, agent]` | 74 | permissions u8：bit0=PERMISSION_PERSONA，bit1=PERMISSION_SOCIAL 预留，bit2-7 预留 |
| escrow ATA | `ATA(identity_pda, part_mint, token_program=Token-2022)` | — | equip 时装备代币托管账户，owner = Identity PDA，经 invoke_signed 签名转出 |

### Identity 字段

`owner, mint, name, name_hash(keccak256(小写name)), persona_hash(keccak256(persona JSON), 全0=未设置),
persona_arweave_id(43 字符 base64url, 可空串=清除, 容量 64 可 realloc), equipped[Option<Pubkey>;4]
(0=HEAD 1=BODY 2=ACCESSORY 3=PET), agent_count, recipe_id(预留=0), mint_fee_lamports(预留=0),
minted_at, ready_at(预留=0), attributes[32](预留), version=1, bump, reserved[128]`

Token 层：身份 mint 带 **NonTransferable** 扩展（decimals=0，固定铸 1）→ Soulbound；
装备 mint 无扩展（decimals=0），供应量由程序按 `max_supply` 硬顶约束（等价 ERC-1155 + maxSupply revert）。

## 指令清单

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `initialize_config()` | 任意首个调用者（部署时执行一次） | 建立 Config，记录 authority 与 mint-auth bump |
| `mint_identity(name)` | 任意钱包（每钱包 1 枚） | 名称 1–64B；name_hash=keccak256(小写)；名称唯一（大小写不敏感）；铸造费=config.mint_fee()>0 时 owner 向 authority 付费；创建 NonTransferable mint + ATA + mint 1 + Identity/NameRecord |
| `update_persona(persona_hash, arweave_id)` | owner 或持 PERMISSION_PERSONA 的 agent | arweave_id 为空串或 43 位 `[A-Za-z0-9_-]` |
| `set_agent(agent, permissions)` | owner | permissions 仅允许 bit0/1，且非 0 |
| `revoke_agent(agent)` | owner | 关闭 AgentPermission PDA |
| `register_part(part_id, slot, rarity, max_supply)` | config authority | 创建装备 mint + PartConfig；max_supply>0 |
| `set_part_mintable(part_id, mintable)` | config authority | 开关铸造（绝版控制） |
| `set_minter(wallet, enabled)` / `remove_minter()` | config authority | Minter PDA 授权 / 关闭 |
| `set_mint_fee(fee_lamports)` | config authority | 全局铸造费率（lamports/次，存 Config.reserved[0..8]，0=免费）；费率>0 时 mint_identity 必须传 fee_receiver=config authority |
| `mint_part(part_id, to, amount)` | authority 或 enabled Minter | require mintable && supply+amount<=max_supply，超额整笔 revert |
| `equip(part_id, slot)` | identity owner | 装备代币 1 枚转入 escrow ATA；**插槽已占用时自动退回旧件再装新件**（EVM 换装语义）；slot 不匹配 revert |
| `unequip(slot)` | identity owner | 从 escrow 转回 owner ATA，插槽清空 |
| `close_identity()` | owner | 4 插槽必须全空；burn 身份代币 + 关闭 owner ATA + 关闭 Identity PDA + 关闭 NameRecord（名字释放，rent 全退 owner） |

## 事件

Minted、PersonaUpdated、AgentSet、AgentRevoked、PartRegistered、PartMintableUpdated、MinterUpdated、PartMinted、Equipped、Unequipped、IdentityClosed（对齐 EVM 事件语义；EVM 的 MetadataUpdate/CollectionApproved/ModuleRegistered 无对应物，前两者在 Token-2022 模型下无意义，ModuleRegistered 属未来 AI 模块扩展）。

## 与 EVM 合约的语义对照

| EVM（DIDIdentity / DIDParts） | Solana（tinyworld） |
| --- | --- |
| ERC-721 每地址 1 枚（tokenIdOf） | Identity PDA 每 owner 1 个 + NonTransferable mint |
| ERC-5192 Soulbound 锁定 | Token-2022 NonTransferable 扩展（转账被协议层禁止） |
| 名称 keccak256(小写)，占用至 close_identity 释放 | NameRecord PDA 与身份同寿，关闭即释放（防主网名字被垃圾永久占用） |
| keccak256 内容哈希 | `solana_program::keccak::hash`（同 keccak-256） |
| 4 插槽纸娃娃装备（合约托管 ERC-1155） | escrow ATA（owner=Identity PDA）托管 Token-2022 代币 |
| equip 自动换装（退旧装新，一笔交易） | equip 自动换装（先退旧件再装新件，一个指令） |
| burn 前插槽必须全空 | close_identity 校验 4 插槽全空 |
| setPersona（owner 或 PERMISSION_PERSONA agent） | update_persona（同） |
| agentPermissions（bit 位） | AgentPermission PDA（bit0=persona，bit1=social 预留） |
| registerPart / setPartMintable / setMinter / minters | 同名指令 + PDA |
| mintPart maxSupply revert（整笔回滚） | supply+amount<=max_supply 校验 |
| 治理解锁（unlock/lock 迁移账号） | **未实现**（Token-2022 NonTransferable 不可解锁；如需迁移走 close + 重铸，名称仍永久占用） |
| 模块注册表 registerModule | **未实现**（预留字段已留，未来独立程序接入） |
| ERC-6551 TBA | 未实现（未来可用 Identity PDA 直接作为资产托管方，等价能力已有） |
| 元数据 URI（baseTokenURI） | 未实现（用户决策：暂不接 Metaplex，预留 Token-2022 元数据扩展升级路径） |

## 预留字段（本期全部默认值，不启用逻辑）

- Identity：`recipe_id`(0=无配方)、`mint_fee_lamports`(0=免费)、`ready_at`(冷却/计时)、`attributes[32]`(随机属性位)、`reserved[128]`
- Config / NameRecord / PartConfig：`reserved[64..128]`
- 所有账户：`version(u8)=1`
- `persona_arweave_id` 初始容量 64B，未来可 realloc 扩展

## 本地开发

```bash
cd solana
npm install
bash scripts/test-local.sh   # 一键：起 validator + anchor test --skip-local-validator
```

手动分步（等价，Windows Git Bash）：

```bash
cd solana

# 1. 清掉旧 validator 与账本（必须；否则上次运行的账户残留导致假失败）
taskkill //F //IM solana-test-validator.exe 2>/dev/null
sleep 3
rm -rf test-ledger

# 2. 手动起 validator。**必须带 --log**：不带参数启动时它会创建
#    validator.log 符号链接，Windows 权限（SeCreateSymbolicLinkPrivilege）
#    不足直接 panic 退出（os error 1314），`anchor test` 自起的
#    validator 正受此影响，因此只能用 --skip-local-validator 模式。
solana-test-validator --reset --log \
  --rpc-port 8899 --faucet-port 9900 \
  --gossip-port 8001 --gossip-host 127.0.0.1 \
  > validator-stdout.log 2>&1 &

# 3. 等 validator 出到 slot >= 1 再继续！getHealth 返回 ok 不够——
#    slot=0（仍在处理 genesis）时 deploy / initializeConfig 会报
#    AccountAlreadyInUse（custom program error 0x0）的假错误。
until curl -s -m 2 http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | grep -q '"result":[1-9]'; do
  sleep 2
done

# 4. 跑测试（需 C:/Users/tiger/bin 在 PATH 前，scripts/test-local.sh 已处理）
export PATH="/c/Users/tiger/bin:$PATH"
anchor test --skip-local-validator --provider.cluster http://127.0.0.1:8899

# 5. 收尾：杀掉 validator
taskkill //F //IM solana-test-validator.exe
```

## 公共测试网部署与冒烟

已实测部署于 **Solana testnet**（程序地址 `4ErVmJjpd798U2riCj76fDy8ggPd2W2fhRnP5Ta6dBaH`，
`anchor deploy --provider.cluster testnet` + `devnet-smoke.ts` 真实铸造冒烟通过）。

```bash
solana config set --url devnet   # 或 testnet
solana airdrop 2                 # 需要 ~7.5 SOL 支付程序租金；水龙头限流时可改用
                                 # https://faucet.solana.com 网页领 5 SOL × 2
anchor deploy --provider.cluster devnet
CLUSTER_URL=https://api.devnet.solana.com npx ts-node scripts/devnet-smoke.ts <name>
# testnet 冒烟：CLUSTER_URL=https://api.testnet.solana.com npx ts-node scripts/devnet-smoke.ts <name>
```

## 测试网重置后的恢复（重要）

Solana 测试网会定期清空全部账户（先例：2026-09-25 devnet 因 Alpenglow 升级
genesis 重启，本程序及所有身份/装备/配置账户全部丢失）。恢复分两层：

**1. 程序重部署**（程序 ID 不变，用固定密钥对）：

```bash
cd solana
solana airdrop 2 --url testnet   # 需要 ~7.5 SOL；或 redeploy-devnet.sh 自动重试
anchor deploy --provider.cluster testnet
```

**2. 身份数据重建**（agent 侧，DB 镜像为种子）：

agent 在 GPA 扫描/单户解析成功时会自动把链上身份快照进 `chain_identities`
镜像表（PGlite）。重置后一键重建：

```bash
cd agent
TARGET_CHAIN=solana-testnet npx tsx scripts/rehydrate-solana.mts [--dry-run]
```

- 自动检查程序存活 → 领水 → 补 `initialize_config` → 按镜像重铸**本钱包**的身份
  并恢复人格哈希（`update_persona`）→ 回写镜像新 token_id/mint
- `mint_identity` 要求 owner 签名：**其他用户的身份无法代铸**，脚本会列出清单，
  需各主人用原钱包自行重铸（重铸后 token_id 变化，DB 中按旧 token_id 关联的
  memories/conversations 等需按 owner 重新关联）
- 名字被占用（name-record 未随重置释放）时会跳过并记入待处理清单
- agent 读链路有 RPC 故障转移（官方节点间歇不可达时切 publicnode）+ GPA 失败
  时回退 DB 镜像；免费备用节点不支持 getProgramAccounts，装备/余额明细仍依赖官方 RPC
