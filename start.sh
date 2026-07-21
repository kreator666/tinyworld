#!/bin/bash
set -e

cd "$(dirname "$0")/web"

if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
fi

echo "启动开发服务器..."
npm run dev
