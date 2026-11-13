@echo off
setlocal
cd /d "%~dp0"

rem 副本放在仓库外（桌面、U 盘）时，跳到本机检出的仓库
git rev-parse --is-inside-work-tree >nul 2>&1
if not errorlevel 1 goto :ready
if exist "E:\IEXA-WIN\.git\" (
  cd /d "E:\IEXA-WIN"
  git rev-parse --is-inside-work-tree >nul 2>&1
)
if errorlevel 1 goto :nogit

:ready
echo ===========================
echo   IEXA-WIN 推送
echo ===========================
echo.

git config user.email >nul 2>&1
if errorlevel 1 goto :noident

echo [当前改动]
git status --short
echo.

set CHANGES=0
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set CHANGES=%%i

if not "%CHANGES%"=="0" goto :haschanges

echo 没有本地改动，只同步远端。
call :pull
if errorlevel 1 goto :fail
goto :end

:haschanges
set "MSG="
set /p "MSG=提交说明（回车=update）: "
if "%MSG%"=="" set "MSG=update"

echo.
echo [1/3] 暂存
git add -A
if errorlevel 1 goto :fail

echo [2/3] 提交
git commit -m "%MSG%"
if errorlevel 1 goto :fail

echo [3/3] 同步远端后推送
call :pull
if errorlevel 1 goto :fail
git push
if errorlevel 1 goto :fail

echo.
echo 推送成功：
git log --oneline -1
goto :end

:pull
git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>&1
if errorlevel 1 (
  echo 当前分支还没有远端对应，跳过 pull。
  exit /b 0
)
git pull --rebase
exit /b %errorlevel%

:nogit
echo 这里不是 git 仓库。
echo   找过：%~dp0
echo   还有：E:\IEXA-WIN
echo 先克隆：git clone git@github.com:bidalu9-crypto/IEXA-windowns-.git
goto :end

:noident
echo 还没配置 git 身份，提交会失败。先运行：
echo   git config --global user.name  "你的名字"
echo   git config --global user.email "你的邮箱"
goto :end

:fail
echo.
echo 失败，上面那一行就是原因。
echo   权限被拒 - 让仓库主人把你的 GitHub 账号加成 Write 协作者
echo   SSH 失败 - 运行 ssh -T git@github.com 看能不能通
echo   变基冲突 - 运行 git rebase --abort 回到推送前

:end
echo.
if /i not "%~1"=="/nopause" pause
endlocal
