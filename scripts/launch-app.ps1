# 启动一个 GUI 程序，立刻返回，不挂住调用方。
#
# 为什么需要它：在 cmd 里 `start "" app.exe` 之后，子进程会继承父进程的
# stdout 句柄。GUI 程序一直活着，管道就一直不关闭，等管道 EOF 的调用方
# （shell_execute）就会一直等到超时被取消——任务看起来「结束不掉」。
#
# Start-Process 默认 UseShellExecute=true，子进程不继承父进程的标准句柄，
# 父 PowerShell 启动完立即退出，管道随之关闭。所以这里不用 cmd 的 start，
# 也不重定向输出（一旦重定向就会退回句柄继承）。
#
# 用法：
#   powershell -NoProfile -File scripts\launch-app.ps1 -Path "C:\...\app.exe"
#   powershell -NoProfile -File scripts\launch-app.ps1 -Path "C:\...\app.exe" -Arguments "--flag"
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string[]]$Arguments = @(),
  [string]$WorkingDirectory = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Output ("FAIL not found: " + $Path)
  exit 1
}

$startInfo = @{ FilePath = $Path }
if ($Arguments.Count -gt 0) { $startInfo.ArgumentList = $Arguments }
if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }

$proc = Start-Process @startInfo -PassThru
if (-not $proc) {
  Write-Output 'FAIL Start-Process returned nothing'
  exit 1
}

# 只等一小会儿确认它没有立刻崩掉，不等它退出。
Start-Sleep -Milliseconds 800
$alive = -not $proc.HasExited
Write-Output ("STARTED pid=" + $proc.Id + " alive=" + $alive)
exit 0
