# Restart iExA, then prove the leaf/CA split verifies against the installed CA.
# Delay lets the current chat turn flush before the server goes down.
param([int]$Delay = 30)

$ErrorActionPreference = 'Continue'
$AppDir = 'D:\IEXA-windowns--main'
$Node   = 'C:\Users\Maizi\AppData\Local\iExA\runtime\node\node.exe'
$Tmp    = Join-Path $AppDir 'workspace\.tmp'
$Log    = Join-Path $Tmp 'cert-chain-verify.log'
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Set-Content -Path $Log -Value '' -Encoding UTF8

function Write-Log([string]$m) {
  Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8
}

if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
Write-Log '--- restart requested ---'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dist\\main\\server\.js' } |
  ForEach-Object {
    Write-Log ("stop pid " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 300
  if (-not (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue)) { break }
}
Write-Log 'ports released'

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$AppDir\start.bat`"" -WorkingDirectory $AppDir
Write-Log 'launcher spawned'

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
}
if (-not $ready) { Write-Log 'FAIL 443 never came up'; exit 1 }
Write-Log '443 listening'

# --- Chain check: does the served leaf verify against the downloadable CA? ---
$probe = Join-Path $Tmp 'chain-check.js'
$js = @'
const tls = require('tls'), fs = require('fs');
const { X509Certificate } = require('crypto');
const ws = 'D:/IEXA-windowns--main/workspace';
const caPem = fs.readFileSync(ws + '/iexa-bridge-certificate.crt', 'utf8');
const anchors = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
console.log('download file blocks : ' + anchors.length);
const ca = new X509Certificate(anchors[0]);
console.log('download subject    : ' + ca.subject.replace(/\n/g, ' '));
console.log('download ca flag    : ' + ca.ca);
console.log('download validTo    : ' + ca.validTo);

const sock = tls.connect({ host: '127.0.0.1', port: 443, servername: 'localhost', ca: caPem, rejectUnauthorized: true }, () => {
  const peer = sock.getPeerCertificate(true);
  console.log('handshake           : AUTHORIZED');
  console.log('leaf subject        : ' + JSON.stringify(peer.subject));
  console.log('leaf issuer         : ' + JSON.stringify(peer.issuer));
  console.log('leaf ca flag        : ' + peer.ca);
  console.log('leaf validTo        : ' + peer.valid_to);
  const names = (peer.subjectaltname || '').split(/,\s*/).filter(Boolean);
  console.log('leaf SAN count      : ' + names.length);
  for (const n of names) console.log('   ' + n);
  const iss = peer.issuerCertificate;
  const chained = Boolean(iss && iss.fingerprint && iss.fingerprint !== peer.fingerprint);
  console.log('chain carries issuer: ' + chained);
  sock.end();
});
sock.on('error', (e) => console.log('handshake           : FAIL ' + e.code + ' / ' + e.message));
sock.setTimeout(10000, () => { console.log('handshake           : timeout'); sock.destroy(); });
'@
Set-Content -Path $probe -Value $js -Encoding UTF8
& $Node $probe 2>&1 | ForEach-Object { Write-Log $_ }
Remove-Item $probe -Force -ErrorAction SilentlyContinue

# --- Reachability of every stable address on the LAN interface ---
$v6 = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceAlias -eq 'LAN' -and $_.IPAddress -notlike 'fe80*' -and $_.PrefixLength -eq 64 } |
  Select-Object -ExpandProperty IPAddress
foreach ($ip in $v6) {
  $state = (Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue).AddressState
  $code = & curl.exe -k -s -m 10 -o NUL -w "%{http_code}" "https://[$ip]/"
  Write-Log ("https://[$ip]/ => HTTP $code  [$state]")
}

$v4 = & curl.exe -k -s -m 8 -o NUL -w "%{http_code}" "https://192.168.1.5/"
Write-Log ("https://192.168.1.5/ => HTTP $v4")

# --- What address does a new pairing code choose? ---
try {
  $pin = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/pair-token' -Method POST -Body '{}' -ContentType 'application/json' -TimeoutSec 10
  Write-Log ("pairing URL: " + $pin.url)
} catch { Write-Log ("FAIL pair token: " + $_.Exception.Message) }

try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:19840/api/mobile-bridge/status' -TimeoutSec 10
  Write-Log ("bridge addresses: " + ($st.addresses -join ', '))
  Write-Log ("bridge devices  : " + (($st.devices | ForEach-Object { $_.name }) -join ', '))
} catch { Write-Log ("FAIL status: " + $_.Exception.Message) }

Write-Log '--- done ---'
