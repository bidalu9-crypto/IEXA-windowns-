# =============================================================================
# IEXA PC - Installer Generator v5
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
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class IEXASetup
{
    const string RegistryPath = @"Software\IEXA";

    public static string DefaultInstallDir
    {
        get
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath))
                {
                    string saved = key == null ? null : key.GetValue("InstallLocation") as string;
                    if (!string.IsNullOrWhiteSpace(saved)) return saved;
                }
            }
            catch { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IEXA");
        }
    }

    static string DesktopDir
    {
        get { return Environment.GetFolderPath(Environment.SpecialFolder.Desktop); }
    }
    static string StartMenuDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "IEXA"); }
    }
    static string IconPath(string installDir)
    {
        return Path.Combine(installDir, "resources", "app", "resources", "icon.ico");
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(DefaultInstallDir));
    }

    public static string Install(string requestedDir, Action<string> report)
    {
        string installDir = ValidateInstallDir(requestedDir);
        report("\u6b63\u5728\u505c\u6b62\u5df2\u8fd0\u884c\u7684 IEXA...");
        foreach (Process process in Process.GetProcessesByName("IEXA"))
        {
            try { process.Kill(); process.WaitForExit(5000); } catch { }
        }

        Directory.CreateDirectory(installDir);
        VerifyWritable(installDir);
        string zipFile = Path.Combine(Path.GetTempPath(), "IEXA-" + Guid.NewGuid().ToString("N") + ".zip");
        try
        {
            report("\u6b63\u5728\u8bfb\u53d6\u5b89\u88c5\u5305...");
            ExtractEmbeddedZip(Assembly.GetExecutingAssembly().Location, zipFile);
            report("\u6b63\u5728\u5b89\u88c5\u6587\u4ef6...");
            ExtractPackage(zipFile, installDir, report);
        }
        finally
        {
            try { if (File.Exists(zipFile)) File.Delete(zipFile); } catch { }
        }

        string target = Path.Combine(installDir, "IEXA.exe");
        if (!File.Exists(target)) throw new InvalidOperationException("\u5b89\u88c5\u5305\u4e2d\u7f3a\u5c11 IEXA.exe\u3002");
        string icon = IconPath(installDir);
        report("\u6b63\u5728\u521b\u5efa\u5feb\u6377\u65b9\u5f0f...");
        CreateShortcut(Path.Combine(DesktopDir, "IEXA.lnk"), target, installDir, "IEXA - Your private AI agent", icon);
        Directory.CreateDirectory(StartMenuDir);
        CreateShortcut(Path.Combine(StartMenuDir, "IEXA.lnk"), target, installDir, "IEXA - Your private AI agent", icon);
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryPath))
            {
                if (key != null) key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
            }
        }
        catch { }
        return target;
    }

    static string ValidateInstallDir(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("\u8bf7\u9009\u62e9\u5b89\u88c5\u4f4d\u7f6e\u3002");
        string full = Path.GetFullPath(value.Trim().Trim('"')).TrimEnd(Path.DirectorySeparatorChar);
        string root = Path.GetPathRoot(full);
        if (string.Equals(full, root == null ? "" : root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("\u8bf7\u4e0d\u8981\u76f4\u63a5\u5b89\u88c5\u5230\u78c1\u76d8\u6839\u76ee\u5f55\u3002");
        return full;
    }

    static void VerifyWritable(string directory)
    {
        string probe = Path.Combine(directory, ".iexa-install-write-test-" + Guid.NewGuid().ToString("N"));
        try { File.WriteAllText(probe, "ok"); }
        catch (Exception ex) { throw new InvalidOperationException("\u6240\u9009\u76ee\u5f55\u4e0d\u53ef\u5199\uff0c\u8bf7\u9009\u62e9\u5176\u4ed6\u4f4d\u7f6e\u3002\n" + ex.Message, ex); }
        finally { try { if (File.Exists(probe)) File.Delete(probe); } catch { } }
    }

    static void ExtractEmbeddedZip(string executable, string destination)
    {
        using (FileStream input = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (input.Length < 8) throw new InvalidDataException("\u5b89\u88c5\u5305\u6570\u636e\u4e0d\u5b8c\u6574\u3002");
            input.Seek(-8, SeekOrigin.End);
            byte[] marker = new byte[8];
            ReadExactly(input, marker, 0, marker.Length);
            long zipSize = BitConverter.ToInt64(marker, 0);
            long zipOffset = input.Length - 8 - zipSize;
            if (zipSize <= 0 || zipOffset < 0) throw new InvalidDataException("\u5b89\u88c5\u5305\u6570\u636e\u6821\u9a8c\u5931\u8d25\u3002");
            input.Seek(zipOffset, SeekOrigin.Begin);
            using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                byte[] buffer = new byte[1024 * 1024];
                long remaining = zipSize;
                while (remaining > 0)
                {
                    int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                    if (read <= 0) throw new EndOfStreamException("\u5b89\u88c5\u5305\u6570\u636e\u88ab\u622a\u65ad\u3002");
                    output.Write(buffer, 0, read);
                    remaining -= read;
                }
            }
        }
    }

    static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int read = stream.Read(buffer, offset, count);
            if (read <= 0) throw new EndOfStreamException();
            offset += read;
            count -= read;
        }
    }

    static void ExtractPackage(string zipFile, string installDir, Action<string> report)
    {
        string root = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (ZipArchive archive = ZipFile.OpenRead(zipFile))
        {
            int index = 0;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                string destination = Path.GetFullPath(Path.Combine(root, relative));
                if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("\u5b89\u88c5\u5305\u5305\u542b\u65e0\u6548\u8def\u5f84\uff1a" + entry.FullName);
                if (string.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(destination);
                else
                {
                    string parent = Path.GetDirectoryName(destination);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    entry.ExtractToFile(destination, true);
                }
                index++;
                if (index % 40 == 0) report("\u6b63\u5728\u5b89\u88c5\u6587\u4ef6... " + index + "/" + archive.Entries.Count);
            }
        }
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

class SetupForm : Form
{
    readonly TextBox pathBox = new TextBox();
    readonly Button browseButton = new Button();
    readonly Button installButton = new Button();
    readonly Button cancelButton = new Button();
    readonly Label statusLabel = new Label();
    bool busy;

    public SetupForm(string defaultPath)
    {
        Text = "\u5b89\u88c5 IEXA-WIN";
        ClientSize = new Size(560, 238);
        MinimumSize = new Size(576, 277);
        MaximumSize = new Size(900, 277);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        Font = new Font("Segoe UI", 9F);
        BackColor = Color.FromArgb(245, 245, 247);

        Label title = new Label();
        title.Text = "\u5b89\u88c5 IEXA-WIN";
        title.Font = new Font("Segoe UI Semibold", 17F, FontStyle.Bold);
        title.AutoSize = true;
        title.Location = new Point(24, 20);
        Controls.Add(title);

        Label description = new Label();
        description.Text = "\u9009\u62e9\u5b89\u88c5\u4f4d\u7f6e\uff0c\u7136\u540e\u5f00\u59cb\u5b89\u88c5\u3002\u91cd\u65b0\u5b89\u88c5\u65f6\u4f1a\u4fdd\u7559\u5de5\u4f5c\u533a\u6570\u636e\u3002";
        description.ForeColor = Color.FromArgb(90, 90, 96);
        description.AutoSize = true;
        description.Location = new Point(27, 59);
        Controls.Add(description);

        Label pathLabel = new Label();
        pathLabel.Text = "\u5b89\u88c5\u4f4d\u7f6e";
        pathLabel.AutoSize = true;
        pathLabel.Location = new Point(27, 93);
        Controls.Add(pathLabel);

        pathBox.Text = defaultPath;
        pathBox.Location = new Point(30, 115);
        pathBox.Size = new Size(404, 25);
        pathBox.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top;
        Controls.Add(pathBox);

        browseButton.Text = "\u6d4f\u89c8...";
        browseButton.Location = new Point(442, 113);
        browseButton.Size = new Size(88, 29);
        browseButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
        browseButton.Click += Browse;
        Controls.Add(browseButton);

        statusLabel.Text = "\u51c6\u5907\u5b89\u88c5";
        statusLabel.ForeColor = Color.FromArgb(100, 100, 106);
        statusLabel.AutoEllipsis = true;
        statusLabel.Location = new Point(30, 154);
        statusLabel.Size = new Size(300, 24);
        Controls.Add(statusLabel);

        installButton.Text = "\u5b89\u88c5";
        installButton.Location = new Point(330, 184);
        installButton.Size = new Size(96, 32);
        installButton.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
        installButton.Click += Install;
        Controls.Add(installButton);

        cancelButton.Text = "\u53d6\u6d88";
        cancelButton.Location = new Point(434, 184);
        cancelButton.Size = new Size(96, 32);
        cancelButton.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
        cancelButton.Click += delegate { Close(); };
        Controls.Add(cancelButton);
        AcceptButton = installButton;
        CancelButton = cancelButton;
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
    }

    void Browse(object sender, EventArgs e)
    {
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "\u9009\u62e9 IEXA-WIN \u7684\u5b89\u88c5\u76ee\u5f55";
            dialog.ShowNewFolderButton = true;
            string candidate = pathBox.Text.Trim();
            while (!string.IsNullOrEmpty(candidate) && !Directory.Exists(candidate)) candidate = Path.GetDirectoryName(candidate);
            if (!string.IsNullOrEmpty(candidate)) dialog.SelectedPath = candidate;
            if (dialog.ShowDialog(this) == DialogResult.OK) pathBox.Text = dialog.SelectedPath;
        }
    }

    void Install(object sender, EventArgs e)
    {
        if (busy) return;
        string requested = pathBox.Text;
        busy = true;
        pathBox.Enabled = browseButton.Enabled = installButton.Enabled = cancelButton.Enabled = false;
        UseWaitCursor = true;
        statusLabel.Text = "\u6b63\u5728\u51c6\u5907\u5b89\u88c5...";
        Thread worker = new Thread(delegate()
        {
            try
            {
                string target = IEXASetup.Install(requested, delegate(string text)
                {
                    BeginInvoke(new MethodInvoker(delegate { statusLabel.Text = text; }));
                });
                BeginInvoke(new MethodInvoker(delegate
                {
                    busy = false;
                    UseWaitCursor = false;
                    statusLabel.Text = "\u5b89\u88c5\u5b8c\u6210";
                    MessageBox.Show(this, "IEXA-WIN \u5df2\u5b89\u88c5\u5b8c\u6210\u3002", "\u5b89\u88c5\u5b8c\u6210", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    Process.Start(new ProcessStartInfo(target) { WorkingDirectory = Path.GetDirectoryName(target), UseShellExecute = true });
                    Close();
                }));
            }
            catch (Exception ex)
            {
                BeginInvoke(new MethodInvoker(delegate
                {
                    busy = false;
                    UseWaitCursor = false;
                    pathBox.Enabled = browseButton.Enabled = installButton.Enabled = cancelButton.Enabled = true;
                    statusLabel.Text = "\u5b89\u88c5\u5931\u8d25";
                    MessageBox.Show(this, ex.Message, "\u5b89\u88c5\u5931\u8d25", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }));
            }
        });
        worker.IsBackground = true;
        worker.Start();
    }
}
'@

$csPath = Join-Path $env:TEMP "IEXASetup.cs"
[System.IO.File]::WriteAllText($csPath, $csCode, [System.Text.Encoding]::UTF8)

$cscPath = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $cscPath)) { $cscPath = "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe" }

$stubExe = Join-Path $env:TEMP "IEXAStub.exe"
$iconPath = Join-Path $scriptDir "resources\icon.ico"
$compArgs = "/target:winexe /win32icon:`"$iconPath`" /out:`"$stubExe`" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `"$csPath`""
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
Write-Host "The installer lets the user choose a destination and creates desktop/start-menu shortcuts." -ForegroundColor Cyan
