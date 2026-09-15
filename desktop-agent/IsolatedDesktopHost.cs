using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Iexa.DesktopAgent;

/// <summary>A separately owned Windows desktop, NOT a filesystem or network sandbox.
/// No SwitchDesktop/SendInput; every owned process dies with the host's job handle.</summary>
internal static class IsolatedDesktopHost
{
    internal static string Name => Environment.GetEnvironmentVariable("IEXA_ISOLATED_DESKTOP") ?? "";
    internal static bool Requested => Name.Length > 0;
    internal static object State() => new { requested = Requested, verified = IsVerified(), desktopName = Requested ? Name : "", physicalInput = false };
    internal static bool IsVerified()
    {
        if (!Requested || DesktopName(GetThreadDesktop(GetCurrentThreadId())) != Name) return false;
        var input = OpenInputDesktop(0, false, 1);
        if (input == IntPtr.Zero) return false;
        try { var inputName = DesktopName(input); return inputName.Length > 0 && inputName != Name; } finally { CloseDesktop(input); }
    }
    internal static void Verify()
    {
        if (Requested && !IsVerified()) throw new InvalidOperationException("Isolated desktop ownership changed or user takeover detected. No input dispatched.");
    }
    internal static void VerifyWindow(IntPtr window)
    {
        if (!Requested) return;
        Verify();
        var thread = GetWindowThreadProcessId(window, out _);
        if (thread == 0 || DesktopName(GetThreadDesktop(thread)) != Name)
            throw new InvalidOperationException("Window belongs to another desktop; no cross-desktop observation or input.");
    }
    static string DesktopName(IntPtr desktop)
    {
        var value = new StringBuilder(512);
        return desktop != IntPtr.Zero && GetUserObjectInformation(desktop, 2, value, value.Capacity * 2, out _) ? value.ToString() : "";
    }
    internal static void Run(string directory)
    {
        directory = Path.GetFullPath(directory);
        var request = JsonSerializer.Deserialize<HostRequest>(File.ReadAllText(Path.Combine(directory, "request.json"))) ?? throw new InvalidOperationException("Missing host request");
        if (request.Port < 1024 || request.Port > 65535 || request.ParentPid < 1) throw new InvalidOperationException("Invalid isolated host request");
        IntPtr desktop = IntPtr.Zero, job = IntPtr.Zero, parent = IntPtr.Zero;
        PROCESS_INFORMATION child = default;
        var name = "IEXA-Owned-" + Guid.NewGuid().ToString("N");
        void Save(string file, object value) => File.WriteAllText(Path.Combine(directory, file), JsonSerializer.Serialize(value));
        try
        {
            parent = OpenProcess(0x100000, false, request.ParentPid); Check(parent != IntPtr.Zero, "Open parent lifetime");
            // No SWITCHDESKTOP or journal-playback access is requested.
            desktop = CreateDesktop(name, null, IntPtr.Zero, 0, 0xCF, IntPtr.Zero); Check(desktop != IntPtr.Zero, "CreateDesktop");
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
            var limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<EXTENDED_LIMIT>()), "Set job lifetime");
            Environment.SetEnvironmentVariable("IEXA_ISOLATED_DESKTOP", name);
            Environment.SetEnvironmentVariable("IEXA_DESKTOP_PORT", request.Port.ToString());
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing native executable");
            var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = "winsta0\\" + name };
            Check(CreateProcess(executable, new StringBuilder('"' + executable + '"'), IntPtr.Zero, IntPtr.Zero, false, 4, IntPtr.Zero, directory, ref startup, out child), "Create isolated worker");
            Check(AssignProcessToJobObject(job, child.hProcess), "Assign isolated worker job");
            Check(ResumeThread(child.hThread) != uint.MaxValue, "Resume isolated worker");
            CloseHandle(child.hThread); child.hThread = IntPtr.Zero;
            Save("ready.json", new { desktopName = name, pid = child.dwProcessId, hostPid = Environment.ProcessId, port = request.Port, jobBound = true });
            while (!File.Exists(Path.Combine(directory, "stop")) && WaitForSingleObject(parent, 0) == 258 && WaitForSingleObject(child.hProcess, 0) == 258) Thread.Sleep(100);
        }
        catch (Exception error) { Save("error.json", new { error = error.Message }); }
        finally
        {
            // A worker failing before AssignProcessToJobObject must be killed by its held handle too.
            if (child.hProcess != IntPtr.Zero) TerminateProcess(child.hProcess, 0);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            var exited = child.hProcess == IntPtr.Zero || WaitForSingleObject(child.hProcess, 5000) == 0;
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            var closed = desktop == IntPtr.Zero || CloseDesktop(desktop);
            Save("ended.json", new { desktopName = name, workerExited = exited, desktopClosed = closed });
        }
    }
    sealed record HostRequest(int Port, int ParentPid);
    static void Check(bool ok, string operation) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation); }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string? lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
    [DllImport("user32.dll", EntryPoint="CreateDesktopW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name,string? device,IntPtr devmode,uint flags,uint access,IntPtr attributes);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll", EntryPoint="GetUserObjectInformationW", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int length,out int needed);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll", EntryPoint="CreateJobObjectW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string? name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limits,uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", EntryPoint="CreateProcessW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
}
