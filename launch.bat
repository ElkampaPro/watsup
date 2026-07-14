@echo off
title WatsUp Desktop Streamer
cd /d "%~dp0"

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

setlocal enabledelayedexpansion
set "PORT=5001"
set "PID_FILE=.watsup_engine.pid"
set "REUSE_ENGINE=0"

:: Check if port 5001 is busy
set "BUSY_PID="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5001 ^| findstr LISTENING') do set "BUSY_PID=%%a"

if defined BUSY_PID (
    if exist .watsup_ipc_token (
        set /p TOKEN=<.watsup_ipc_token
        for /f "delims=" %%i in ('curl -s -H "X-WatsUp-Token: !TOKEN!" -m 3 http://127.0.0.1:5001/api/status 2^>nul') do (
            set "RESPONSE=%%i"
        )
        echo !RESPONSE! | findstr /i "status" >nul
        if !errorlevel! equ 0 (
            echo ✅ WatsUp Engine is already running on port %PORT%.
            set "REUSE_ENGINE=1"
        )
    )

    if "!REUSE_ENGINE!"=="0" (
        echo ❌ Error: Port %PORT% is occupied by an unknown process ^(PID: !BUSY_PID!^).
        echo Please stop the other process or free port %PORT% before launching.
        pause
        exit /b 1
    )
)

if "!REUSE_ENGINE!"=="0" (
    echo ⚡ Starting background WhatsApp Engine...
    :: Redirect stdout and stderr to separate files to avoid PowerShell locks
    set "PID_AND_TIME="
    for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "$p = Start-Process node -ArgumentList 'engine.js' -PassThru -NoNewWindow -RedirectStandardOutput 'engine_out.log' -RedirectStandardError 'engine_err.log'; \"$($p.Id),$($p.StartTime.Ticks)\""`) do (
        set "PID_AND_TIME=%%i"
    )

    if not defined PID_AND_TIME (
        echo ❌ Error: Failed to start Node.js background engine.
        pause
        exit /b 1
    )

    for /f "tokens=1,2 delims=," %%a in ("!PID_AND_TIME!") do (
        set "ENGINE_PID=%%a"
        set "ENGINE_START_TIME=%%b"
    )

    echo !ENGINE_PID!>%PID_FILE%
    echo ⏳ Initializing engine socket layers...

    call :wait_for_token
    if !errorlevel! neq 0 (
        echo ❌ Error: Token file '.watsup_ipc_token' was not generated.
        taskkill /f /pid !ENGINE_PID! >nul 2>nul
        del %PID_FILE% >nul 2>nul
        pause
        exit /b 1
    )

    call :wait_for_status
    if !errorlevel! neq 0 (
        echo ❌ Error: Node.js engine failed to respond with healthy status.
        echo Check engine_err.log for error details.
        taskkill /f /pid !ENGINE_PID! >nul 2>nul
        del %PID_FILE% >nul 2>nul
        pause
        exit /b 1
    )
)

:: 6. Launch Tkinter GUI dashboard
echo 🎨 Starting dark-themed UI dashboard...
python ui.py

:: 7. Cleanup background engine on GUI exit (reused engines are not killed)
echo 🧹 Cleaning up background engine...
if defined ENGINE_PID (
    if "!REUSE_ENGINE!"=="0" (
        :: Verify PID, Start Time, and command line to ensure it is the exact engine.js process
        powershell -NoProfile -Command "$proc = Get-Process -Id !ENGINE_PID! -ErrorAction SilentlyContinue; if ($proc -and $proc.StartTime.Ticks -eq !ENGINE_START_TIME!) { $cmd = (Get-CimInstance Win32_Process -Filter \"ProcessId = !ENGINE_PID!\").CommandLine; if ($cmd -match 'engine.js') { Stop-Process -Id !ENGINE_PID! -Force } }" >nul 2>nul
        del %PID_FILE% >nul 2>nul
    )
)

echo ✨ Goodbye!
goto :eof

:: ==========================================
:: SUBROUTINES
:: ==========================================

:wait_for_token
for /L %%c in (1,1,10) do (
    if exist .watsup_ipc_token (
        exit /b 0
    )
    timeout /t 1 /nobreak >nul
)
exit /b 1

:wait_for_status
for /L %%c in (1,1,10) do (
    set "RESPONSE="
    set /p TOKEN=<.watsup_ipc_token
    for /f "delims=" %%i in ('curl -s -H "X-WatsUp-Token: !TOKEN!" -m 2 http://127.0.0.1:5001/api/status 2^>nul') do (
        set "RESPONSE=%%i"
    )
    echo !RESPONSE! | findstr /i "status" >nul
    if !errorlevel! equ 0 (
        exit /b 0
    )
    timeout /t 1 /nobreak >nul
)
exit /b 1
