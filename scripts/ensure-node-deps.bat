@echo off
setlocal

set "APP_DIR=%~1"
if not defined APP_DIR set "APP_DIR=%~dp0.."
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"

echo [Check] Looking for Node.js and npm...
where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo         Install Node.js 20 LTS or newer from https://nodejs.org/
    echo         Then close this window and double-click the script again.
    exit /b 10
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Reinstall Node.js with npm enabled.
    echo         Download: https://nodejs.org/
    exit /b 11
)

for /f "usebackq delims=" %%V in (`node -p "process.versions.node" 2^>nul`) do set "NODE_VERSION=%%V"
for /f "usebackq delims=" %%V in (`node -p "Number(process.versions.node.split('.')[0])" 2^>nul`) do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
    echo [ERROR] Node.js was found but could not be executed.
    exit /b 12
)
if %NODE_MAJOR% LSS 20 (
    echo [ERROR] Node.js %NODE_VERSION% is too old. IEXA requires Node.js 20 or newer.
    echo         Download the current LTS release from https://nodejs.org/
    exit /b 13
)

for /f "usebackq delims=" %%V in (`npm.cmd --version 2^>nul`) do set "NPM_VERSION=%%V"
if not defined NPM_VERSION (
    echo [ERROR] npm was found but could not be executed.
    exit /b 14
)

echo [OK] Node.js %NODE_VERSION%, npm %NPM_VERSION%
cd /d "%APP_DIR%"
if errorlevel 1 (
    echo [ERROR] Could not open the IEXA directory: %APP_DIR%
    exit /b 15
)

set "NEED_INSTALL=0"
if "%IEXA_FORCE_INSTALL%"=="1" set "NEED_INSTALL=1"
if not exist "package.json" (
    echo [ERROR] package.json is missing from: %APP_DIR%
    exit /b 16
)
if not exist "node_modules\.package-lock.json" set "NEED_INSTALL=1"
if not exist "node_modules\typescript\bin\tsc" set "NEED_INSTALL=1"
if not exist "node_modules\marked\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\node-pty\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\webdav\package.json" set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="0" (
    call npm.cmd ls --depth=0 --silent >nul 2>&1
    if errorlevel 1 set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="0" (
    echo [OK] Node dependencies are ready.
    exit /b 0
)

echo.
echo [Setup] Node dependencies are missing or incomplete.
if exist "package-lock.json" (
    echo [Setup] Running npm ci. This may take several minutes on first launch...
    call npm.cmd ci
    if not errorlevel 1 goto verify_dependencies
    echo.
    echo [Warn] npm ci failed. Retrying with npm install...
) else (
    echo [Setup] package-lock.json was not found. Running npm install...
)

call npm.cmd install
if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed.
    echo         Check the network, proxy, npm registry, and the error above.
    exit /b 20
)

:verify_dependencies
if not exist "node_modules\typescript\bin\tsc" goto dependency_error
if not exist "node_modules\marked\package.json" goto dependency_error
if not exist "node_modules\node-pty\package.json" goto dependency_error
if not exist "node_modules\webdav\package.json" goto dependency_error
call npm.cmd ls --depth=0 --silent >nul 2>&1
if errorlevel 1 goto dependency_error

echo [OK] Node dependencies were installed successfully.
exit /b 0

:dependency_error
echo.
echo [ERROR] npm finished, but required dependencies are still incomplete.
echo         Run "npm install" in this directory and review the npm error log.
exit /b 21
