@echo off
setlocal
chcp 65001 >nul
title IEXA-WIN

for %%I in ("%~dp0.") do set "APP_DIR=%%~fI"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"

rem --- addresses -----------------------------------------------------------
rem  Same live lookup as http-build-start.bat: DHCP moves the IPv4 one and the
rem  router hands out a fresh IPv6 global prefix on every reconnect, so neither
rem  address can be written down here.
rem  scripts\net-addresses.cjs answers in ~80 ms where the PowerShell call it
rem  replaces cost ~1.4 s, so the banner appears immediately instead of after a
rem  visible pause. The answer lands in a temp file and is read back with
rem  `usebackq usefile`: inside a parenthesised block cmd silently returns
rem  nothing for a piped command here, which is how the IPv6 line kept
rem  vanishing. A file has no code page in the way.
rem ------------------------------------------------------------------------
set "IEXA_V4=unavailable"
set "IEXA_V6="
set "NODE_EXE=%LOCALAPPDATA%\IEXA\runtime\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "IEXA_ADDR_FILE=%TEMP%\iexa-addr-%RANDOM%%RANDOM%.env"
if exist "%~dp0scripts\net-addresses.cjs" (
    "%NODE_EXE%" "%~dp0scripts\net-addresses.cjs" > "%IEXA_ADDR_FILE%" 2>nul
)
if exist "%IEXA_ADDR_FILE%" (
    for /f "usebackq delims=" %%a in ("%IEXA_ADDR_FILE%") do set "%%a"
    del "%IEXA_ADDR_FILE%" >nul 2>nul
)

echo ========================================
echo   IEXA-WIN - Multi-instance Desktop Client
echo   Double-click to open a new window
echo   Each window has independent port + workspace
echo   Local Network : http://%IEXA_V4%
if defined IEXA_V6 (
    echo   IPV6          : http://[%IEXA_V6%]
) else (
    echo   IPV6          : (no global address)
)
echo ========================================
rem Bare host, no port: the http-build-start.bat server answers :80 with a 301
rem to https on :443, so the copied line works as-is. A desktop window is
rem loopback-only, so these open the mobile server, not this window.
echo   [Note] Windows listen on 127.0.0.1. Phone/other devices: http-build-start.bat
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
