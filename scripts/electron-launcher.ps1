#Requires -Version 5.1
<#
.SYNOPSIS
    Launch Electron, hide this console once the app window exists, and exit with it.

.DESCRIPTION
    start-electron.bat is a console script: the user sees a cmd window for the whole
    build and, when the batch is started from an existing shell, that shell keeps the
    window open afterwards. This launcher owns the tail of the flow instead:

      1. start Electron and wait until it actually owns a window (not just a PID),
      2. hide the console so the user only sees IEXA,
      3. stay alive as a supervisor and exit when Electron exits, so a console we own
         disappears with the app instead of lingering.

    When the batch was started from a terminal the user already had open, that window
    is not ours to destroy: it is restored on exit so the shell is left as we found it.

    -SkipHide is for automated checks: it runs the same start/wait/exit path without
    touching window visibility.

.PARAMETER ElectronExe
    Absolute path to electron.exe.

.PARAMETER AppDir
    Application directory passed to Electron as its first argument.

.PARAMETER SkipHide
    Do not hide or restore the console. Used by tests.

.PARAMETER WindowTimeoutSeconds
    How long to wait for the app window before giving up.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\electron-launcher.ps1 `
        -ElectronExe "C:\app\node_modules\electron\dist\electron.exe" -AppDir "C:\app"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ElectronExe,
    [Parameter(Mandatory = $true)][string]$AppDir,
    [switch]$SkipHide,
    [int]$WindowTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ElectronExe)) {
    Write-Host "[ERROR] Electron runtime not found: $ElectronExe"
    exit 1
}

Add-Type -Namespace IexaLauncher -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@

$console = [IexaLauncher.Native]::GetConsoleWindow()

# Walk up the process chain: a console started by Explorer (double-click, shortcut,
# UAC elevation) belongs to this script; one started from cmd/pwsh/Windows Terminal
# belongs to the user and must be restored rather than destroyed.
function Test-OwnedConsole {
    try {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
        for ($depth = 0; $depth -lt 5 -and $current; $depth++) {
            $parentId = [int]$current.ParentProcessId
            if ($parentId -le 0) { break }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction Stop
            if (-not $parent) { break }
            if ($parent.Name -ieq 'explorer.exe') { return $true }
            if ($parent.Name -match '^(cmd|powershell|pwsh|WindowsTerminal|conhost)\.exe$') { return $false }
            $current = $parent
        }
    } catch { }
    # Unknown ancestry: never assume the console is ours to hide.
    return $false
}

$owned = -not $SkipHide -and (Test-OwnedConsole)

function Hide-Console {
    # A borrowed terminal is not ours to hide, even temporarily: the user may have
    # other work in it. Only a console this script owns may disappear.
    if ($SkipHide -or -not $owned -or $console -eq [IntPtr]::Zero) { return }
    [void][IexaLauncher.Native]::ShowWindow($console, 0)  # SW_HIDE
}

function Restore-Console {
    if ($SkipHide -or $console -eq [IntPtr]::Zero) { return }
    if (-not [IexaLauncher.Native]::IsWindowVisible($console)) {
        [void][IexaLauncher.Native]::ShowWindow($console, 5)  # SW_SHOW
    }
}

$process = $null
try {
    $process = Start-Process -FilePath $ElectronExe -ArgumentList @("`"$AppDir`"") -WorkingDirectory $AppDir -PassThru
} catch {
    Write-Host "[ERROR] Could not start Electron: $($_.Exception.Message)"
    exit 1
}

# Hide only once there is something to look at. Hiding on launch would leave the user
# staring at nothing if the app crashed before drawing its window.
$deadline = (Get-Date).AddSeconds([Math]::Max(5, $WindowTimeoutSeconds))
$windowSeen = $false
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { break }
    $process.Refresh()
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windowSeen = $true; break }
    Start-Sleep -Milliseconds 250
}

if (-not $windowSeen) {
    Restore-Console    if ($process.HasExited) {
        Write-Host "[ERROR] IEXA exited before showing a window (code $($process.ExitCode))."
    } else {
        Write-Host "[ERROR] IEXA did not show a window within $WindowTimeoutSeconds seconds."
        try { $process.Kill() } catch { }
    }
    exit 1
}

Hide-Console

# Supervise: the console lives exactly as long as the app it launched.
$process.WaitForExit()
$exitCode = $process.ExitCode

# Only a console we hid needs restoring; a borrowed terminal was never touched.
Restore-Console

exit $exitCode
