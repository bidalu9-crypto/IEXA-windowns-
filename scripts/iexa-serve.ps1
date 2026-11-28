<#
  iExA HTTP server - logon launcher.

  Invoked by the "iExA HTTP Server" scheduled task as
    powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File ...
  so no console window ever appears. This script then stays in the foreground
  of that hidden console until the server exits, which is what lets the task's
  restart-on-failure policy bring the server back after a crash.

  It deliberately does NOT run the TypeScript build. dist\main\server.js is the
  shipped artifact; compiling at logon would add tens of seconds and a silent
  failure path that leaves the machine with no service at all.

  This file is pure ASCII on purpose: Windows PowerShell 5.1 reads .ps1 bytes in
  the ANSI code page when there is no BOM, so non-ASCII comments can break it.
#>
[CmdletBinding()]
param(
    [int]$Port = 19840
)

$ErrorActionPreference = 'Stop'

$appRoot  = Split-Path -Parent $PSScriptRoot
$serverJs = Join-Path $appRoot 'dist\main\server.js'
$logDir   = Join-Path $appRoot 'workspace\.tmp'
$runLog = Join-Path $logDir 'iexa-server.log'   # stdout of this run
$errLog = Join-Path $logDir 'iexa-server.err.log' # stderr of this run
$bootLog  = Join-Path $logDir 'iexa-boot.log'     # launcher decisions (appended)

function Write-Boot {
    param([string]$Text)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    try {
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        Add-Content -LiteralPath $bootLog -Value $line -Encoding UTF8
    } catch { }
}

function Test-PortOpen {
    param([int]$LocalPort)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $LocalPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# ---------------------------------------------------------------- preflight
if (-not (Test-Path -LiteralPath $serverJs)) {
    Write-Boot "FATAL missing $serverJs - nothing to start."
    exit 1
}

$nodeExe = Join-Path $env:LOCALAPPDATA 'IEXA\runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($found) { $nodeExe = $found.Source }
}
if (-not $nodeExe) {
    Write-Boot 'FATAL no node.exe (IEXA runtime and PATH both empty).'
    exit 1
}

# Another copy already answers on the port: leave it alone. A second instance
# would only fight over the mobile bridge on 443.
if (Test-PortOpen $Port) {
    Write-Boot "Port $Port already serving - skip, not starting a second copy."
    exit 0
}

# Low ports are the usual reason a silent start dies before it can log a line,
# so record what we are about to fight over.
foreach ($p in 19840, 443, 80) {
    $busy = (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) -ne $null
    Write-Boot ("port {0}: {1}" -f $p, $(if ($busy) { 'in use' } else { 'free' }))
}

# ------------------------------------------------------------ log rotation
# iexa-server.log is truncated on every start, so only the appended boot log
# needs a size cap.
try {
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    if ((Test-Path -LiteralPath $bootLog) -and ((Get-Item -LiteralPath $bootLog).Length -gt 2MB)) {
        Move-Item -LiteralPath $bootLog -Destination "$bootLog.1" -Force
    }
} catch { }

$nodeVersion = ((& $nodeExe -v 2>$null) | Out-String).Trim()
if (-not $nodeVersion) { $nodeVersion = 'unknown' }
Write-Boot "starting server: node $nodeVersion, app $appRoot, launcher pid $PID"

# start.bat pins the mobile bridge to 443; match it so the paired phone URL
# survives a restart.
$env:IEXA_MOBILE_PORT = '443'
Set-Location -LiteralPath $appRoot

# Start-Process rather than cmd /c "... >> log": routing the redirection through
# cmd means PowerShell re-quotes the whole line, and cmd then sees "/c" as the
# program name ("'/c' is not recognized"), which kills the server before it can
# log a single line. Start-Process hands the handles over directly.
# -Wait keeps this hidden launcher alive for exactly as long as the server runs,
# so Task Scheduler sees the exit code and can restart it. Logs are truncated per
# run on purpose; history lives in iexa-boot.log.
try {
    $proc = Start-Process -FilePath $nodeExe `
        -ArgumentList ('"{0}"' -f $serverJs) `
        -WorkingDirectory $appRoot `
        -RedirectStandardOutput $runLog `
        -RedirectStandardError $errLog `
        -WindowStyle Hidden `
        -PassThru -Wait
    $exitCode = $proc.ExitCode
} catch {
    Write-Boot "FATAL failed to start node: $($_.Exception.Message)"
    exit 1
}

Write-Boot "server exited with code $exitCode"
exit $exitCode
