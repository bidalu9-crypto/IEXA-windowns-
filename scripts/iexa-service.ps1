<#
  iExA HTTP server - autostart manager.

  Replaces the old HKCU\...\Run entry that pointed at a VBS wrapper. A scheduled
  task is used instead because it gives us the three things the Run key cannot:
    * restart-on-failure, so a crashed server comes back on its own,
    * "do not stop on battery", which matters on a laptop,
    * a start delay long enough for the network to come up before we bind 443.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\iexa-service.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File scripts\iexa-service.ps1 -Action install
    powershell -ExecutionPolicy Bypass -File scripts\iexa-service.ps1 -Action uninstall

  install / uninstall / start / stop touch the machine; status / verify are
  read-only. Nothing here needs an elevated shell.

  Pure ASCII on purpose - see the note in iexa-serve.ps1.
#>
[CmdletBinding()]
param(
    [ValidateSet('status', 'verify', 'install', 'uninstall', 'start', 'stop', 'restart')]
    [string]$Action = 'status',
    [int]$Port = 19840
)

$ErrorActionPreference = 'Stop'

$TaskName      = 'iExA HTTP Server'
$appRoot       = Split-Path -Parent $PSScriptRoot
$serveScript   = Join-Path $PSScriptRoot 'iexa-serve.ps1'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runKey        = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName  = 'iExA'
$bootLog       = Join-Path $appRoot 'workspace\.tmp\iexa-boot.log'

function Get-PortOwner {
    param([int]$LocalPort)
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    return (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue)
}

function Test-HttpAlive {
    param([int]$LocalPort)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/" -UseBasicParsing -TimeoutSec 6
        return "HTTP $($r.StatusCode), $($r.Content.Length) bytes"
    } catch {
        return "no answer: $($_.Exception.Message)"
    }
}

function Show-Status {
    Write-Output "app root : $appRoot"
    Write-Output "script   : $(if (Test-Path $serveScript) { 'ok' } else { 'MISSING' })"

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Output "task     : registered, state = $($task.State)"
        Write-Output "           last run  = $($info.LastRunTime)"
        Write-Output "           last rc   = $($info.LastTaskResult)"
        Write-Output "           next run  = $($info.NextRunTime)"
    } else {
        Write-Output 'task     : NOT REGISTERED'
    }

    $legacy = (Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue).$runValueName
    Write-Output "HKCU Run : $(if ($legacy) { "STILL PRESENT -> $legacy" } else { 'clean (no VBS entry)' })"

    $owner = Get-PortOwner $Port
    if ($owner) {
        Write-Output "port $Port : listening, pid $($owner.Id) ($($owner.ProcessName))"
        Write-Output "            $($owner.Path)"
        Write-Output "http     : $(Test-HttpAlive $Port)"
    } else {
        Write-Output "port $Port : NOT LISTENING"
    }

    if (Test-Path $bootLog) {
        Write-Output '--- last 8 launcher lines ---'
        Get-Content -LiteralPath $bootLog -Tail 8 | ForEach-Object { Write-Output "  $_" }
    }
}

switch ($Action) {

    'status' { Show-Status }

    'verify' {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $owner = Get-PortOwner $Port
        $ok = ($null -ne $task) -and ($null -ne $owner)
        Write-Output "task registered : $(if ($task) { 'yes' } else { 'no' })"
        Write-Output "server serving  : $(if ($owner) { "yes (pid $($owner.Id))" } else { 'no' })"
        if ($ok) { Write-Output "result          : OK - http://127.0.0.1:$Port/" }
        else { Write-Output 'result          : NOT READY' }
        if (-not $ok) { exit 1 }
    }

    'install' {
        if (-not (Test-Path -LiteralPath $serveScript)) {
            throw "missing $serveScript"
        }
        if (-not (Test-Path -LiteralPath $powerShellExe)) {
            throw "missing $powerShellExe"
        }

        # A leftover Run entry would start the VBS alongside the task. Two node
        # processes then race for 443 and one of them dies quietly - which is
        # exactly the "a window opened but nothing serves" symptom.
        if ((Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue).$runValueName) {
            Remove-ItemProperty -Path $runKey -Name $runValueName -Force
            Write-Output "removed legacy HKCU Run entry '$runValueName'"
        }

        $argument = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $serveScript

        $taskAction = New-ScheduledTaskAction `
            -Execute $powerShellExe `
            -Argument $argument `
            -WorkingDirectory $appRoot

        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        # Bind 443 needs the network stack awake; 20s is cheap insurance at logon.
        $trigger.Delay = 'PT20S'

        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -Hidden

        # RunLevel Highest would be rejected here: registering an elevated task
        # needs an elevated shell, and this account already binds 443 unraised
        # (start.bat has been doing it that way all along).
        $principal = New-ScheduledTaskPrincipal `
            -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -LogonType Interactive `
            -RunLevel Limited

        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $taskAction `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal `
            -Description 'Starts the iExA HTTP server (node dist\main\server.js) at logon, hidden, and restarts it if it dies.' `
            -Force | Out-Null

        Write-Output "registered scheduled task '$TaskName'"
        Write-Output 'trigger  : at logon of this user, 20s delay'
        Write-Output 'policy   : hidden, no window, restart every 1 min on failure, runs on battery'
        Show-Status
    }

    'uninstall' {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Output "unregistered '$TaskName'"
        } else {
            Write-Output "task '$TaskName' was not registered"
        }
        if ((Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue).$runValueName) {
            Remove-ItemProperty -Path $runKey -Name $runValueName -Force
            Write-Output "removed legacy HKCU Run entry '$runValueName'"
        }
        Write-Output 'note: a running server was left alone; stop it with -Action stop'
    }

    'start' {
        if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
            throw "task '$TaskName' is not registered - run -Action install first"
        }
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "started '$TaskName', waiting for the port..."
        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 750
            if (Get-PortOwner $Port) { break }
        }
        Show-Status
    }

    'stop' {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        }
        # The task kill only reaches the powershell launcher; the node child is
        # what actually holds the port, so kill that by pid.
        $owner = Get-PortOwner $Port
        if ($owner) {
            Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
            Write-Output "stopped pid $($owner.Id) and released port $Port"
        } else {
            Write-Output "nothing listening on $Port"
        }
    }

    'restart' {
        & $PSCommandPath -Action stop -Port $Port
        Start-Sleep -Seconds 1
        & $PSCommandPath -Action start -Port $Port
    }
}
