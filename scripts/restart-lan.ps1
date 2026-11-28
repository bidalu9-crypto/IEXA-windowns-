# Restart iExA, then prove the PIN pairing path works end to end.
# Delay keeps the current chat turn alive long enough to answer.
param([int]$Delay = 30)

$ErrorActionPreference = 'Continue'
$AppDir = 'D:\IEXA-windowns--main'
$Node   = 'C:\Users\Maizi\AppData\Local\iExA\runtime\node\node.exe'
$Tmp    = Join-Path $AppDir 'workspace\.tmp'
$Log    = Join-Path $Tmp 'lan-verify.log'
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Set-Content -Path $Log -Value '' -Encoding UTF8

function Write-Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

# Self-signed certificate on loopback: trust it for this process only.
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
Write-Log '--- restart requested ---'

# 1. Stop the running server (only the iExA dist entrypoint)
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dist\\main\\server\.js' }
foreach ($p in $targets) {
  Write-Log ("stop pid {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2. Wait for 443 to be released
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 300
  if (-not (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue)) { break }
}
Write-Log 'ports released'

# 3. Relaunch via start.bat in its own console
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$AppDir\start.bat`"" -WorkingDirectory $AppDir
Write-Log 'launcher spawned'

# 4. Wait for 443
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
}
if (-not $ready) { Write-Log 'FAIL 443 never came up'; exit 1 }
Write-Log '443 listening'

# 5. Verify the new routes exist
try {
  $pin = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pin' -Method POST -TimeoutSec 10
  Write-Log ("generate pin => code={0} ttl={1}ms" -f $pin.code, $pin.ttlMs)
} catch {
  Write-Log ("FAIL generate pin: " + $_.Exception.Message)
  exit 1
}

try {
  $state = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pin' -Method GET -TimeoutSec 10
  Write-Log ("pin state => active={0}" -f $state.active)
} catch { Write-Log ("FAIL pin state: " + $_.Exception.Message) }

# 6. Wrong code must be rejected
try {
  $bad = Invoke-WebRequest -Uri 'https://192.168.1.5/api/mobile-bridge/pair-pin' -Method POST -TimeoutSec 10 `
    -Body (@{ code = 'zzzz'; name = 'BadTest' } | ConvertTo-Json -Compress) -ContentType 'application/json' -UseBasicParsing
  Write-Log ("WRONG-CODE unexpectedly HTTP " + $bad.StatusCode)
} catch {
  $code = 0
  try { $code = [int]$_.Exception.Response.StatusCode } catch {}
  Write-Log ("wrong code rejected => HTTP $code (good)")
}

# 7. Correct code pairs the device
try {
  $ok = Invoke-WebRequest -Uri 'https://192.168.1.5/api/mobile-bridge/pair-pin' -Method POST -TimeoutSec 10 `
    -Body (@{ code = $pin.code; name = 'PinE2E' } | ConvertTo-Json -Compress) -ContentType 'application/json' `
    -UseBasicParsing -SessionVariable sess
  Write-Log ("correct pin => HTTP " + $ok.StatusCode)
  $cookie = ([string]$ok.Headers['Set-Cookie']) -replace 'iexa_mobile_session=[^;]+', 'iexa_mobile_session=***'
  Write-Log ("set-cookie => " + $cookie)
} catch { Write-Log ("FAIL correct pin: " + $_.Exception.Message) }

# 8. Session must now authenticate and reach /api/pet
try {
  $cs = (Invoke-WebRequest -Uri 'https://192.168.1.5/api/mobile-bridge/client-status' -UseBasicParsing -WebSession $sess -TimeoutSec 10).Content
  Write-Log ("client-status => " + $cs)
} catch { Write-Log ("FAIL client-status: " + $_.Exception.Message) }

try {
  $pet = Invoke-WebRequest -Uri 'https://192.168.1.5/api/pet' -UseBasicParsing -WebSession $sess -TimeoutSec 10
  Write-Log ("pet => HTTP " + $pet.StatusCode)
} catch { Write-Log ("FAIL pet: " + $_.Exception.Message) }

# 9. Single use: the same code must fail the second time
$pin2 = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pin' -Method POST -TimeoutSec 10
try {
  $ignored = Invoke-WebRequest -Uri 'https://192.168.1.5/api/mobile-bridge/pair-pin' -Method POST -TimeoutSec 10 `
    -Body (@{ code = $pin.code; name = 'ReuseTest' } | ConvertTo-Json -Compress) -ContentType 'application/json' -UseBasicParsing
  Write-Log ("REUSE unexpectedly HTTP " + $ignored.StatusCode)
} catch {
  $rc = 0
  try { $rc = [int]$_.Exception.Response.StatusCode } catch {}
  Write-Log ("reuse rejected => HTTP $rc (good)")
}
Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pin' -Method DELETE -TimeoutSec 10 | Out-Null

# 10. Remove the test device, keep the real iPhone
try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/status' -TimeoutSec 10
  foreach ($d in $st.devices) {
    if ($d.name -in @('PinE2E', 'BadTest', 'ReuseTest')) {
      Invoke-WebRequest -Uri ("http://127.0.0.1:19840/api/mobile-bridge/devices/" + $d.id) -Method DELETE -UseBasicParsing -TimeoutSec 10 | Out-Null
      Write-Log ("removed test device " + $d.name)
    }
  }
  $after = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/status' -TimeoutSec 10
  Write-Log ("remaining devices => " + (($after.devices | ForEach-Object { $_.name }) -join ', '))
} catch { Write-Log ("FAIL cleanup: " + $_.Exception.Message) }

# 11. Both entrypoints still answer
$v6 = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceAlias -eq 'LAN' -and $_.AddressState -eq 'Preferred' -and $_.PrefixLength -eq 64 -and $_.IPAddress -notlike 'fe80*' } |
  Select-Object -First 1 -ExpandProperty IPAddress
$entrypoints = @('https://192.168.1.5/')
if ($v6) { $entrypoints += "https://[$v6]/" } else { Write-Log 'no preferred IPv6 /64 found' }
foreach ($url in $entrypoints) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
    Write-Log ("$url => HTTP " + $r.StatusCode)
  } catch { Write-Log ("$url => FAIL " + $_.Exception.Message) }
}

# 12. A paired phone must be able to open the bridge panel (used to be 403)
try {
  $pin2 = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pin' -Method POST -TimeoutSec 10
  $pair = Invoke-WebRequest -Uri 'https://192.168.1.5/api/mobile-bridge/pair-pin' -Method POST -TimeoutSec 10 `
    -Body (@{ code = $pin2.code; name = 'NavE2E' } | ConvertTo-Json -Compress) -ContentType 'application/json' `
    -UseBasicParsing -SessionVariable nav
  Write-Log ("pair-pin for nav test => HTTP " + $pair.StatusCode)
  $navStatus = Invoke-WebRequest -Uri 'https://192.168.1.5/api/mobile-bridge/status' -UseBasicParsing -WebSession $nav -TimeoutSec 10
  Write-Log ("phone reads bridge status => HTTP " + $navStatus.StatusCode)
  $st2 = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/status' -TimeoutSec 10
  foreach ($d in $st2.devices) {
    if ($d.name -eq 'NavE2E') {
      Invoke-WebRequest -Uri ("http://127.0.0.1:19840/api/mobile-bridge/devices/" + $d.id) -Method DELETE -UseBasicParsing -TimeoutSec 10 | Out-Null
      Write-Log 'removed nav test device'
    }
  }
} catch {
  $code = 0
  try { $code = [int]$_.Exception.Response.StatusCode } catch {}
  Write-Log ("FAIL phone bridge panel => HTTP $code " + $_.Exception.Message)
}

Write-Log '--- verification done ---'
