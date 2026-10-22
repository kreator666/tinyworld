# TinyWorld 运维操作手册

本文件记录 TinyWorld 项目部署、连接远端服务器、日常排查等运维领域知识，便于后续维护与交接。

## 1. 服务器与连接方式

- **服务器 IP**: `47.86.55.179`
- **登录用户**: `root`（通过 SSH key）
- **本地 SSH 别名**: `claw`
  - 在本地 `~/.ssh/config` 中配置后，可直接使用：
    ```
    ssh claw
    ```
- **项目根目录**: `/opt/tinyworld`
- **GitHub 仓库**: `kreator666/tinyworld`
- **默认分支**: `main`

## 2. 项目目录结构

```
/opt/tinyworld/
├── agent/              # Agent 运行时服务 (Hono/Node + tsx)
│   ├── src/
│   ├── .env            # 生产环境变量 (gitignored)
│   └── package.json
└── web/                # React + Vite 前端
    ├── dist/           # 生产构建产物 (Nginx 直接服务此目录)
    ├── src/
    └── package.json
```

本地开发路径：`D:/agent/tinyworld`

## 3. Agent 服务管理 (PM2)

Agent 服务以 PM2 守护进程运行。

| 项 | 值 |
|---|---|
| 进程名 | `agentverse-agent` |
| 端口 | `4111` |
| 启动命令 | `npm run start`（即 `tsx src/index.ts`） |
| 工作目录 | `/opt/tinyworld/agent` |

### 常用命令

```bash
# 查看运行状态
pm2 status
pm2 describe agentverse-agent

# 重启 / 停止 / 启动
pm2 restart agentverse-agent
pm2 stop agentverse-agent
pm2 start agentverse-agent

# 查看日志
pm2 logs agentverse-agent --lines 100
pm2 logs agentverse-agent --err

# 健康检查
ssh claw 'curl -s http://127.0.0.1:4111/health'
```

### 开发模式排查

本地或远端临时排查可执行：

```bash
cd /opt/tinyworld/agent && npm run dev
```

注意：若 4111 端口已被 PM2 占用，会先报 `EADDRINUSE`，需先 `pm2 stop agentverse-agent` 或改用其他端口。

### 部署到远端（agent 代码更新）

服务器 `/opt/tinyworld` 即 git 克隆，`git pull` 后必须**完整** `npm install`（不要用 `--omit=dev`——`npm run start` 依赖 devDependencies 里的 tsx，跳过会导致 PM2 静默崩溃循环），再 `pm2 restart agentverse-agent`。

## 4. 前端部署流程

前端为静态站点，由 Nginx 直接服务 `/opt/tinyworld/web/dist`。

### 构建

```bash
cd D:/agent/tinyworld/web
npm run build
```

生产构建默认使用**同域相对路径**调用 Agent API，不依赖 `VITE_AGENT_API`。开发环境通过 `web/.env.development.local` 指向 `http://localhost:4111`。

### 部署到远端

```bash
# 方式 1: 直接覆盖
scp -r D:/agent/tinyworld/web/dist/* claw:/opt/tinyworld/web/dist/

# 方式 2: 先清空远端 dist，再完整复制（推荐，避免旧资源残留）
ssh claw 'rm -rf /opt/tinyworld/web/dist && mkdir -p /opt/tinyworld/web/dist'
scp -r D:/agent/tinyworld/web/dist/* claw:/opt/tinyworld/web/dist/
```

### 部署后验证

```bash
# 检查是否还有 localhost:4111 硬编码
ssh claw 'grep -R "http://localhost:4111" /opt/tinyworld/web/dist/ || echo "clean"'

# 检查 HTML 引用的 JS
curl -s https://agent.freetoken.xin/ | grep -o 'index-[^"]*\.js'

# 访问首页与 API 健康检查
curl -s https://agent.freetoken.xin/health
curl -s https://agent.freetoken.xin/chains
```

## 5. Nginx 配置

配置文件位于：

```
/etc/nginx/conf.d/
```

TinyWorld 相关 server 块监听 `agent.freetoken.xin`，主要配置：

- 静态文件根目录：`/opt/tinyworld/web/dist`
- React Router 使用 hash 路由，无需服务端 fallback
- API 反代路径：`/admin`、`/agents`、`/conversations`、`/skills`、`/chains`、`/approvals`、`/health`、`/auth`、`/personas` → `http://127.0.0.1:4111`（`/admin` 为 2026-10 动态链配置接口新增；`/personas` 为 2026-10 阶段 3 新增的人格镜像端点）
- SSL 证书由 Certbot 管理

### 常用命令

```bash
# 测试配置语法
ssh claw 'nginx -t'

# 重载配置
ssh claw 'systemctl reload nginx'

# 查看所有 conf
ssh claw 'cat /etc/nginx/conf.d/*.conf'
```

## 6. 环境变量

### Agent 服务 (`/opt/tinyworld/agent/.env`)

关键变量（生产环境）：

- `PORT` / `AGENT_PORT`: Agent 服务端口，默认 `4111`
- `CORS_ORIGIN`: 允许跨域来源，多个用逗号分隔，例如 `http://47.86.55.179`
- `LLM_MODEL`: 大模型名称
- `OPENAI_BASE_URL` / `OPENAI_API_KEY`: LLM 网关配置
- `AGENT_SERVICE_ADDRESS`: 链上权限校验用服务地址（可选）
- 数据库、RPC、合约地址等也通常在此配置

### 前端 (`web/.env.development.local`)

仅在开发模式加载：

```env
VITE_AGENT_API=http://localhost:4111
```

生产构建不打包此文件，前端使用相对路径访问同域 API。

## 7. 日志与排查

### Agent 服务无响应

1. 检查 PM2 状态：`pm2 status`
2. 本地健康检查：`curl http://127.0.0.1:4111/health`
3. 查看错误日志：`pm2 logs agentverse-agent --err --lines 100`
4. 通过域名测试 API：`curl https://agent.freetoken.xin/health`

### 前端空白/无法连接 Agent

1. 检查构建产物是否包含 `http://localhost:4111`：
   ```bash
   ssh claw 'grep -R "http://localhost:4111" /opt/tinyworld/web/dist/'
   ```
2. 确认 `index.html` 引用的是最新 JS/CSS 文件名
3. 清空浏览器缓存或强制刷新

### Nginx 返回 502/504

1. 检查 Agent 服务是否运行：`pm2 status`
2. 检查端口监听：`ss -tlnp | grep 4111`
3. 检查 Nginx 错误日志：`/var/log/nginx/error.log`

## 8. 常用命令速查

```bash
# ===== 连接服务器 =====
ssh claw

# ===== Agent 服务 =====
pm2 status
pm2 restart agentverse-agent
pm2 logs agentverse-agent --lines 100
pm2 logs agentverse-agent --err

# ===== 前端部署 =====
cd D:/agent/tinyworld/web && npm run build
ssh claw 'rm -rf /opt/tinyworld/web/dist && mkdir -p /opt/tinyworld/web/dist'
scp -r D:/agent/tinyworld/web/dist/* claw:/opt/tinyworld/web/dist/

# ===== Nginx =====
ssh claw 'nginx -t && systemctl reload nginx'

# ===== 验证 =====
curl -s https://agent.freetoken.xin/health
curl -s https://agent.freetoken.xin/chains
ssh claw 'curl -s http://127.0.0.1:4111/health'
```

## 8.5 竞技场部署前置:服务器上编译合约产物

竞技场"一键部署"接口按请求现场读取 `contract/artifacts/` 的 bytecode(构建输出不入 git)。
新克隆/更新后的服务器必须先编译,否则报"合约编译产物缺失":

```bash
ssh claw 'cd /opt/tinyworld/contract && npm install --registry=https://registry.npmmirror.com && npx hardhat compile'
```

注意:服务器(阿里云国内)直连 npm 官方源可能 ECONNRESET,用 npmmirror 源;
合约目录需要 devDependencies(hardhat 本体),不要用 `--omit=dev`。

## 9. 注意事项

- 远端 `.env` 文件是手工维护的，**不会被 Git 管理**，修改后无需重启 Nginx，但需要重启 PM2 进程生效。
- **PGlite 库禁止双进程并发访问**：agent 服务运行时，不要再用独立 tsx 脚本直连 `agent/data` 改库
  （两个 PGlite 实例各写各的 WAL，后写者会用旧快照覆盖，改动无声丢失——2026-10 踩过）。
  改 chains 配置走设计好的 admin API：`node contract/scripts/admin-put-chain-config.mjs <chainKey> '<json>'`
  （用 `.keys/mainnet-owner.key` 签 SIWE 登录拿 JWT；脚本写完库自己退出，不经服务的数据目录）。
  脚本方式改库仅限服务停止时，且必须 `await closeDb()` 落盘后再退出。
- 前端构建产物文件名含 hash，旧文件会残留在 `dist/assets/`，建议部署时先清空 `dist` 再复制。
- Certbot 会自动续期 SSL 证书，一般无需手动干预；若证书异常，可执行 `certbot renew --nginx`。
- 生产环境不要直接运行 `npm run dev`，应使用 PM2 管理；`dev` 模式仅用于本地或临时排查。

## 10. Solana 测试网故障与重置恢复

### 背景

- Solana 官方 RPC 域名（`api.testnet.solana.com` / `api.devnet.solana.com` / `explorer.solana.com`）
  在部分网络环境**间歇性 TCP 超时**（2026-10 本机实测），表现为链上调用全部失败。
- Solana 测试网会**定期清空全部账户**（先例：2026-09-25 devnet Alpenglow 升级 genesis 重启，
  tinyworld 程序 `5JEXwXv9...` 及所有身份/配置账户丢失）。

### 已内建的容错（agent 侧）

- **RPC 故障转移**：`personaSolana.ts` 的 `FailoverConnection` 对网络类错误自动切换备用端点。
  solana-testnet 内置备用 `https://solana-testnet-rpc.publicnode.com`；
  可用 `CHAIN_RPC_FALLBACKS`（逗号分隔）覆盖（见 `.env.example`）。
- **身份镜像**：GPA 扫描 / `resolveTokenId` 成功后自动把链上身份快照进 PGlite 的
  `chain_identities` 表；GPA 失败（官方节点不可达 + 免费节点不支持索引类方法）时
  读路径自动回退镜像。注意：免费备用节点不支持 `getProgramAccounts`，
  装备明细/他人 tokenId 反查等仍依赖官方 RPC 可达。
- 不要把 `CHAIN_RPC` 指向免费公共节点跑生产——其索引方法（GPA）和方法级限流都会咬人；
  有 Helius/QuickNode 私有节点优先用。

### 测试网重置后的恢复流程

1. **重部署程序**（程序 ID 不变）：
   ```bash
   cd D:/agent/tinyworld/solana
   solana airdrop 2 --url testnet        # ~7.5 SOL，限流时多试或 faucet.solana.com
   anchor deploy --provider.cluster testnet
   ```
2. **重建身份数据**（DB 镜像为种子，一键）：
   ```bash
   cd D:/agent/tinyworld/agent
   TARGET_CHAIN=solana-testnet npx tsx scripts/rehydrate-solana.mts [--dry-run]
   ```
   - 只恢复**本钱包**（`~/.config/solana/id.json`）持有的身份；`mint_identity` 要求
     owner 签名，其他用户的身份脚本只列清单，需各主人自行重铸。
   - 重铸后 token_id 必然变化（随机 mint 派生）；DB 中按旧 token_id 关联的数据
     （memories/conversations/approvals 等）需按 owner 重新关联或迁移。
   - 名字被占用（name-record 未随重置释放）会跳过并列入待处理清单。
3. 验证：`npx tsx scripts/smoke-solana-reads.ts`（需 TARGET_CHAIN=solana-testnet）。

### 本地开发环境常驻（Windows 本机）

本地 agent(:4111) + web(:5173) 由仓库根目录 PM2 守护（关窗口/会话结束不掉线、崩溃自重启）：

```bash
cd D:/agent/tinyworld
npm install        # 首次:装 pm2(本地 devDependency)
npm run up         # 启动两个服务
npm run status     # 查看状态
npm run logs       # 查看日志
npm run down       # 停止并移除
```

注意：PM2 在 Windows 不能 spawn `npm`（.cmd 会被当 JS 解析崩溃），pm2.config.cjs
里统一用 node 直跑 tsx / vite CLI。临时手动跑仍可用 start.bat / start.sh。

## 11. 多链架构(方案A,2026-10-07 起)

- **单进程多链**:agent 服务按请求的 `X-Chain-Key` 头分派链(空 → TARGET_CHAIN 默认链)。
  链目录 = `config.ts ALL_CHAINS`,同时服务 sepolia/fuji/solana-testnet。
- **DB**:所有 token 表带 `chain_key` 维度(复合主键),迁移基线 = 启动默认链;
  `initSchema()` 幂等自动迁移,部署只需 git pull + npm install + pm2 restart。
- **鉴权**:JWT payload 带 chainKey,请求链与登录链不一致 → 401;nonce 按链隔离。
- **社交**:本期不支持跨链互动(发送前校验收件人在当前链,否则 400);前端切链有提示文案。
- **心跳**:逐链轮询(每 300s 一轮遍历全部链),单链失败不影响其他链。
- **加新链**:config.ts 的 ALL_CHAINS 加条目(EVM 需 defi/aave 配置)→ 重启即生效,
  无需迁移。
- 新链加入后前端自动跟随(GET /chains 已带 family)。

### 各链能力差异(2026-10-08)

Agent 的系统提示词按链生成(`buildInstructions(chainKey, installed)`),能力摘要来自
实际安装的技能清单,不会跨链张冠李戴。

| 能力 | Fuji | Solana Testnet |
|---|---|---|
| 查钱包资产 | AVAX + USDC + USDT(TraderJoe 测试币)+ 装备 | SOL + tUSDC + 装备 |
| DEX 兑换 | TraderJoe(propose_swap,含策略引擎/审批) | Jupiter(propose_swap,直接执行) |
| 理财(Aave) | ✅ | ❌(提示词明确告知不支持) |
| 原生币行情 | AVAX | SOL |
| 社交 / 主人画像 / 记忆 | ✅ | ✅ |

Solana 专属配置(config.ts `solana` 字段,env 可覆盖):
- `SOLANA_USDC_MINT`:默认项目自建 tUSDC `AQb9N6naGGRcDsz4EhBez4BkWdEyWK6HHXN4i8ZxoM74`
  (测试网无官方 USDC;devnet 那个 4zMMC9... 在 testnet 是空账户。重建:
  `cd solana && npx ts-node scripts/create-test-usdc.ts`)
- `JUPITER_API_URL`:官方 api.jup.ag 仅主网;测试网要自托管 jupiter-quote-api
  指向 testnet RPC 后填入。未配置 = Solana 链隐藏兑换技能。
- `AGENT_SOLANA_PRIVATE_KEY`:Solana 热钱包(base58 secret),兑换执行签名用。
  未配置 = `isMeteoraSwapConfigured()` 为 false,defi-swap-meteora 从清单/默认安装/
  工具集里整体隐藏(已安装记录也会被跳过,getToolsFor 会打 warn 日志)。

### PGlite WAL 损坏修复(agent/scripts/pglite-repair-wal.ts)

进程被强杀(taskkill /F、断电)可能写坏 WAL 检查点记录,之后服务起不来:

```
PANIC: could not locate a valid checkpoint record at ...
```

wasm 版 PGlite 没有 pg_resetwal 可用,用修复脚本兜底(等价最小 resetwal):

```
cd agent && npx tsx scripts/pglite-repair-wal.ts repair <dataDir>   # 修复并自动打开验证
```

原理:从 `global/pg_control` 读检查点位置与内容副本,在 WAL 中原位重写一条合法的
shutdown 检查点记录(CRC32C 重算)、其余补零,数据回到上次干净检查点。
**未检查点的事务会丢失**;修复前手动备份 data 目录。

## 11. Avalanche C-Chain 主网部署记录(2026-10-13)

早期四个合约由 owner 热钱包 `0x784D68dB62448cDeBC5599ba7f8b2FbB59174018` 部署(chainId 43114),**全部已作废**,仅作历史记录:

| 合约 | 地址(作废) |
|------|------|
| DIDParts | ~~0xa3fB106DD25c02bf18170d6657EdF4804bf5D924~~ |
| DIDReputation | ~~0x319202A6B09A39d6E6E04f7b6B2571358d105f6B~~ |
| DIDValidation | ~~0xfAEb8174BA2dD8eEb35A6FA9DC31E89E1317c048~~ |

- DIDIdentity 初版 `0xf9111CbC5562671050910858BBA702db8C44f3fE`、v2 `0x0928B2F5a9F03792b994940b95Ba15654835A011`、v3 `0xd04268d288b4981A40285e99fd42374D71f10949` **均已作废**,
  当前服役为 UUPS 代理 `0x72A1Ae8dD45f87c597d2C2450f7f200c81fc463c`(见第 12 节)。

### 主网 DIDIdentity v3 + 市场(2026-10-17,已作废)

| 合约 | 地址 |
|------|------|
| DIDIdentity v3 | ~~0xd04268d288b4981A40285e99fd42374D71f10949~~ |
| DIDParts | ~~0xa3fB106DD25c02bf18170d6657EdF4804bf5D924~~ |
| PartsMarket | ~~0xa5eF8B7b48f4b62c5834576b4C5CF5004B470377~~ |
| StarterPartClaim v2 | ~~0x3510D466852a41Ed729Bbf2199b0B3743B627844~~ |

> 以上地址已于 2026-10-17 再次重部署为 UUPS 代理（见下节），状态已清空，请勿再使用。

## 12. UUPS 代理重部署（2026-10-17）

全部 6 个合约改为 OpenZeppelin UUPS 可升级代理模式，由 owner 热钱包 `0x784D68dB62448cDeBC5599ba7f8b2FbB59174018` 部署。

### Avalanche C-Chain 主网（chainId 43114）

| 合约 | Proxy 地址 | 说明 |
|------|------------|------|
| DIDIdentity | `0x72A1Ae8dD45f87c597d2C2450f7f200c81fc463c` | 身份 NFT 代理 |
| DIDParts | `0xb21652D0E6B3225d83B3aEB86f2185b8A6519976` | 装备 ERC-1155 代理 |
| StarterPartClaim | `0x827350934d7632a9f7b14BeB2fB6716b61D1bD7b` | 新手礼包代理 |
| PartsMarket | `0x57720BEb1Bf1fe0Fa896CBdb2f683098d4fDaB61` | 装备直售市场代理 |
| DIDReputation | `0x6Bf68fDe79ae6A88e9Bb9b7267fE12F6AF416507` | 声誉代理 |
| DIDValidation | `0x398d20BDD90f9aECd1d9fbAD830375E2CDB2A8eA` | 验证代理 |

### Avalanche Fuji 测试网（chainId 43113）

| 合约 | Proxy 地址 | 说明 |
|------|------------|------|
| DIDIdentity | `0xd6eB40E8D9e333f2b721bBd419c6CB40B55325Dd` | 身份 NFT 代理 |
| DIDParts | `0x0E14D4227D7775F4f4Ee9f4493826D5c4eb81a4b` | 装备 ERC-1155 代理 |
| StarterPartClaim | `0x940d4F7edaCB067f780Da2e59177772D73Aa751B` | 新手礼包代理 |
| PartsMarket | `0x16140ee819539639f434FC32DfdEf392103B0703` | 装备直售市场代理 |
| DIDReputation | `0x85ABE9143c5179f34eF6B7342f2710Ab2D8D7CeD` | 声誉代理 |
| DIDValidation | `0x7aeeA97dD7169437CC47AF55279dF9092266eC4b` | 验证代理 |

### 部署后链上初始化

- `DIDIdentity.setCollectionApproved(DIDPartsProxy, true)`
- `DIDParts.setMinter(StarterPartClaimProxy, true)`
- `DIDParts.setMinter(PartsMarketProxy, true)`
- 两链各 `registerPartBatch` 注册 120 件装备（头/身/配饰/宠物 各 30 件）
- 两链各创世铸造 11,940 份装备到 owner
- 两链各上架 48 件普通装，单价 `0.01 AVAX`

### 配置更新

- `agent/src/config.ts` 已更新
- `web/src/lib/contracts.ts` 已更新
- 数据库 `chains` 表已更新（identity/parts/config.market/config.partsClaim）
- 数据库 `chain_protocols` 表已更新（market / starter-claim 地址）
- `web/src/abi/` 下 ABI 已同步为最新编译产物

### 升级方式

后续升级只需：
1. 修改 implementation 源码
2. 部署新 implementation
3. owner 调用 proxy 的 `upgradeToAndCall(newImplementation, "")`

状态保留在 proxy 上。


### 动态链/协议配置(2026-10-14 改造,admin 接口)

- **鉴权 = 管理员钱包签名**:废除了 CHAIN_ADMIN_TOKEN。用任意链 SIWE 登录拿 JWT,白名单查
  `admin_whitelist` 表(首个引导管理员 = agent/.env 的 `ADMIN_ADDRESS`,公钥非秘密,启动时种子)。
  admin 路由不校验 X-Chain-Key(跨链全局操作)。每次写操作落 `admin_audit`(who/when/what)。
- **动态加链**:`POST /admin/chains` {chain_key, chain_id, name, family, rpc, explorer,
  identity_address, parts_address, config?} → 插行 + 热重载注册表(applyDbChains),**免重启**,
  带 X-Chain-Key 的新链请求立即可用;重复 chain_key/chain_id → 409。
- **协议注册表**:`chain_protocols(chain_key, protocol_key, kind, config JSONB, enabled, updated_by)`。
  `PUT/DELETE/GET /admin/chains/:key/protocols[/:pkey]`。协议 key 约定:`dex`(defi-swap)、
  `lending`(defi-lending)、`starter-claim`、`jupiter`、`meteora`、`drift`。
- **技能 gating 三态优先级**:协议表 disabled 行 > enabled 行(接管,老配置不再看)>
  无行(回落老配置检查)。启动时对协议表无行的链自动 seeding(从 ChainConfig 推导,幂等,
  尊重人工停用)。即:已实现协议类型 = 插行即上线/停用;新协议类型 = 写适配器 + 插行。
- **管理端点全集**(均需 admin JWT):POST /admin/chains、PUT /admin/chains/:key/config、
  PUT/DELETE/GET /admin/chains/:key/protocols[/:pkey]、GET/POST/DELETE /admin/admins[/:address]
  (拒绝删除最后一个管理员)。GET /chains 每链附 protocols 数组。
- 验证脚本:agent/scripts/verify-dynamic-chain-config.ts(15 项)、verify-skill-gating.ts(7 项)、
  verify-skill-registry.ts(4 项)。
