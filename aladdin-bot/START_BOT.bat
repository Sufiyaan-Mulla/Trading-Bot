@echo off
title Aladdin Trading Bot
color 0A

echo.
echo  ============================================================
echo   ALADDIN TRADING BOT
echo  ============================================================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js is not installed.
    echo  Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v." %%i in ('node -v') do set NODE_MAJOR=%%i
echo  [OK] Node.js found

:: Go to bot directory (same folder as this .bat file)
cd /d "%~dp0"

:: Install dependencies if needed
if not exist "node_modules\express" (
    echo  [INFO] Installing dependencies (first run)...
    npm install --ignore-scripts
    if %ERRORLEVEL% neq 0 (
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed
)

:: Create .env if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo  [WARN] .env created from .env.example
        echo  [WARN] Edit .env with your API keys before live trading!
        echo.
        echo  Opening .env for editing...
        start notepad ".env"
        echo  Press any key when you have saved your .env file...
        pause >nul
    )
)

:: Create required directories
if not exist "trade_logs" mkdir trade_logs
if not exist "backups"    mkdir backups
if not exist "config"     mkdir config

echo.
echo  Starting Aladdin Bot...
echo  Dashboard : http://localhost:3000
echo  Health    : http://localhost:8080/health
echo.
echo  Press Ctrl+C to stop.
echo.

node launch.js

pause
