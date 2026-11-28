title Local IEXA
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  IEXA server. Started by hand only: nothing registers this at logon.
rem
rem  Mobile bridge is pinned to 443.  The phone URL follows whatever global
rem  IPv6 prefix the router currently advertises, so nothing here needs editing
rem  when the ISP renumbers: open the pairing panel and it shows the live one.
rem    https://192.168.1.5/          (same WiFi)
rem    https://[<current global v6>]/  (any network)
rem  Port 80 answers with a 301 to https on both families.
rem
rem  This file is pure ASCII on purpose: cmd.exe reads .bat bytes in the
rem  OEM codepage, so UTF-8 Chinese in a rem line breaks parsing.
rem ============================================================
set "IEXA_MOBILE_PORT=443"

rem --- banner -------------------------------------------------------------
rem  Port 19840 is the constant in src/main/server.ts, so printing it is safe.
rem  The addresses are read live instead: the router hands out a fresh IPv6
rem  global address on every reconnect, and DHCP can move the IPv4 one too.
rem  scripts\net-addresses.cjs answers in ~80 ms; the PowerShell call it
rem  replaces cost ~1.4 s on a cold start, which was most of the wait before
rem  node had even begun loading.
rem
rem  The answer lands in a temp file and is read back with `usebackq usefile`
rem  rather than with `for /f` over a pipe: inside a parenthesised block cmd
rem  silently returns nothing for a piped command here, which is how the IPv6
rem  line kept vanishing. A file has no code page in the way.
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
if not defined IEXA_V4 set "IEXA_V4=unavailable"

echo.
echo ========================================
echo   IEXA-WIN - HTTP Server
echo   On this device : http://127.0.0.1:19840/
echo   Local Network   : https://%IEXA_V4%/
if defined IEXA_V6 (
    echo   IPV6           : https://[%IEXA_V6%]/
) else (
    echo   IPV6           : (no global address^)
)
echo ========================================
echo.

rem --- self-test: start.bat --dry  parses this file, then exits ---
if /i "%~1"=="--dry" (
    echo [DRY] Batch parsed cleanly. Nothing stopped, nothing launched.
    exit /b 0
)

rem --- stop the previous iExA server so port 443 can be rebound ----------
rem  Skipped when nothing named node.exe is running: stop-lan.ps1 spins up
rem  PowerShell plus a WMI query (~0.9 s) just to say "nothing to do".
rem ----------------------------------------------------------------------
tasklist /fi "imagename eq node.exe" /nh 2>nul | find /i "node.exe" >nul
if not errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-lan.ps1"

call "%~dp0scripts\ensure-node-deps.bat" "%~dp0"
if errorlevel 1 goto failed

echo [Build] Compiling TypeScript...
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] TypeScript compilation failed.
    goto failed
)

rem --- absolute node path: PATH may be minimal when launched by hand --------
rem  Resolved with the banner above, which needs the same binary.
set "NODE_EXE=%NODE_EXE%"

echo [Launch] Starting server (mobile bridge pinned to 443)...
echo [Tip] Close this window to stop the server.
echo.

rem --- log sink ----------------------------------------------------------
rem  Tee-Object does not create its parent directory, so on a copy whose
rem  workspace\ was cleaned out every line of output raised "Could not find a
rem  part of the path ... lan-server.log" and was swallowed instead of printed.
rem  Create it first, fall back to console-only if that fails, and pass the
rem  path through the environment so spaces and quotes never round-trip
rem  through a command line.
rem ----------------------------------------------------------------------
set "LOGDIR=%~dp0workspace\.tmp"
set "IEXA_LOG="
if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul
if exist "%LOGDIR%" set "IEXA_LOG=%LOGDIR%\lan-server.log"
if not defined IEXA_LOG echo [WARN] Cannot create "%LOGDIR%" - console only, no log file.

rem Tee the console output to a file so a silent failure (a failed unprompted
rem generation, a segmenting error) can be read after the fact.
if defined IEXA_LOG (
    if exist "%~dp0scripts\tee-log.cjs" (
        "%NODE_EXE%" dist\main\server.js 2>&1 | "%NODE_EXE%" "%~dp0scripts\tee-log.cjs"
    ) else (
        "%NODE_EXE%" dist\main\server.js 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath $env:IEXA_LOG -Append"
    )
) else (
    "%NODE_EXE%" dist\main\server.js
)
rem In the piped branch this is PowerShell's status, not node's.
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
