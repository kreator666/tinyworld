@echo off
setlocal
set ROOT=%~dp0

rem ===== Agent 服务(:4111) =====
rem 已在运行则跳过(探活判定,避免重复启动导致 EADDRINUSE)
curl -s --max-time 2 http://localhost:4111/health 2>nul | findstr /C:"\"ok\":true" >nul
if not errorlevel 1 (
    echo Agent 服务已在运行(:4111^),跳过启动
    goto WEB
)

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
echo 启动 Agent 服务^(:4111, 独立窗口^)...
start "AgentVerse Agent :4111" cmd /c "cd /d %ROOT%agent && npm run dev"

rem 等它就绪(首次启动要初始化向量模型和数据库,可能较慢)
set /a TRIES=0
:WAIT_AGENT
curl -s --max-time 2 http://localhost:4111/health 2>nul | findstr /C:"\"ok\":true" >nul
if not errorlevel 1 goto AGENT_READY
set /a TRIES+=1
if %TRIES% GEQ 30 (
    echo Agent 服务启动超时^(30s^),请到 agent 目录手动运行 npm run dev 查看报错
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto WAIT_AGENT
:AGENT_READY
echo Agent 服务已就绪(:4111^)

:WEB
rem ===== 前端开发服务器(:5173) =====
curl -s --max-time 2 -o nul http://localhost:5173 2>nul
if not errorlevel 1 (
    echo 前端已在运行(:5173^),无需重复启动
    pause
    exit /b 0
)

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
