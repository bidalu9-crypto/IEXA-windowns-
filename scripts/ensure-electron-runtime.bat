@echo off
setlocal
set "APP_DIR=%~1"
if not defined APP_DIR set "APP_DIR=%~dp0.."
for %%I in ("%APP_DIR%") do set "APP_DIR=%%~fI"
node "%APP_DIR%\download_electron.js" --install
if errorlevel 1 exit /b 31
node "%APP_DIR%\scripts\rebuild-native.cjs"
if errorlevel 1 exit /b 32
exit /b 0
