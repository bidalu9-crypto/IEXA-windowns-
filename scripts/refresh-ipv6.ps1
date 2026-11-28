# Re-issue the bridge certificate for whatever IPv6 prefix the router is
# currently advertising, then report the URLs the phone should use.
param([int]$Delay = 25)

$ErrorActionPreference = 'Continue'
$AppDir = 'D:\IEXA-windowns--main'
$Tmp    = Join-Path $AppDir 'workspace\.tmp'
$Log    = Join-Path $Tmp 'lan-ipv6-refresh.log'
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Set-Content -Path $Log -Value '' -Encoding UTF8
function Write-Log([string]$m) {
  Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8
}

[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
Write-Log '--- refresh requested ---'

# 1. Stop the running iExA server
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dist\\main\\server\.js' } |
  ForEach-Object { Write-Log ("stop pid " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 300
  if (-not (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue)) { break }
}
Write-Log 'ports released'

# 2. Relaunch
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$AppDir\start.bat`"" -WorkingDirectory $AppDir
Write-Log 'launcher spawned'

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
}
if (-not $ready) { Write-Log 'FAIL 443 never came up'; exit 1 }
Write-Log '443 listening'

# 3. Report what the certificate actually covers
$crt = Join-Path $AppDir 'workspace\iexa-bridge-certificate.crt'
if (Test-Path $crt) {
  $san = & 'C:\Users\Maizi\AppData\Local\iExA\runtime\node\node.exe' -e "const {X509Certificate}=require('crypto');const x=new X509Certificate(require('fs').readFileSync(process.argv[1],'utf8'));console.log(x.subjectAltName)" $crt
  Write-Log ("cert SAN: " + $san)
} else {
  Write-Log 'FAIL certificate not written'
}

# 4. Bridge status: the live address list the pairing panel shows
try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/status' -TimeoutSec 10
  Write-Log ("bridge addresses: " + ($st.addresses -join ', '))
  Write-Log ("bridge port: " + $st.port + "  enabled: " + $st.enabled)
} catch { Write-Log ("FAIL status: " + $_.Exception.Message) }

# 5. Probe every current global IPv6 literal
$v6 = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.InterfaceAlias -eq 'LAN' -and
    $_.IPAddress -notlike 'fe80*' -and
    $_.PrefixLength -eq 64
  } | Select-Object -ExpandProperty IPAddress

foreach ($ip in $v6) {
  $state = (Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue).AddressState
  $out = & curl.exe -k -s -m 10 -o NUL -w "%{http_code}" "https://[$ip]/"
  Write-Log ("https://[$ip]/ => HTTP $out  (nic state: $state)")
}

# 6. IPv4 stays intact
$v4 = & curl.exe -k -s -m 8 -o NUL -w "%{http_code}" "https://192.168.1.5/"
Write-Log ("https://192.168.1.5/ => HTTP $v4")

# 7. Pairing code points somewhere usable
try {
  $pin = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pair-token' -Method POST -Body '{}' -ContentType 'application/json' -TimeoutSec 10
  Write-Log ("default pairing URL: " + $pin.url)
} catch { Write-Log ("FAIL pair token: " + $_.Exception.Message) }

Write-Log '--- done ---'
