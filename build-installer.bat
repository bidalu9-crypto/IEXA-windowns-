@echo off
setlocal
chcp 65001 >nul
title IEXA - Build Installer

for %%I in ("%~dp0.") do set "ROOT=%%~fI"

echo ========================================
echo   IEXA-WIN - Build EXE Installer
echo ========================================
echo.

cd /d "%ROOT%"
if errorlevel 1 goto failed

echo [1/5] Checking Node.js and dependencies...
call "%ROOT%\scripts\ensure-node-deps.bat" "%ROOT%"
if errorlevel 1 goto failed

echo [2/5] Checking Electron runtime...
call "%ROOT%\scripts\ensure-electron-runtime.bat" "%ROOT%"
if errorlevel 1 goto failed

echo [3/5] Compiling TypeScript...
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] TypeScript compilation failed.
    goto failed
)
echo       OK.

echo [4/5] Building distribution folder...
node build-dist.js
if errorlevel 1 (
    echo [ERROR] Distribution build failed.
    goto failed
)
echo       OK.

where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Windows PowerShell was not found.
    goto failed
)

echo [5/5] Creating setup EXE...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\create-installer.ps1"
if errorlevel 1 (
    echo [ERROR] Installer creation failed.
    goto failed
)
echo       OK.

echo.
if not exist "%ROOT%\release\IEXA-Setup.exe" (
    echo [ERROR] Installer command completed, but release\IEXA-Setup.exe is missing.
    goto failed
)

for %%A in ("%ROOT%\release\IEXA-Setup.exe") do set "INSTALLER_SIZE=%%~zA"
for /f "usebackq delims=" %%M in (`powershell.exe -NoLogo -NoProfile -Command "[math]::Round(%INSTALLER_SIZE% / 1MB, 1)"`) do set "INSTALLER_MB=%%M"
echo.
echo ========================================
echo   BUILD SUCCESSFUL
echo ========================================
echo.
echo   Installer: release\IEXA-Setup.exe
echo   Size: %INSTALLER_MB% MB
echo.
echo   Run this EXE on any Windows machine
echo   to install IEXA with a desktop
echo   shortcut.
echo.

pause
exit /b 0

:failed
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [FAILED] Installer build stopped. Review the error above.
pause
exit /b %EXIT_CODE%
