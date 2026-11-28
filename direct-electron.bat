title IEXA-WIN (direct)
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

for %%I in ("%~dp0.") do set "APP_DIR=%%~fI"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"

rem ============================================================
rem  iExA desktop window, started straight from the existing
rem  dist\ and node_modules\.
rem
rem  Nothing is compiled here, and nothing is installed: the
rem  build step costs tens of seconds and only matters after a
rem  source change. After editing src\, run electron-build-start
rem  once instead - this file warns when dist\ is stale, but it
rem  will never silently rebuild.
rem
rem  Pure ASCII on purpose: cmd.exe reads .bat bytes in the OEM
rem  codepage, so UTF-8 Chinese in a rem line breaks parsing.
rem ============================================================

rem --- addresses ---------------------------------------------------------
rem  Read live: the router renumbers IPv6 on every reconnect and DHCP
rem  can move IPv4 too. Emitted as key=value so an absent IPv6 does not
rem  shift the tokens. No pipe below - for /f reads "|" as redirection.
rem ----------------------------------------------------------------------
set "IEXA_V4=unavailable"
set "IEXA_V6="
set "IEXA_STALE=0"
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$b=@(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp -ErrorAction SilentlyContinue)[0]; $a=@(Get-NetIPAddress -AddressFamily IPv6 -PrefixOrigin RouterAdvertisement -AddressState Preferred -ErrorAction SilentlyContinue)[0]; $m=[datetime]::MinValue; foreach($f in Get-ChildItem 'src' -Recurse -Include *.ts,*.js -ErrorAction SilentlyContinue){ if($f.LastWriteTime -gt $m){$m=$f.LastWriteTime} }; $s=Get-Item 'dist\main\server.js' -ErrorAction SilentlyContinue; $stale=0; if($s -and $m -gt $s.LastWriteTime){$stale=1}; 'IEXA_V4={0}' -f $b.IPAddress; 'IEXA_V6={0}' -f $a.IPAddress; 'IEXA_STALE={0}' -f $stale"`) do set "%%a"

echo.
echo ========================================
echo   IEXA-WIN - Multi-instance Desktop Client (direct, no build)
echo   Double-click to open a new window
echo   Each window has independent port + workspace
echo   Local Network : http://%IEXA_V4%
if defined IEXA_V6 (
    echo   IPV6          : http://[%IEXA_V6%]
) else (
    echo   IPV6          : (no global address^)
)
echo ========================================
if "%IEXA_STALE%"=="1" (
    echo   [WARN] dist\ is older than src\. Run electron-build-start.bat to rebuild.
    echo ========================================
)
rem A window binds loopback on a port picked per window, so the two
rem addresses above describe this machine, not this window.
echo   [Note] Windows listen on 127.0.0.1. Phone/other devices: http-build-start.bat
echo.

rem --- self-test: direct-electron.bat --dry  parses this file, then exits ---
if /i "%~1"=="--dry" (
    echo [DRY] Batch parsed cleanly. Nothing installed, nothing launched.
    exit /b 0
)

if not exist "%ELECTRON_EXE%" (
    echo [ERROR] %ELECTRON_EXE% is missing.
    echo         Run electron-build-start.bat once; after that this file works alone.
    pause
    exit /b 1
)
if not exist "dist\main\server.js" (
    echo [ERROR] dist\main\server.js is missing.
    echo         Run electron-build-start.bat once; after that this file works alone.
    pause
    exit /b 1
)

echo [Launch] Starting a new IEXA window from dist\ (no build)...
echo.

rem The launcher waits for the app window, hides this console, then supervises the
rem process: the window disappears together with IEXA instead of lingering.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\electron-launcher.ps1" -ElectronExe "%ELECTRON_EXE%" -AppDir "%APP_DIR%"
set "LAUNCH_CODE=%ERRORLEVEL%"
if not "%LAUNCH_CODE%"=="0" (
    echo.
    echo [FAILED] IEXA was not started. Review the error above.
    pause
    exit /b %LAUNCH_CODE%
)
exit /b 0
