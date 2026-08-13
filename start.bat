@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PATH=C:\Program Files\nodejs;%PATH%"

echo.
echo ========================================
echo   IEXA-WIN Clean - Dynamic Port Version
echo ========================================
echo.

if not exist "dist\main\server.js" (
    echo [Build] Compiling TypeScript...
    call npm run build
    if errorlevel 1 (
        echo.
        echo [ERROR] TypeScript compilation failed.
        pause
        exit /b 1
    )
)

echo [Launch] Starting server on dynamic port...
echo [Tip] Close this window to stop the server.
echo.

node dist\main\server.js

pause
