using System.Diagnostics;
using System.IO;

namespace Iexa.DesktopAgent;

// Only application work renews this lease. Health/preview polling never keeps
// an unused native process resident. Isolated workspaces retain their job owner.
internal static class HelperLifetime
{
    static readonly object Gate = new();
    static long lastWork = Environment.TickCount64;
    static int active;
    static bool stopping;
    static System.Threading.Timer? idleTimer;
    internal static bool OwnerPipe => Environment.GetEnvironmentVariable("IEXA_DESKTOP_OWNER_PIPE") == "stdin-v1" && !IsolatedDesktopHost.Requested;
    internal static int IdleTimeoutMs => IsolatedDesktopHost.Requested ? 0 :
        int.TryParse(Environment.GetEnvironmentVariable("IEXA_DESKTOP_IDLE_MS"), out var ms) ? Math.Clamp(ms, 1000, 30000) : 30000;
    internal static object State() => new { version = 1, ownerPipe = OwnerPipe, idleTimeoutMs = IdleTimeoutMs };

    internal static void Start()
    {
        if (OwnerPipe) {
            // A dedicated background thread, not the HTTP thread pool. Windows
            // closes the inherited read pipe even if Electron terminates abruptly.
            new Thread(() => {
                try { using var input = Console.OpenStandardInput(); var buffer = new byte[16]; while (input.Read(buffer, 0, buffer.Length) > 0) { } }
                catch (IOException) { }
                finally { Exit(); }
            }) { IsBackground = true, Name = "IEXA owner lifetime" }.Start();
        }
        if (IdleTimeoutMs > 0) idleTimer = new System.Threading.Timer(_ => {
            lock (Gate) {
                if (stopping || active != 0 || Environment.TickCount64 - lastWork < IdleTimeoutMs) return;
                stopping = true;
            }
            Exit();
        }, null, 200, 200);
    }

    // Acquire before queueing work, so a waiting request cannot race idle exit.
    internal static IDisposable? TryEnter()
    {
        lock (Gate) {
            if (stopping) return null;
            active++;
            return new Lease();
        }
    }
    sealed class Lease : IDisposable {
        bool disposed;
        public void Dispose() { lock (Gate) { if (disposed) return; disposed = true; active--; lastWork = Environment.TickCount64; } }
    }
    internal static void Exit()
    {
        lock (Gate) stopping = true;
        // UIA provider disposal can block. Bound shutdown without touching any
        // user application: only this exact process terminates on the watchdog.
        new Thread(() => { Thread.Sleep(2000); Process.GetCurrentProcess().Kill(); }) { IsBackground = true }.Start();
        Environment.Exit(0);
    }
}
