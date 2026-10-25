@echo off
setlocal
chcp 65001 >nul
title IEXA-WIN

for %%I in ("%~dp0.") do set "APP_DIR=%%~fI"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"

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

rem The launcher waits for the app window, hides this console, then supervises the
rem process: the window disappears together with IEXA instead of lingering.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\electron-launcher.ps1" -ElectronExe "%ELECTRON_EXE%" -AppDir "%APP_DIR%"
set "LAUNCH_CODE=%ERRORLEVEL%"
if not "%LAUNCH_CODE%"=="0" (
    set "EXIT_CODE=%LAUNCH_CODE%"
    goto failed
)
exit /b 0

:failed
if not defined EXIT_CODE set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [FAILED] IEXA was not started. Review the error above.
pause
exit /b %EXIT_CODE%
