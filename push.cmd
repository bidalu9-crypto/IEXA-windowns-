@echo off
setlocal
cd /d "%~dp0"

rem When this copy lives outside the checkout (Desktop, a USB stick), fall back
rem to the repository path baked in below so double-click still works.
git rev-parse --is-inside-work-tree >nul 2>&1
if not errorlevel 1 goto :ready
if exist "E:\IEXA-WIN\.git" (
  cd /d "E:\IEXA-WIN"
  git rev-parse --is-inside-work-tree >nul 2>&1
)
if errorlevel 1 goto :nogit

:ready
echo ===========================
echo   IEXA-WIN push
echo ===========================
echo.

git config user.email >nul 2>&1
if errorlevel 1 goto :noident

echo [changes]
git status --short
echo.

set CHANGES=0
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set CHANGES=%%i

if not "%CHANGES%"=="0" goto :haschanges

echo No local changes. Syncing with remote...
git pull --rebase
if errorlevel 1 goto :fail
echo Already up to date.
goto :end

:haschanges
set "MSG="
set /p "MSG=Commit message (Enter = update): "
if "%MSG%"=="" set "MSG=update"

echo.
echo [1/3] stage
git add -A
if errorlevel 1 goto :fail

echo [2/3] commit
git commit -m "%MSG%"
if errorlevel 1 goto :fail

echo [3/3] pull --rebase, then push
git pull --rebase
if errorlevel 1 goto :fail
git push
if errorlevel 1 goto :fail

echo.
echo Push OK:
git log --oneline -1
goto :end

:nogit
echo Not a git repository.
echo Looked in: %~dp0
echo and in:   E:\IEXA-WIN
echo Clone first: git clone git@github.com:bidalu9-crypto/IEXA-windowns-.git
goto :end

:noident
echo git identity is not set. Run these first:
echo   git config --global user.name  "Your Name"
echo   git config --global user.email "you@example.com"
goto :end

:fail
echo.
echo FAILED - see the message above.
echo   Permission denied : ask for Write access on the repository
echo   SSH failure       : run  ssh -T git@github.com
echo   Rebase conflict   : run  git rebase --abort

:end
echo.
if /i not "%~1"=="/nopause" pause
endlocal
