@echo off
setlocal

set "APP_DIR=%~1"
if not defined APP_DIR set "APP_DIR=%~dp0.."
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"

set "ELECTRON_VERSION=28.0.0"
set "ELECTRON_CACHE=%LOCALAPPDATA%\electron\Cache"
set "ELECTRON_DIR=%ELECTRON_CACHE%\electron-v%ELECTRON_VERSION%-win32-x64"
set "ELECTRON_ZIP=%ELECTRON_CACHE%\electron-v%ELECTRON_VERSION%-win32-x64.zip"
set "ELECTRON_EXE=%ELECTRON_DIR%\electron.exe"

call :runtime_complete
if not errorlevel 1 (
    echo [OK] Electron %ELECTRON_VERSION% runtime is ready.
    exit /b 0
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Windows PowerShell is required to extract Electron.
    exit /b 30
)

echo [Setup] Electron %ELECTRON_VERSION% runtime is missing.
if not exist "%ELECTRON_ZIP%" call :download_electron
if errorlevel 1 exit /b 31

call :extract_electron
if not errorlevel 1 goto runtime_ready

echo [Warn] The cached Electron archive is invalid. Downloading a fresh copy...
powershell.exe -NoLogo -NoProfile -Command "Remove-Item -LiteralPath $env:ELECTRON_ZIP -Force -ErrorAction SilentlyContinue"
if errorlevel 1 (
    echo [ERROR] Could not remove the invalid Electron archive.
    exit /b 32
)
call :download_electron
if errorlevel 1 exit /b 33
call :extract_electron
if errorlevel 1 exit /b 34

:runtime_ready
call :runtime_complete
if errorlevel 1 (
    echo [ERROR] Electron extraction finished, but the runtime is incomplete.
    exit /b 35
)
echo [OK] Electron %ELECTRON_VERSION% runtime is ready.
exit /b 0

:download_electron
echo [Setup] Downloading Electron. This is a one-time download of about 112 MB...
node "%APP_DIR%\download_electron.js"
if errorlevel 1 (
    echo [ERROR] Electron download failed. Check the network and proxy settings.
    exit /b 1
)
exit /b 0

:extract_electron
echo [Setup] Extracting Electron runtime...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; if (Test-Path -LiteralPath $env:ELECTRON_DIR) { Remove-Item -LiteralPath $env:ELECTRON_DIR -Recurse -Force }; New-Item -ItemType Directory -Path $env:ELECTRON_DIR -Force | Out-Null; Expand-Archive -LiteralPath $env:ELECTRON_ZIP -DestinationPath $env:ELECTRON_DIR -Force"
if errorlevel 1 (
    echo [ERROR] Electron extraction failed.
    exit /b 1
)
exit /b 0

:runtime_complete
if not exist "%ELECTRON_EXE%" exit /b 1
if not exist "%ELECTRON_DIR%\icudtl.dat" exit /b 1
if not exist "%ELECTRON_DIR%\resources\default_app.asar" exit /b 1
exit /b 0
