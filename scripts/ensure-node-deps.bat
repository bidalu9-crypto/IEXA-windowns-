@echo off
setlocal

set "APP_DIR=%~1"
if not defined APP_DIR set "APP_DIR=%~dp0.."
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"
set "PORTABLE_RUNTIME_ROOT=%LOCALAPPDATA%\IEXA\runtime"
set "PORTABLE_NODE_DIR=%PORTABLE_RUNTIME_ROOT%\node"

echo [Check] Looking for Node.js and npm...
call :detect_supported_node
if errorlevel 1 call :install_portable_node
if errorlevel 1 exit /b %ERRORLEVEL%
call :detect_supported_node
if errorlevel 1 (
    echo [ERROR] Node.js installation completed, but Node.js 20 or newer is still unavailable.
    exit /b 12
)

for /f "usebackq delims=" %%V in (`node -p "process.versions.node" 2^>nul`) do set "NODE_VERSION=%%V"
for /f "usebackq delims=" %%V in (`node -p "Number(process.versions.node.split('.')[0])" 2^>nul`) do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
    echo [ERROR] Node.js was found but could not be executed.
    exit /b 12
)
if %NODE_MAJOR% LSS 20 (
    echo [ERROR] Node.js %NODE_VERSION% is too old after automatic setup.
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
    goto success
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
goto success

:dependency_error
echo.
echo [ERROR] npm finished, but required dependencies are still incomplete.
echo         Run "npm install" in this directory and review the npm error log.
exit /b 21

:detect_supported_node
set "NODE_VERSION="
set "NODE_MAJOR="
where node.exe >nul 2>&1
if errorlevel 1 exit /b 1
for /f "usebackq delims=" %%V in (`node.exe -p "process.versions.node" 2^>nul`) do set "NODE_VERSION=%%V"
for /f "usebackq delims=" %%V in (`node.exe -p "Number(process.versions.node.split('.')[0])" 2^>nul`) do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR exit /b 1
if %NODE_MAJOR% LSS 20 exit /b 1
where npm.cmd >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:install_portable_node
echo [Setup] Node.js 20 or newer was not found. Installing a portable LTS runtime...
where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Windows PowerShell is required for automatic Node.js installation.
    exit /b 40
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-portable-node.ps1" -RuntimeRoot "%PORTABLE_RUNTIME_ROOT%"
if errorlevel 1 exit /b %ERRORLEVEL%
set "PATH=%PORTABLE_NODE_DIR%;%PATH%"
exit /b 0

:success
set "NODE_BIN_DIR="
set "NODE_EXE_PATH="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE_PATH set "NODE_EXE_PATH=%%~fI"
if defined NODE_EXE_PATH for %%I in ("%NODE_EXE_PATH%") do set "NODE_BIN_DIR=%%~dpI"
if not defined NODE_BIN_DIR set "NODE_BIN_DIR=%PORTABLE_NODE_DIR%"
endlocal & set "IEXA_NODE_HOME=%NODE_BIN_DIR%" & set "PATH=%NODE_BIN_DIR%;%PATH%"
exit /b 0
