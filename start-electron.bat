@echo off
setlocal
chcp 65001 >nul
title IEXA-WIN

set "ELECTRON_EXE=%LOCALAPPDATA%\electron\Cache\electron-v28.0.0-win32-x64\electron.exe"
for %%I in ("%~dp0.") do set "APP_DIR=%%~fI"

echo ========================================
echo   IEXA-WIN - Multi-instance Desktop Client
echo   Double-click to open a new window
echo   Each window has independent port + workspace
echo ========================================
echo.

cd /d "%APP_DIR%"
if errorlevel 1 goto failed

call "%APP_DIR%\scripts\ensure-node-deps.bat" "%APP_DIR%"
if errorlevel 1 goto failed

call "%APP_DIR%\scripts\ensure-electron-runtime.bat" "%APP_DIR%"
if errorlevel 1 goto failed

echo [Build] Compiling TypeScript...
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] TypeScript compilation failed.
    goto failed
)
echo [OK] Build complete.

echo.
echo [Launch] Starting new IEXA instance...
echo.
start "" "%ELECTRON_EXE%" "%APP_DIR%"
if errorlevel 1 goto failed

echo New IEXA instance is starting. A new desktop window will appear.
echo Double-click this script again to open another window.
echo.

timeout /t 2 >nul
exit /b 0

:failed
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [FAILED] IEXA was not started. Review the error above.
pause
exit /b %EXIT_CODE%
