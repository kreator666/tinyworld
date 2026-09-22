#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# 已在运行的判定:直接探活,而不是只看端口(端口可能被无关进程占用)
agent_alive() { curl -s --max-time 2 http://localhost:4111/health 2>/dev/null | grep -q '"ok":true'; }
web_alive() { curl -s --max-time 2 -o /dev/null http://localhost:5173 2>/dev/null; }

AGENT_PID=""

cleanup() {
    # npm run dev 的子进程(tsx)不会随父进程退出,按端口清理,防止幽灵进程占用 4111
    if [ -n "$AGENT_PID" ]; then
        kill "$AGENT_PID" 2>/dev/null
        local pid
        pid=$(netstat -ano 2>/dev/null | grep ':4111' | grep LISTEN | awk '{print $5}' | head -1)
        if [ -n "$pid" ] && command -v taskkill >/dev/null 2>&1; then
            taskkill //PID "$pid" //F >/dev/null 2>&1
        fi
    fi
}
trap cleanup EXIT

# ===== Agent 服务(:4111) =====
if agent_alive; then
    echo "Agent 服务已在运行(:4111),跳过启动"
else
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
    # 等它就绪(首次启动要初始化向量模型和数据库,可能较慢),失败则直接退出并提示
    for i in $(seq 1 30); do
        agent_alive && break
        sleep 1
    done
    if ! agent_alive; then
        echo "❌ Agent 服务启动超时(30s),请到 agent/ 目录手动运行 npm run dev 查看报错"
        exit 1
    fi
    echo "Agent 服务已就绪(:4111)"
fi

# ===== 前端开发服务器(:5173) =====
if web_alive; then
    echo "前端已在运行(:5173),无需重复启动"
    exit 0
fi

if [ ! -d "$ROOT/web/node_modules" ]; then
    echo "正在安装前端依赖..."
    (cd "$ROOT/web" && npm install)
fi

echo "启动前端开发服务器(:5173)..."
cd "$ROOT/web"
npm run dev
