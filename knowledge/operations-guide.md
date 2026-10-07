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
- API 反代路径：`/agents`、`/conversations`、`/skills`、`/chains`、`/approvals`、`/health`、`/auth`、`/personas` → `http://127.0.0.1:4111`（`/personas` 为 2026-10 阶段 3 新增的人格镜像端点）
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

## 9. 注意事项

- 远端 `.env` 文件是手工维护的，**不会被 Git 管理**，修改后无需重启 Nginx，但需要重启 PM2 进程生效。
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
