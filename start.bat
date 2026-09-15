@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title IEXA-WIN Server

echo.
echo ========================================
echo   IEXA-WIN - HTTP Server
echo ========================================
echo.

call "%~dp0scripts\ensure-node-deps.bat" "%~dp0"
if errorlevel 1 goto failed

echo [Build] Compiling TypeScript...
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] TypeScript compilation failed.
    goto failed
)

echo [Launch] Starting server on dynamic port...
echo [Tip] Close this window to stop the server.
echo.

node dist\main\server.js
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [ERROR] IEXA server exited with code %EXIT_CODE%.
echo.
pause
exit /b %EXIT_CODE%

:failed
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [FAILED] IEXA was not started. Review the error above.
pause
exit /b %EXIT_CODE%
