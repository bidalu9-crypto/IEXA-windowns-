# =============================================================================
# IEXA PC - Installer Generator v4
# Compiles small C# EXE, then appends ZIP + offset marker at the end
# The EXE reads its own tail to extract the embedded data
# =============================================================================

param(
    [string]$SourceDir = "",
    [string]$OutputExe = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $SourceDir) { $SourceDir = Join-Path $scriptDir "release\IEXA" }
if (-not $OutputExe) { $OutputExe = Join-Path $scriptDir "release\IEXA-Setup.exe" }

Write-Host "=== IEXA Setup Builder ===" -ForegroundColor Cyan

if (-not (Test-Path $SourceDir)) {
    Write-Host "ERROR: $SourceDir not found. Run 'node build-dist.js' first." -ForegroundColor Red
    exit 1
}

# ---- Step 1: Create ZIP ----
Write-Host "[1/4] Compressing distribution..."
$zipPath = Join-Path $env:TEMP "IEXA-package.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zipSize = (Get-Item $zipPath).Length
Write-Host "  Compressed: $([math]::Round($zipSize/1MB, 1)) MB"

# ---- Step 2: Compile small C# stub ----
Write-Host "[2/4] Compiling installer stub..."

$csCode = @'
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;

class IEXASetup
{
    static string InstallDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IEXA"); }
    }
    static string DesktopDir
    {
        get { return Environment.GetFolderPath(Environment.SpecialFolder.Desktop); }
    }
    static string StartMenuDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "IEXA"); }
    }
    static string IconPath
    {
        get { return Path.Combine(InstallDir, "resources", "app", "resources", "icon.ico"); }
    }

	    static void Main()
	    {
	        try
	        {
	            string exePath = Assembly.GetExecutingAssembly().Location;
	            byte[] allBytes = File.ReadAllBytes(exePath);
	            long zipSize = BitConverter.ToInt64(allBytes, allBytes.Length - 8);
	            long zipOffset = allBytes.Length - 8 - zipSize;

	            string zipFile = Path.Combine(Path.GetTempPath(), "IEXA.zip");
	            using (var fs = new FileStream(zipFile, FileMode.Create))
	            {
	                fs.Write(allBytes, (int)zipOffset, (int)zipSize);
	            }

	            foreach (var p in System.Diagnostics.Process.GetProcessesByName("IEXA"))
	            {
	                try { p.Kill(); } catch { }
	            }

	            if (Directory.Exists(InstallDir)) Directory.Delete(InstallDir, true);
	            ZipFile.ExtractToDirectory(zipFile, InstallDir);
	            File.Delete(zipFile);

	            CreateShortcut(Path.Combine(DesktopDir, "IEXA.lnk"),
	                Path.Combine(InstallDir, "IEXA.exe"), InstallDir,
	                "IEXA - Your private AI agent", IconPath);
	            // Fallback .url file
	            string urlPath = Path.Combine(DesktopDir, "IEXA.url");
	            File.WriteAllText(urlPath, "[InternetShortcut]\nURL=file:///" +
	                Path.Combine(InstallDir, "IEXA.exe").Replace("\\", "/") +
	                "\nIconFile=" + IconPath.Replace("\\", "/") + "\nIconIndex=0");

	            Directory.CreateDirectory(StartMenuDir);
	            CreateShortcut(Path.Combine(StartMenuDir, "IEXA.lnk"),
	                Path.Combine(InstallDir, "IEXA.exe"), InstallDir,
	                "IEXA - Your private AI agent", IconPath);

	            System.Diagnostics.Process.Start(Path.Combine(InstallDir, "IEXA.exe"));
	        }
	        catch { }
	    }

    static void CreateShortcut(string path, string target, string wd, string desc, string iconPath)
    {
        try
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t != null)
            {
                dynamic shell = Activator.CreateInstance(t);
                dynamic sc = shell.CreateShortcut(path);
                sc.TargetPath = target;
                sc.WorkingDirectory = wd;
                sc.WindowStyle = 1;
                sc.Description = desc;
                sc.IconLocation = iconPath + ",0";
                sc.Save();
            }
        }
        catch
        {
            // Fallback: create .url file
            try
            {
                string urlPath = Path.ChangeExtension(path, ".url");
                File.WriteAllText(urlPath, "[InternetShortcut]\nURL=file:///" +
                    target.Replace("\\", "/") + "\nIconFile=" +
                    iconPath.Replace("\\", "/") + "\nIconIndex=0");
            }
            catch { }
        }
    }
}
'@

$csPath = Join-Path $env:TEMP "IEXASetup.cs"
[System.IO.File]::WriteAllText($csPath, $csCode, [System.Text.Encoding]::UTF8)

$cscPath = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $cscPath)) { $cscPath = "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe" }

$stubExe = Join-Path $env:TEMP "IEXAStub.exe"
$iconPath = Join-Path $scriptDir "resources\icon.ico"
$compArgs = "/target:winexe /win32icon:`"$iconPath`" /out:`"$stubExe`" /reference:System.IO.Compression.FileSystem.dll `"$csPath`""
$result = Start-Process -FilePath $cscPath -ArgumentList $compArgs -Wait -PassThru -NoNewWindow

if ($result.ExitCode -ne 0 -or -not (Test-Path $stubExe)) {
    Write-Host "  Compilation FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "  Stub compiled: $([math]::Round((Get-Item $stubExe).Length/1KB, 1)) KB"

# ---- Step 3: Concatenate stub + ZIP + size marker ----
Write-Host "[3/4] Concatenating stub + payload..."

$stubBytes = [System.IO.File]::ReadAllBytes($stubExe)
$zipBytes = [System.IO.File]::ReadAllBytes($zipPath)
$sizeBytes = [System.BitConverter]::GetBytes([int64]$zipBytes.Length)

$finalBytes = New-Object byte[] ($stubBytes.Length + $zipBytes.Length + 8)
[Array]::Copy($stubBytes, 0, $finalBytes, 0, $stubBytes.Length)
[Array]::Copy($zipBytes, 0, $finalBytes, $stubBytes.Length, $zipBytes.Length)
[Array]::Copy($sizeBytes, 0, $finalBytes, $stubBytes.Length + $zipBytes.Length, 8)

[System.IO.File]::WriteAllBytes($OutputExe, $finalBytes)

$finalSize = (Get-Item $OutputExe).Length
Write-Host "  Final EXE: $([math]::Round($finalSize/1MB, 1)) MB"

# ---- Step 4: Cleanup ----
Write-Host "[4/4] Cleaning up..."
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $csPath -Force -ErrorAction SilentlyContinue
Remove-Item $stubExe -Force -ErrorAction SilentlyContinue

Write-Host "`n=== SUCCESS ===" -ForegroundColor Green
Write-Host "Setup: $OutputExe" -ForegroundColor Green
Write-Host "Size: $([math]::Round($finalSize/1MB, 1)) MB" -ForegroundColor Green
Write-Host ""
Write-Host "Run this EXE on any Windows machine to install IEXA." -ForegroundColor Cyan
Write-Host "It will extract to %LOCALAPPDATA%\IEXA and create desktop/start-menu shortcuts." -ForegroundColor Cyan
