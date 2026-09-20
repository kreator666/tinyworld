@echo off
setlocal
set ROOT=%~dp0

rem ===== Agent 服务(:4111,独立窗口) =====
if not exist "%ROOT%agent\node_modules" (
    echo 正在安装 Agent 服务依赖...
    pushd "%ROOT%agent"
    call npm install
    if errorlevel 1 (
        echo Agent 依赖安装失败
        popd
        pause
        exit /b 1
    )
    popd
)
if not exist "%ROOT%agent\.env" (
    echo 未找到 agent/.env,从模板生成^(请填入真实 LLM_API_KEY^)...
    copy "%ROOT%agent\.env.example" "%ROOT%agent\.env" >nul
)
echo 启动 Agent 服务^(:4111^)...
start "AgentVerse Agent :4111" cmd /c "cd /d %ROOT%agent && npm run dev"

rem ===== 前端开发服务器(:5173) =====
cd /d "%ROOT%web"
if not exist "node_modules" (
    echo 正在安装前端依赖...
    npm install
    if errorlevel 1 (
        echo 依赖安装失败
        pause
        exit /b 1
    )
)

echo 启动前端开发服务器(:5173)...
npm run dev
pause
