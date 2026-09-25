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
- API 反代路径：`/agents`、`/conversations`、`/skills`、`/chains`、`/approvals`、`/health` → `http://127.0.0.1:4111`
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
