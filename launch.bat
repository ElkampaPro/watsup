@echo off
title WatsUp Desktop Streamer
echo ==========================================================
echo  🚀 WatsUp Desktop Streamer - Windows Launcher
echo ==========================================================
echo.

:: 1. Verify Node.js installation
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js was not detected!
    echo Please install Node.js from https://nodejs.org/ first.
    pause
    exit /b
)

:: 2. Verify Python installation
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Python was not detected!
    echo Please install Python from https://www.python.org/ first.
    pause
    exit /b
)

:: 3. Install npm dependencies if missing
if not exist node_modules (
    echo 📦 Installing Node.js packages...
    call npm install --production
    echo.
)

:: 4. Stop any zombie engines on port 5001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5001 ^| findstr LISTENING') do (
    echo 🔄 Restarting background engine on port 5001...
    taskkill /f /pid %%a >nul 2>nul
)

:: 5. Launch Node.js background engine
echo ⚡ Starting background WhatsApp Engine...
start /b node engine.js > engine.log 2>&1

:: 6. Launch Tkinter GUI dashboard
echo 🎨 Starting dark-themed UI dashboard...
python ui.py

:: 7. Cleanup background engine on GUI exit
echo 🧹 Cleaning up background engine...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5001 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>nul
)

echo ✨ Goodbye!
