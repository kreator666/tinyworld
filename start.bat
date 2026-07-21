@echo off
cd /d "%~dp0web"

if not exist "node_modules" (
    echo 正在安装依赖...
    npm install
    if errorlevel 1 (
        echo 依赖安装失败
        pause
        exit /b 1
    )
)

echo 启动开发服务器...
npm run dev
pause
