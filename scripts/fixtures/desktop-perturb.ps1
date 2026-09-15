param(
 [Parameter(Mandatory=$true)][ValidateSet('foreground','move')][string]$Action,
 [Parameter(Mandatory=$true)][long]$Handle,
 [Parameter(Mandatory=$true)][int]$ExpectedPid,
 [int]$X=120, [int]$Y=120, [int]$Width=800, [int]$Height=600
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IexaBenchmarkWindows {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$hwnd=[IntPtr]$Handle
[uint32]$targetPid=0
$targetThread=[IexaBenchmarkWindows]::GetWindowThreadProcessId($hwnd,[ref]$targetPid)
if($targetPid -ne $ExpectedPid){throw 'Benchmark target PID mismatch; no window mutation performed.'}
$before=[IexaBenchmarkWindows]::GetForegroundWindow().ToInt64()
if($Action -eq 'move'){
 $ok=[IexaBenchmarkWindows]::SetWindowPos($hwnd,[IntPtr]::Zero,$X,$Y,$Width,$Height,0x14)
 if(-not $ok){throw 'SetWindowPos failed'}
}else{
 [uint32]$foregroundPid=0
 $foregroundThread=[IexaBenchmarkWindows]::GetWindowThreadProcessId([IntPtr]$before,[ref]$foregroundPid)
 $currentThread=[IexaBenchmarkWindows]::GetCurrentThreadId()
 $attached=[IexaBenchmarkWindows]::AttachThreadInput($currentThread,$foregroundThread,$true)
 try {
  [void][IexaBenchmarkWindows]::ShowWindow($hwnd,9)
  [void][IexaBenchmarkWindows]::BringWindowToTop($hwnd)
  [void][IexaBenchmarkWindows]::SetForegroundWindow($hwnd)
 }finally{if($attached){[void][IexaBenchmarkWindows]::AttachThreadInput($currentThread,$foregroundThread,$false)}}
 Start-Sleep -Milliseconds 100
}
$after=[IexaBenchmarkWindows]::GetForegroundWindow().ToInt64()
if($Action -eq 'foreground' -and $after -ne $Handle){throw "Focus precondition failed: expected=$Handle actual=$after"}
@{before=$before;after=$after;target=$Handle;pid=$targetPid;action=$Action;verified=$true} | ConvertTo-Json -Compress
