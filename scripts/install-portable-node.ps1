param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$runtimeRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$nodeDir = Join-Path $runtimeRoot 'node'
$downloadDir = Join-Path $runtimeRoot 'downloads'
$extractDir = Join-Path $runtimeRoot 'node-extract'
$nodeExe = Join-Path $nodeDir 'node.exe'

function Assert-InRuntime([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $runtimeRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the IEXA runtime directory: $resolved"
    }
}

function Test-UsableNode([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $major = & $Executable -p "Number(process.versions.node.split('.')[0])" 2>$null
        return [int]$major -ge 20
    } catch { return $false }
}

if (Test-UsableNode $nodeExe) {
    Write-Host "[OK] Portable Node.js is already installed at $nodeDir"
    exit 0
}

New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
$sources = @(
    'https://nodejs.org/dist/latest-v22.x',
    'https://npmmirror.com/mirrors/node/latest-v22.x'
)
$installed = $false
$lastError = $null

foreach ($source in $sources) {
    try {
        Write-Host "[Setup] Reading the latest Node.js 22 LTS release from $source ..."
        $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$source/SHASUMS256.txt" -TimeoutSec 30).Content
        $match = [regex]::Match($checksums, '(?m)^([a-fA-F0-9]{64})\s+(node-v22\.\d+\.\d+-win-x64\.zip)\s*$')
        if (-not $match.Success) { throw 'The release checksum list did not contain a Windows x64 archive.' }

        $expectedHash = $match.Groups[1].Value.ToUpperInvariant()
        $archiveName = $match.Groups[2].Value
        $archivePath = Join-Path $downloadDir $archiveName
        Assert-InRuntime $archivePath

        $downloadRequired = $true
        if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
            $downloadRequired = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash
        }
        if ($downloadRequired) {
            Write-Host "[Setup] Downloading $archiveName (one-time download, about 30 MB) ..."
            Invoke-WebRequest -UseBasicParsing -Uri "$source/$archiveName" -OutFile $archivePath -TimeoutSec 300
        }

        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedHash) {
            Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
            throw "SHA-256 verification failed for $archiveName."
        }

        Assert-InRuntime $extractDir
        Assert-InRuntime $nodeDir
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        Write-Host '[Setup] Extracting the portable Node.js runtime ...'
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force

        $payload = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
        if (-not $payload -or -not (Test-Path -LiteralPath (Join-Path $payload.FullName 'node.exe'))) {
            throw 'The downloaded Node.js archive has an unexpected layout.'
        }
        Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $payload.FullName -Destination $nodeDir
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue

        if (-not (Test-UsableNode $nodeExe) -or -not (Test-Path -LiteralPath (Join-Path $nodeDir 'npm.cmd'))) {
            throw 'Node.js extraction completed, but node.exe or npm.cmd is not usable.'
        }
        $version = & $nodeExe -p "process.versions.node"
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Portable Node.js $version installed in $nodeDir"
        $installed = $true
        break
    } catch {
        $lastError = $_.Exception.Message
        Write-Host "[Warn] Node.js source failed: $lastError" -ForegroundColor Yellow
    }
}

if (-not $installed) {
    Write-Host '[ERROR] Automatic Node.js installation failed on every download source.' -ForegroundColor Red
    Write-Host "        Last error: $lastError" -ForegroundColor Red
    Write-Host '        Check this computer''s network, proxy, TLS, or security software and run the BAT again.' -ForegroundColor Red
    exit 41
}

exit 0
