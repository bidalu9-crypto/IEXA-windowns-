@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title IEXA-WIN

:: ---- Configuration ----
set "ELECTRON_EXE=%LOCALAPPDATA%\electron\Cache\electron-v28.0.0-win32-x64\electron.exe"
set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"

echo ========================================
echo   IEXA-WIN - Multi-instance Desktop Client
echo   Double-click to open a new window
echo   Each window has independent port + workspace
echo ========================================
echo.

:: ---- Check Node.js ----
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
    set "NODE_EXE=node"
)

echo [Check] Node.js: !NODE_EXE!
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found! Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: ---- Check Electron ----
echo [Check] Electron: %ELECTRON_EXE%
if not exist "%ELECTRON_EXE%" (
    echo [ERROR] Electron not found!
    echo.
    echo Running one-time setup download...
    echo.
    "%NODE_EXE%" "%APP_DIR%\download_electron.js"
    if errorlevel 1 (
        echo [ERROR] Electron download failed. Check your network.
        pause
        exit /b 1
    )
    "%NODE_EXE%" "%APP_DIR%\extract_electron.js"
    if errorlevel 1 (
        echo [ERROR] Electron extraction failed.
        pause
        exit /b 1
    )
    if not exist "%ELECTRON_EXE%" (
        echo [ERROR] Electron still not found after setup.
        pause
        exit /b 1
    )
    echo [OK] Electron setup complete!
)

:: ---- Build TypeScript if needed ----
cd /d "%APP_DIR%"
if not exist "dist\main\server.js" (
    echo [Build] Compiling TypeScript...
    "%NODE_EXE%" node_modules\typescript\bin\tsc
    if errorlevel 1 (
        echo [ERROR] TypeScript compilation failed!
        pause
        exit /b 1
    )
    echo [OK] Build complete!
)

:: ---- Launch new Electron instance ----
echo.
echo [Launch] Starting new IEXA instance...
echo.
start "" "%ELECTRON_EXE%" "%APP_DIR%"

echo New IEXA instance is starting. A new desktop window will appear.
echo Double-click this script again to open another window.
echo.

timeout /t 2 >nul
exit /b 0
