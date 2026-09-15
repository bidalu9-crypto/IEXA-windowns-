using System.Drawing;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Iexa.DesktopAgent;

// Window capture interop follows Microsoft's MIT-licensed Win32 Composition
// sample (see third-party/WindowsCapture-LICENSE.txt). No SharpDX dependency.
// A compositor capture never sends WM_PRINT or injects input into its target.
internal static class CompositorCapture
{
    internal sealed record Frame(Bitmap Pixels, Rectangle Bounds) : IDisposable
    {
        public void Dispose() => Pixels.Dispose();
    }

    internal static Frame Capture(IntPtr window, Action checkCancelled)
        => CaptureAsync(window, checkCancelled).GetAwaiter().GetResult();

    static async Task<Frame> CaptureAsync(IntPtr window, Action checkCancelled)
    {
        checkCancelled();
        if (!GraphicsCaptureSession.IsSupported()) throw new InvalidOperationException("Windows compositor capture unavailable.");
        if (!IsWindowVisible(window) || IsIconic(window))
            throw new InvalidOperationException("Target is hidden or minimized; no activation attempted.");
        Check(DwmGetWindowAttribute(window, 14, out int cloaked, sizeof(int)), "DWM cloaking query");
        if (cloaked != 0) throw new InvalidOperationException("Target is cloaked on another desktop; no desktop switch attempted.");
        GraphicsCaptureItem item;
        try { item = CreateItem(window); }
        catch (Exception error) { throw new InvalidOperationException($"CreateForWindow failed (0x{error.HResult:x8}): {error.Message}", error); }
        if (item.Size.Width < 2 || item.Size.Height < 2 || (long)item.Size.Width * item.Size.Height > 40_000_000)
            throw new InvalidOperationException("Invalid compositor capture dimensions.");
        var initialRaw = RawWindowBounds(window);
        var initialExtended = WindowBounds(window);
        using var device = CreateDevice();
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        var ready = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Arrived(Direct3D11CaptureFramePool sender, object _) {
            try {
                var frame = sender.TryGetNextFrame();
                if (frame != null && !ready.TrySetResult(frame)) frame.Dispose();
            } catch (Exception error) { ready.TrySetException(error); }
        }
        pool.FrameArrived += Arrived;
        Direct3D11CaptureFrame? acquired = null;
        try {
            session.StartCapture();
            // Timeout and cancellation cause disposal; no alternate target/capture retry.
            var wait = Stopwatch.StartNew();
            while (!ready.Task.IsCompleted) {
                checkCancelled();
                if (wait.ElapsedMilliseconds >= 2000) throw new TimeoutException("Compositor did not supply a frame in 2 seconds.");
                await Task.WhenAny(ready.Task, Task.Delay(25));
            }
            acquired = await ready.Task;
            checkCancelled();
            if (RawWindowBounds(window) != initialRaw || WindowBounds(window) != initialExtended)
                throw new InvalidOperationException("Window moved or resized during compositor capture; observe again.");
            // Item.Size sizes the backing pool, not necessarily the delivered content.
            // A decorated HWND may start at GetWindowRect size but deliver DWM bounds.
            var bounds = CaptureBounds(window, acquired.ContentSize.Width, acquired.ContentSize.Height);
            using var software = await CopySurface(acquired.Surface, checkCancelled);
            checkCancelled();
            if (software.PixelWidth < bounds.Width || software.PixelHeight < bounds.Height ||
                (long)software.PixelWidth * software.PixelHeight > 40_000_000)
                throw new InvalidOperationException("Compositor content exceeds its backing surface.");
            var length = checked(software.PixelWidth * software.PixelHeight * 4);
            var buffer = new Windows.Storage.Streams.Buffer((uint)length);
            software.CopyToBuffer(buffer);
            var bytes = new byte[length];
            using (var reader = DataReader.FromBuffer(buffer)) reader.ReadBytes(bytes);
            var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb);
            try {
                var locked = bitmap.LockBits(new Rectangle(Point.Empty, bitmap.Size), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                try {
                    for (var row = 0; row < bounds.Height; row++)
                        Marshal.Copy(bytes, row * software.PixelWidth * 4, IntPtr.Add(locked.Scan0, row * locked.Stride), bounds.Width * 4);
                } finally { bitmap.UnlockBits(locked); }
                checkCancelled();
                if (RawWindowBounds(window) != initialRaw || WindowBounds(window) != initialExtended)
                    throw new InvalidOperationException("Window moved during pixel copy; observe again.");
                return new Frame(bitmap, bounds);
            } catch { bitmap.Dispose(); throw; }
        } finally {
            pool.FrameArrived -= Arrived;
            ready.TrySetCanceled();
            if (acquired != null) acquired.Dispose();
            else if (ready.Task.IsCompletedSuccessfully) ready.Task.Result.Dispose();
        }
    }

    static async Task<SoftwareBitmap> CopySurface(IDirect3DSurface surface, Action checkCancelled)
    {
        var operation = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface, BitmapAlphaMode.Ignore);
        var copy = operation.AsTask();
        var timer = Stopwatch.StartNew();
        try {
            while (!copy.IsCompleted) {
                checkCancelled();
                if (timer.ElapsedMilliseconds >= 2000) throw new TimeoutException("Compositor GPU copy exceeded 2 seconds.");
                await Task.WhenAny(copy, Task.Delay(25));
            }
            // Ownership transfers to the caller, which checks cancellation while holding a using lease.
            var result = await copy;
            operation.Close();
            return result;
        } catch {
            try { operation.Cancel(); } catch { /* Preserve original failure. */ }
            // Cancellation may race native completion. Always dispose a late bitmap,
            // observe a late fault, and release the WinRT operation without blocking input.
            _ = copy.ContinueWith(task => {
                if (task.Status == TaskStatus.RanToCompletion) task.Result.Dispose();
                else if (task.IsFaulted) _ = task.Exception;
                try { operation.Close(); } catch { }
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            throw;
        }
    }

    static void Check(int hr, string stage) { if (hr < 0) throw new InvalidOperationException($"{stage}: 0x{hr:x8}"); }

    static GraphicsCaptureItem CreateItem(IntPtr window)
    {
        const string name = "Windows.Graphics.Capture.GraphicsCaptureItem";
        IntPtr hstring = IntPtr.Zero, factory = IntPtr.Zero, result = IntPtr.Zero;
        try {
            Check(WindowsCreateString(name, name.Length, out hstring), "WindowsCreateString");
            var interopId = new Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
            Check(RoGetActivationFactory(hstring, ref interopId, out factory), "RoGetActivationFactory");
            var iid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            var create = Marshal.GetDelegateForFunctionPointer<CreateForWindow>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory), 3 * IntPtr.Size));
            Check(create(factory, window, ref iid, out result), "IGraphicsCaptureItemInterop.CreateForWindow");
            return WinRT.MarshalInspectable<GraphicsCaptureItem>.FromAbi(result);
        } finally {
            if (result != IntPtr.Zero) Marshal.Release(result);
            if (factory != IntPtr.Zero) Marshal.Release(factory);
            if (hstring != IntPtr.Zero) WindowsDeleteString(hstring);
        }
    }

    static IDirect3DDevice CreateDevice()
    {
        IntPtr native = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, projected = IntPtr.Zero;
        try {
            Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out native, out _, out context));
            var iid = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, ref iid, out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out projected));
            return WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(projected);
        } finally {
            if (projected != IntPtr.Zero) Marshal.Release(projected);
            if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
            if (context != IntPtr.Zero) Marshal.Release(context);
            if (native != IntPtr.Zero) Marshal.Release(native);
        }
    }

    // WGC can expose the full HWND surface including invisible resize borders.
    // Match physical rectangles exactly; never scale capture pixels to UIA coordinates.
    static Rectangle CaptureBounds(IntPtr window, int width, int height)
    {
        var raw = RawWindowBounds(window);
        var extended = WindowBounds(window);
        if (raw.Width == width && raw.Height == height) {
            if (extended.Width == width && extended.Height == height && extended != raw)
                throw new InvalidOperationException("Ambiguous compositor origin; observe again.");
            return raw;
        }
        if (extended.Width == width && extended.Height == height) return extended;
        throw new InvalidOperationException($"Compositor geometry differs: item={width}x{height}, dwm={extended}, window={raw}, dpi={GetDpiForWindow(window)}; no scaling fallback.");
    }

    static Rectangle WindowBounds(IntPtr window)
    {
        Marshal.ThrowExceptionForHR(DwmGetWindowAttribute(window, 9, out RECT rect, Marshal.SizeOf<RECT>()));
        return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
    }
    static Rectangle RawWindowBounds(IntPtr window)
    {
        if (!GetWindowRect(window, out var rect)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
    }
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateForWindow(IntPtr self, IntPtr window, ref Guid iid, out IntPtr result);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string source, int length, out IntPtr value);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr value);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driver, IntPtr software, uint flags, IntPtr levels, uint count, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr device, out IntPtr result);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT rect, int size);
}
