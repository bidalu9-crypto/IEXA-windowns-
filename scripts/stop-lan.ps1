# Stop only the iExA desktop server (dist\main\server.js), so a fresh
# start.bat can rebind port 443 without touching any other HTTPS service.
$ErrorActionPreference = 'SilentlyContinue'
$stopped = $false

$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dist\\main\\server\.js' }

foreach ($p in $targets) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host ("[stop] pid {0}" -f $p.ProcessId)
  $stopped = $true
}

if ($stopped) {
  # Wait until 443 is actually released (max ~6s)
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 300
    if (-not (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue)) { break }
  }
  Write-Host '[stop] 443 released'
} else {
  Write-Host '[stop] no running iExA server'
}
