#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Agent 服务(:4111)
if [ ! -d "$ROOT/agent/node_modules" ]; then
    echo "正在安装 Agent 服务依赖..."
    (cd "$ROOT/agent" && npm install)
fi
if [ ! -f "$ROOT/agent/.env" ]; then
    echo "未找到 agent/.env,从模板生成(请填入真实 LLM_API_KEY)..."
    cp "$ROOT/agent/.env.example" "$ROOT/agent/.env"
fi
echo "启动 Agent 服务(:4111)..."
(cd "$ROOT/agent" && npm run dev) &
AGENT_PID=$!
# 脚本退出时一并停掉 Agent 服务
trap 'kill $AGENT_PID 2>/dev/null' EXIT

# 前端开发服务器(:5173)
if [ ! -d "$ROOT/web/node_modules" ]; then
    echo "正在安装前端依赖..."
    (cd "$ROOT/web" && npm install)
fi

echo "启动前端开发服务器(:5173)..."
cd "$ROOT/web"
npm run dev
