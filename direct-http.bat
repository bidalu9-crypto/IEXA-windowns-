title Local IEXA (direct)
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  iExA HTTP server, started straight from the existing dist\.
rem
rem  Nothing is compiled here, and nothing is installed: the
rem  build step costs tens of seconds and only matters after a
rem  source change. After editing src\, run http-build-start.bat
rem  once instead - this file warns when dist\ is stale, but it
rem  will never silently rebuild.
rem
rem  Pure ASCII on purpose: cmd.exe reads .bat bytes in the OEM
rem  codepage, so UTF-8 Chinese in a rem line breaks parsing.
rem ============================================================
set "IEXA_MOBILE_PORT=443"

rem --- addresses ---------------------------------------------------------
rem  Read live: the router renumbers IPv6 on every reconnect and DHCP can move
rem  IPv4 too, so neither address is written down here.
rem  scripts\net-addresses.cjs answers in ~80 ms; the PowerShell call it
rem  replaces cost ~1.4 s on a cold start, which was most of the wait before
rem  node had even begun loading. The same script reports a stale dist\.
rem
rem  The answer lands in a temp file and is read back with `usebackq usefile`
rem  rather than with `for /f` over a pipe: inside a parenthesised block cmd
rem  silently returns nothing for a piped command here, which is how the IPv6
rem  line kept vanishing. A file has no code page in the way.
rem ----------------------------------------------------------------------
set "IEXA_V4=unavailable"
set "IEXA_V6="
set "IEXA_STALE=0"
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

echo.
echo ========================================
echo   IEXA-WIN - HTTP Server (direct, no build)
echo   On this device : http://127.0.0.1:19840/
echo   Local Network  : http://%IEXA_V4%
if defined IEXA_V6 (
    echo   IPV6           : http://[%IEXA_V6%]
) else (
    echo   IPV6           : (no global address^)
)
echo ========================================
if "%IEXA_STALE%"=="1" (
    echo   [WARN] dist\ is older than src\. Run http-build-start.bat to rebuild.
    echo ========================================
)
echo.

rem --- self-test: direct-http.bat --dry  parses this file, then exits ---
if /i "%~1"=="--dry" (
    echo [DRY] Batch parsed cleanly. Nothing stopped, nothing launched.
    exit /b 0
)

if not exist "dist\main\server.js" (
    echo [ERROR] dist\main\server.js is missing.
    echo         Run http-build-start.bat once; after that this file works alone.
    pause
    exit /b 1
)

rem --- stop the previous iExA server so port 443 can be rebound ----------
rem  Skipped when nothing named node.exe is running: stop-lan.ps1 has to spin
rem  up PowerShell and a WMI query (~0.9 s) just to report "nothing to do".
rem  tasklist is native and costs ~0.2 s instead.
rem ----------------------------------------------------------------------
tasklist /fi "imagename eq node.exe" /nh 2>nul | find /i "node.exe" >nul
if not errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-lan.ps1"

rem --- absolute node path: PATH may be minimal when launched by hand --------
rem  Resolved with the addresses above, which need the same binary.
set "NODE_EXE=%NODE_EXE%"

rem --- log sink ----------------------------------------------------------
rem  Tee-Object does not create its parent directory. On a copy whose
rem  workspace\ was cleaned out, every single line of server output therefore
rem  raised "Could not find a part of the path ... lan-server.log": the line
rem  was swallowed instead of printed, and formatting that many PowerShell
rem  errors made startup crawl. Create the directory first, and fall back to
rem  console-only when it cannot be created.
rem  The path travels in an environment variable so quotes and spaces in it
rem  never have to survive a round trip through a command line.
rem ----------------------------------------------------------------------
set "LOGDIR=%~dp0workspace\.tmp"
set "IEXA_LOG="
if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul
if exist "%LOGDIR%" set "IEXA_LOG=%LOGDIR%\lan-server.log"
if not defined IEXA_LOG echo [WARN] Cannot create "%LOGDIR%" - console only, no log file.
if defined IEXA_LOG echo [Log] %IEXA_LOG%

echo [Launch] Starting server from dist\ (no build)...
echo [Tip] Close this window to stop the server.
echo.

if defined IEXA_LOG (
    if exist "%~dp0scripts\tee-log.cjs" (
        "%NODE_EXE%" dist\main\server.js 2>&1 | "%NODE_EXE%" "%~dp0scripts\tee-log.cjs"
    ) else (
        "%NODE_EXE%" dist\main\server.js 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath $env:IEXA_LOG -Append"
    )
) else (
    "%NODE_EXE%" dist\main\server.js
)
rem In the piped branch this is PowerShell's status, not node's: a crashed
rem server still ends on 0. The log file is the record that matters.
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [ERROR] IEXA server exited with code %EXIT_CODE%.
echo.
pause
exit /b %EXIT_CODE%
