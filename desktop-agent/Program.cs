using System.Collections.Concurrent;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Forms;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace Iexa.DesktopAgent;

internal static class Program
{
    static readonly int Port = int.TryParse(Environment.GetEnvironmentVariable("IEXA_DESKTOP_PORT"), out var port) && port >= 1024 && port <= 65535 ? port : 17891;
    static readonly string Prefix = $"http://127.0.0.1:{Port}/";
    static readonly string InstanceNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
    static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = false };
    static readonly object InputLock = new();
    static readonly SemaphoreSlim ActionGate = new(1, 1);
    static readonly MatureAutomation Automation = new();
    static readonly ConcurrentDictionary<string, SemanticElement> ElementCache = new();
    static int CancelRequested;
    static long CancellationEpoch;
    static FrameState? LastFrame;
    static string LastOcrStatus = "not-run";
    static string LastOcrLanguage = "";
    static int LastOcrCount;
    static IntPtr BoundWindow = IntPtr.Zero;
    static Rectangle BoundBounds = Rectangle.Empty;
    static long ObservationEpoch;
    static string ObservationToken = "";
    static string ActiveAction = "idle";
    static int ActiveStep;
    static int TotalSteps;
    static int Paused;
    record SemanticElement(string Id, string Role, string Text, int Left, int Top, int Width, int Height, string Source, double Confidence, bool Enabled = true, AutomationSelector? Selector = null);
    record FrameState(byte[] Gray, int Width, int Height, string Hash, long CapturedAt);

    [STAThread]
    static async Task Main()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => { InputLease.ReleaseActive(); Automation.Dispose(); };
        AppDomain.CurrentDomain.UnhandledException += (_, _) => InputLease.ReleaseActive();
        using var mutex = new Mutex(true, Port == 17891 ? "Local\\IexaDesktopAgent" : $"Local\\IexaDesktopAgent-{Port}", out var first);
        if (!first) return;
        using var listener = new HttpListener();
        listener.Prefixes.Add(Prefix);
        listener.Start();
        Console.WriteLine($"IEXA Desktop Agent listening at {Prefix}");
        while (true)
        {
            var context = await listener.GetContextAsync();
            _ = Task.Run(() => Handle(context));
        }
    }

    static async Task Handle(HttpListenerContext context)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            if (!string.IsNullOrEmpty(context.Request.Headers["Origin"])) { await Reply(context, 403, new { ok = false, error = "Browser clients must use the application proxy." }); return; }
            if (context.Request.HttpMethod == "POST" && context.Request.Url?.AbsolutePath == "/pause") {
                Interlocked.Increment(ref CancellationEpoch);
                Interlocked.Exchange(ref Paused, 1);
                Interlocked.Exchange(ref CancelRequested, 1);
                InputLease.ReleaseActive();
                await Reply(context, 200, new { ok = true, paused = true }); return;
            }
            if (context.Request.HttpMethod == "POST" && context.Request.Url?.AbsolutePath == "/resume") {
                Interlocked.Exchange(ref Paused, 0);
                await Reply(context, 200, new { ok = true, paused = false }); return;
            }
            if (context.Request.HttpMethod == "GET" && context.Request.Url?.AbsolutePath == "/health")
            {
                await Reply(context, 200, new { ok = true, product = "IEXA Desktop Agent", version = 4, protocolVersion = 4, instanceNonce = InstanceNonce, automationEngine = "FlaUI 5", pid = Environment.ProcessId, uptimeMs = Environment.TickCount64, action = ActiveAction, step = ActiveStep, total = TotalSteps, paused = Volatile.Read(ref Paused) != 0, window = BoundWindow.ToInt64() });
                return;
            }
            if (context.Request.HttpMethod == "GET" && context.Request.Url?.AbsolutePath == "/frame")
            {
                await ReplyFrame(context); return;
            }
            if (context.Request.HttpMethod == "GET" && context.Request.Url?.AbsolutePath == "/capabilities")
            {
                await Reply(context, 200, new { ok = true, product = "IEXA Desktop Agent", protocolVersion = 4, instanceNonce = InstanceNonce, transport = "persistent-local-http", actions = new[] { "observe", "frame", "activate", "minimize", "move", "click", "drag", "click_element", "type", "type_element", "find_element", "read_focused", "key", "hotkey", "scroll", "wait", "wait_change", "batch" }, uiAutomation = true, automationEngine = "FlaUI 5", primaryBackend = "UIA3", fallbackBackend = "UIA2", stableSelectors = true, patternActions = true, localOcr = true, semanticElements = true, frameDiff = true, screenFrames = true, humanPointer = true, unicodeInput = true, managedInputLease = true, closeHotkeyGuard = true });
                return;
            }
            // Cancellation must bypass the serialized action gate. A long
            // observe/wait/type operation may currently own that gate, so
            // queueing /cancel behind it would never interrupt the action.
            if (context.Request.HttpMethod == "POST" && context.Request.Url?.AbsolutePath == "/cancel")
            {
                Interlocked.Increment(ref CancellationEpoch);
                Interlocked.Exchange(ref CancelRequested, 1);
                InputLease.ReleaseActive();
                await Reply(context, 200, new { ok = true, cancelled = true });
                return;
            }
            if (context.Request.HttpMethod != "POST" || (context.Request.Url?.AbsolutePath != "/execute" && context.Request.Url?.AbsolutePath != "/session"))
            {
                await Reply(context, 404, new { ok = false, error = "Not found" }); return;
            }
            using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
            var json = await reader.ReadToEndAsync();
            var req = JsonNode.Parse(json)?.AsObject() ?? throw new InvalidOperationException("Invalid JSON body");
            var action = req["action"]?.GetValue<string>() ?? "observe";
            var cancellationAtQueue = Interlocked.Read(ref CancellationEpoch);
            await ActionGate.WaitAsync();
            try
            {
                if (Volatile.Read(ref Paused) != 0) throw new InvalidOperationException("Desktop input is paused by the user. Resume from the live panel.");
                if (cancellationAtQueue != Interlocked.Read(ref CancellationEpoch)) throw new OperationCanceledException("Queued desktop action cancelled.");
                // Reset only after acquiring the gate. A queued action must
                // not clear a cancellation flag while the previous action is
                // still unwinding.
                Interlocked.Exchange(ref CancelRequested, 0);
                ActiveAction = action;
                ActiveStep = 0;
                TotalSteps = 0;
                object data = action switch
                {
                    "observe" => await Observe(req),
                    "activate" => Activate(req),
                    "minimize" => Minimize(req),
                    "bind_window" => BindWindow(req),
                    "session_state" => SessionState(),
                    "click" => Click(req),
                    "drag" => Drag(req),
                    "click_element" => ClickElement(req),
                    "type_element" => TypeElement(req),
                    "find_element" => FindElement(req),
                    "read_focused" => ReadFocused(),
                    "wait_change" => await WaitChange(req),
                    "move" => Move(req),
                    "type" => TypeText(req),
                    "key" => Key(req),
                    "hotkey" => Hotkey(req),
                    "scroll" => Scroll(req),
                    "wait" => Wait(req),
                    "batch" => await Batch(req),
                    _ => throw new InvalidOperationException($"Unknown action: {action}")
                };
                await Reply(context, 200, new { ok = true, action, elapsedMs = sw.ElapsedMilliseconds, data });
            }
            finally
            {
                InputLease.ReleaseActive();
                ActiveAction = "idle";
                ActionGate.Release();
            }
        }
        catch (Exception ex)
        {
            await Reply(context, 400, new { ok = false, elapsedMs = sw.ElapsedMilliseconds, error = ex.Message });
        }
    }

    static async Task ReplyFrame(HttpListenerContext context)
    {
        var fullScreen = context.Request.QueryString["full"] == "1";
        Rectangle bounds;
        if (!fullScreen && BoundWindow != IntPtr.Zero && GetWindowRect(BoundWindow, out var wr)) bounds = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
        else bounds = Screen.AllScreens.Select(s => s.Bounds).Aggregate(Rectangle.Union);
        bounds = Rectangle.Intersect(bounds, SystemInformation.VirtualScreen);
        if (bounds.Width < 2 || bounds.Height < 2) throw new InvalidOperationException("Screen capture bounds are unavailable.");
        using var bitmap = new Bitmap(bounds.Width, bounds.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
        var jpeg = context.Request.QueryString["format"] == "jpeg";
        var maxWidth = int.TryParse(context.Request.QueryString["width"], out var requestedWidth) ? Math.Clamp(requestedWidth, 320, 1920) : bounds.Width;
        var width = Math.Min(bounds.Width, maxWidth);
        using var scaled = new Bitmap(bitmap, new Size(width, Math.Max(1, bounds.Height * width / bounds.Width)));
        using var stream = new MemoryStream(); scaled.Save(stream, jpeg ? System.Drawing.Imaging.ImageFormat.Jpeg : System.Drawing.Imaging.ImageFormat.Png);
        var data = stream.ToArray(); context.Response.StatusCode = 200; context.Response.ContentType = jpeg ? "image/jpeg" : "image/png"; context.Response.ContentLength64 = data.Length;
        context.Response.Headers["Cache-Control"] = "no-store";
        context.Response.Headers["X-Captured-At"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
        await context.Response.OutputStream.WriteAsync(data); context.Response.Close();
    }

    static async Task<object> Observe(JsonObject req)
    {
        ThrowIfCancelled();
        var includeElements = req["includeElements"]?.GetValue<bool>() ?? true;
        var includeOcr = req["includeOcr"]?.GetValue<bool>() ?? false;
        var includeRegions = req["includeRegions"]?.GetValue<bool>() ?? false;
        var limit = Math.Clamp(req["limit"]?.GetValue<int>() ?? 50, 1, 200);
        var requested = ResolveRequestedWindow(req, false);
        var fg = requested != IntPtr.Zero ? requested : GetForegroundWindow();
        if (fg == IntPtr.Zero || !IsWindow(fg)) throw new InvalidOperationException("No valid target window.");
        var cursor = new POINT(); GetCursorPos(out cursor);
        var screens = Screen.AllScreens.Select(s => new { name = s.DeviceName, primary = s.Primary, bounds = Rect(s.Bounds), workingArea = Rect(s.WorkingArea) }).ToArray();
        var windows = EnumWindowsSnapshot().Take(80).ToArray();
        var semantic = new List<SemanticElement>();
        AutomationObservation? automationObservation = null;
        if (includeElements && fg != IntPtr.Zero)
        {
            automationObservation = Automation.Observe(fg, limit, ObservationEpoch + 1, ThrowIfCancelled);
            semantic.AddRange(automationObservation.Elements.Select(e => new SemanticElement(
                e.Id, e.Role, e.Text, e.Bounds.Left, e.Bounds.Top, e.Bounds.Width, e.Bounds.Height,
                e.Selector.Backend, 1, e.Enabled, e.Selector)));
        }
        using var bitmap = CaptureForeground(fg, out var captureBounds);
        ThrowIfCancelled();
        var previous = LastFrame;
        var current = MakeFrameState(bitmap);
        var change = FrameDifference(previous, current);
        LastFrame = current;
        if (includeOcr && bitmap.Width > 1) semantic.AddRange(await OcrElements(bitmap, captureBounds));
        ThrowIfCancelled();
        if (includeRegions && bitmap.Width > 1) semantic.AddRange(DetectRegions(bitmap, captureBounds, semantic));
        var merged = MergeElements(semantic).Take(limit).ToArray();
        BoundWindow = fg; BoundBounds = captureBounds; ObservationEpoch++;
        ObservationToken = MakeObservationToken(fg, captureBounds, current.Hash, ObservationEpoch);
        ElementCache.Clear(); foreach (var element in merged) ElementCache[element.Id] = element;
        return new { mode = "structured-local-perception-v2", perceptionVersion = 3, session = SessionState(), foreground = WindowInfo(fg), cursor = new { x = cursor.X, y = cursor.Y }, screens, windows, frame = new { hash = current.Hash, width = bitmap.Width, height = bitmap.Height, changedRatio = change, capturedAt = current.CapturedAt }, automation = automationObservation == null ? null : new { engine = "FlaUI 5", backend = automationObservation.Backend, fallbackUsed = automationObservation.FallbackUsed, diagnostics = automationObservation.Diagnostics }, ocr = new { status = LastOcrStatus, language = LastOcrLanguage, count = LastOcrCount }, elements = merged.Select(PublicElement).ToArray() };
    }

    static Bitmap CaptureForeground(IntPtr h, out Rectangle bounds)
    {
        if (h != IntPtr.Zero && GetWindowRect(h, out var wr)) bounds = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
        else bounds = Screen.AllScreens.Select(s => s.Bounds).Aggregate(Rectangle.Union);
        var virtualBounds = SystemInformation.VirtualScreen;
        bounds = Rectangle.Intersect(bounds, virtualBounds);
        if (bounds.Width < 2 || bounds.Height < 2) bounds = virtualBounds;
        var bitmap = new Bitmap(bounds.Width, bounds.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
        return bitmap;
    }

    static FrameState MakeFrameState(Bitmap bitmap)
    {
        const int width = 160, height = 90;
        using var small = new Bitmap(width, height);
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Low; g.DrawImage(bitmap, 0, 0, width, height); }
        var gray = new byte[width * height];
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) { var c = small.GetPixel(x, y); gray[y * width + x] = (byte)((c.R * 30 + c.G * 59 + c.B * 11) / 100); }
        return new FrameState(gray, width, height, Convert.ToHexString(SHA256.HashData(gray)).ToLowerInvariant()[..20], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    static double FrameDifference(FrameState? before, FrameState after)
    {
        if (before == null || before.Width != after.Width || before.Height != after.Height) return 1;
        long changed = 0;
        for (var i = 0; i < after.Gray.Length; i++) if (Math.Abs(after.Gray[i] - before.Gray[i]) >= 18) changed++;
        return Math.Round((double)changed / after.Gray.Length, 4);
    }

    static async Task<IEnumerable<SemanticElement>> OcrElements(Bitmap bitmap, Rectangle origin)
    {
        var result = new List<SemanticElement>();
        try
        {
            using var ms = new MemoryStream(); bitmap.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            using var random = new InMemoryRandomAccessStream();
            var writer = new DataWriter(random); writer.WriteBytes(ms.ToArray()); await writer.StoreAsync(); await writer.FlushAsync(); writer.DetachStream(); writer.Dispose();
            random.Seek(0);
            var decoder = await BitmapDecoder.CreateAsync(random);
            using var software = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            var languages = new[] { "zh-CN", "en-US" };
            OcrEngine? engine = null;
            foreach (var tag in languages) { try { engine = OcrEngine.TryCreateFromLanguage(new Language(tag)); if (engine != null) break; } catch { } }
            engine ??= OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null) { LastOcrStatus = "engine-unavailable"; LastOcrLanguage = ""; LastOcrCount = 0; return result; }
            LastOcrLanguage = engine.RecognizerLanguage.LanguageTag;
            var ocr = await engine.RecognizeAsync(software);
            foreach (var line in ocr.Lines)
            {
                var words = line.Words.Where(w => !string.IsNullOrWhiteSpace(w.Text) && w.BoundingRect.Width >= 2 && w.BoundingRect.Height >= 2).ToArray();
                if (words.Length == 0) continue;
                var text = string.Concat(words.Select(w => w.Text)).Trim();
                var minX = words.Min(w => w.BoundingRect.X); var minY = words.Min(w => w.BoundingRect.Y); var maxX = words.Max(w => w.BoundingRect.X + w.BoundingRect.Width); var maxY = words.Max(w => w.BoundingRect.Y + w.BoundingRect.Height);
                var left = origin.Left + (int)minX; var top = origin.Top + (int)minY; var width = (int)Math.Ceiling(maxX - minX); var height = (int)Math.Ceiling(maxY - minY);
                var role = GuessRole(text, left, top, width, height, origin);
                result.Add(new SemanticElement(MakeId("ocr", role, text, left, top, width, height), role, text, left, top, width, height, "ocr", 0.91));
            }
            LastOcrCount = result.Count; LastOcrStatus = "ok";
        }
        catch (Exception ex) { LastOcrStatus = ex.GetType().Name + ": " + ex.Message; LastOcrCount = 0; }
        return result;
    }

    static IEnumerable<SemanticElement> DetectRegions(Bitmap bitmap, Rectangle origin, IEnumerable<SemanticElement> known)
    {
        var maxWidth = 420; var scale = Math.Min(1.0, (double)maxWidth / bitmap.Width); var w = Math.Max(2, (int)(bitmap.Width * scale)); var h = Math.Max(2, (int)(bitmap.Height * scale));
        using var small = new Bitmap(w, h); using (var g = Graphics.FromImage(small)) g.DrawImage(bitmap, 0, 0, w, h);
        var values = new byte[w * h];
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var c = small.GetPixel(x, y); values[y * w + x] = (byte)((c.R * 30 + c.G * 59 + c.B * 11) / 100); }
        var edge = new bool[w * h];
        for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) { var i = y * w + x; edge[i] = Math.Abs(values[i + 1] - values[i - 1]) + Math.Abs(values[i + w] - values[i - w]) > 75; }
        var outlined = new List<SemanticElement>();
        for (var y = 4; y < h - 14; y += 2) for (var x = 4; x < w - 18; x += 2)
        {
            if (!edge[y * w + x]) continue;
            for (var rw = 22; rw <= Math.Min(w - x - 2, 360); rw += 4)
            {
                if (!edge[y * w + x + rw]) continue;
                for (var rh = 12; rh <= Math.Min(h - y - 2, 140); rh += 3)
                {
                    var topHits = 0; var bottomHits = 0; for (var xx = x; xx <= x + rw; xx += 3) { if (edge[y * w + xx]) topHits++; if (edge[(y + rh) * w + xx]) bottomHits++; }
                    var leftHits = 0; var rightHits = 0; for (var yy = y; yy <= y + rh; yy += 3) { if (edge[yy * w + x]) leftHits++; if (edge[yy * w + x + rw]) rightHits++; }
                    var hNeed = Math.Max(3, rw / 3 * 55 / 100); var vNeed = Math.Max(3, rh / 3 * 55 / 100);
                    if (topHits < hNeed || bottomHits < hNeed || leftHits < vNeed || rightHits < vNeed) continue;
                    var left = origin.Left + (int)(x / scale); var top = origin.Top + (int)(y / scale); var width = (int)(rw / scale); var height = (int)(rh / scale);
                    if (outlined.Any(o => Overlap(o, left, top, width, height) > .8)) continue;
                    var label = known.Where(k => k.Source == "ocr" && k.Left >= left - 8 && k.Top >= top - 8 && k.Left + k.Width <= left + width + 8 && k.Top + k.Height <= top + height + 8).OrderByDescending(k => k.Confidence).FirstOrDefault();
                    var role = width > height * 3 ? "field_or_button" : "button_or_icon"; var text = label?.Text ?? "";
                    outlined.Add(new SemanticElement(MakeId("vision", role, text, left, top, width, height), role, text, left, top, width, height, "local_cv", text.Length > 0 ? .78 : .64));
                    if (outlined.Count >= 40) break;
                }
                if (outlined.Count >= 40) break;
            }
            if (outlined.Count >= 40) break;
        }
        for (var pass = 0; pass < 2; pass++) { var next = (bool[])edge.Clone(); for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) { var i = y * w + x; if (edge[i]) { next[i - 1] = next[i + 1] = next[i - w] = next[i + w] = true; } } edge = next; }
        var seen = new bool[edge.Length]; var regions = new List<SemanticElement>(); var knownList = known.ToList();
        for (var start = 0; start < edge.Length; start++)
        {
            if (!edge[start] || seen[start]) continue;
            var q = new Queue<int>(); q.Enqueue(start); seen[start] = true; var count = 0; var minX = w; var minY = h; var maxX = 0; var maxY = 0;
            while (q.Count > 0) { var i = q.Dequeue(); count++; var x = i % w; var y = i / w; minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y); foreach (var n in new[] { i - 1, i + 1, i - w, i + w }) if (n >= 0 && n < edge.Length && !seen[n] && edge[n] && Math.Abs(n % w - x) <= 1) { seen[n] = true; q.Enqueue(n); } }
            var bw = maxX - minX + 1; var bh = maxY - minY + 1; if (count < 18 || bw < 18 || bh < 10 || bw > w * .96 || bh > h * .96) continue;
            var left = origin.Left + (int)(minX / scale); var top = origin.Top + (int)(minY / scale); var width = (int)(bw / scale); var height = (int)(bh / scale);
            if (knownList.Any(k => Overlap(k, left, top, width, height) > .72)) continue;
            var role = width > height * 2.5 ? "field_or_button" : Math.Abs(width - height) < Math.Max(width, height) * .35 ? "icon" : "region";
            regions.Add(new SemanticElement(MakeId("vision", role, "", left, top, width, height), role, "", left, top, width, height, "local_cv", 0.58));
            if (regions.Count >= 80) break;
        }
        return regions;
    }

    static SemanticElement[] MergeElements(IEnumerable<SemanticElement> elements)
    {
        var ordered = elements.OrderByDescending(e => e.Selector != null).ThenByDescending(e => e.Confidence).ToList(); var result = new List<SemanticElement>();
        foreach (var e in ordered)
        {
            var duplicate = result.Any(x => Overlap(x, e.Left, e.Top, e.Width, e.Height) > .72 && (string.IsNullOrEmpty(e.Text) || string.IsNullOrEmpty(x.Text) || x.Text.Contains(e.Text, StringComparison.OrdinalIgnoreCase) || e.Text.Contains(x.Text, StringComparison.OrdinalIgnoreCase)));
            if (!duplicate) result.Add(e);
        }
        return result.OrderBy(e => e.Top).ThenBy(e => e.Left).ToArray();
    }

    static object PublicElement(SemanticElement e) => new { id = e.Id, role = e.Role, text = e.Text, bounds = new { left = e.Left, top = e.Top, width = e.Width, height = e.Height, centerX = e.Left + e.Width / 2, centerY = e.Top + e.Height / 2 }, source = e.Source, confidence = e.Confidence, enabled = e.Enabled, selector = e.Selector };
    static string GuessRole(string text, int left, int top, int width, int height, Rectangle window) { var t = text.ToLowerInvariant(); if (t.Contains("搜索") || t.Contains("search")) return "search"; if (t is "发送" or "send" or "确定" or "取消" or "登录" or "保存" or "打开") return "button_text"; if (top < window.Top + Math.Max(80, window.Height / 8)) return "toolbar_text"; return width > height * 2.8 ? "text_or_field" : "text"; }
    static string MakeId(string source, string role, string text, int left, int top, int width, int height) { var raw = $"{source}|{role}|{text}|{left / 4}|{top / 4}|{width / 4}|{height / 4}"; return "e_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..10]; }
    static double Overlap(SemanticElement a, int left, int top, int width, int height) { var x1 = Math.Max(a.Left, left); var y1 = Math.Max(a.Top, top); var x2 = Math.Min(a.Left + a.Width, left + width); var y2 = Math.Min(a.Top + a.Height, top + height); if (x2 <= x1 || y2 <= y1) return 0; var intersection = (double)(x2 - x1) * (y2 - y1); return intersection / Math.Min((double)a.Width * a.Height, (double)width * height); }

    static object ReadFocused()
    {
        return Automation.ReadFocused(BoundWindow);
    }

    static object FindElement(JsonObject req)
    {
        var id = req["elementId"]?.GetValue<string>(); var text = req["text"]?.GetValue<string>() ?? ""; var role = req["role"]?.GetValue<string>() ?? "";
        var matches = ElementCache.Values.Where(e => (string.IsNullOrEmpty(id) || e.Id == id) && (string.IsNullOrEmpty(text) || e.Text.Contains(text, StringComparison.OrdinalIgnoreCase)) && (string.IsNullOrEmpty(role) || e.Role.Contains(role, StringComparison.OrdinalIgnoreCase))).OrderByDescending(e => e.Confidence).Take(20).ToArray();
        return new { count = matches.Length, elements = matches.Select(PublicElement).ToArray() };
    }

    static object ClickElement(JsonObject req)
    {
        ThrowIfCancelled();
        var element = ResolveElement(req); var duration = Math.Clamp(req["durationMs"]?.GetValue<int>() ?? 100, 0, 5000); var method = "pointer"; var before = CaptureBoundFrame();
        AutomationActionResult? automation = null;
        var forcePointer = req["forcePointer"]?.GetValue<bool>() ?? false;
        if (element.Selector != null && !forcePointer)
        {
            automation = Automation.Click(element.Selector, ThrowIfCancelled);
            if (automation.Success)
            {
                method = automation.Method;
            }
            else if (!automation.RequiresInputFallback)
                throw new InvalidOperationException($"UI Automation click failed at {automation.ErrorStage}: {automation.Error}");
            else
                element = RelocateBounds(element, automation.Selector);
        }
        if (method == "pointer")
        {
            lock (InputLock)
            {
                using var input = new InputLease();
                HumanMove(element.Left + element.Width / 2, element.Top + element.Height / 2, duration);
                input.Click(req["button"]?.GetValue<string>() ?? "left");
            }
        }
        Thread.Sleep(Math.Clamp(req["settleMs"]?.GetValue<int>() ?? 100, 0, 2000));
        var foreground = GetForegroundWindow(); FollowForegroundWindow(foreground); var stillBound = foreground == BoundWindow; var after = stillBound ? CaptureBoundFrame() : before;
        var changed = stillBound ? FrameDifference(before, after) : 1;
        var effectObserved = !stillBound || changed >= 0.0005;
        ElementCache.Clear(); ObservationToken = "";
        return new { element = PublicElement(element), method, automation, effectObserved, foregroundVerified = stillBound, foreground = WindowInfo(foreground), changedRatio = changed, beforeHash = before.Hash, afterHash = stillBound ? after.Hash : "window-transition" };
    }

    static object TypeElement(JsonObject req)
    {
        ThrowIfCancelled();
        var element = ResolveElement(req); var text = Required(req, "text"); var replace = req["replace"]?.GetValue<bool>() ?? true; var method = "keyboard"; var before = CaptureBoundFrame();
        AutomationActionResult? automation = null;
        if (element.Selector != null)
        {
            automation = Automation.Type(element.Selector, text, replace, ThrowIfCancelled);
            if (automation.Success) method = automation.Method;
            else if (!automation.RequiresInputFallback)
                throw new InvalidOperationException($"UI Automation typing failed at {automation.ErrorStage}: {automation.Error}");
            else
                element = RelocateBounds(element, automation.Selector);
        }
        if (method == "keyboard")
        {
            lock (InputLock)
            {
                using var input = new InputLease();
                HumanMove(element.Left + element.Width / 2, element.Top + element.Height / 2, 80); input.Click("left"); Thread.Sleep(50);
                if (replace) input.Hotkey([0x11, 0x41]);
                foreach (var rune in text.EnumerateRunes()) { ThrowIfCancelled(); foreach (var c in rune.ToString()) input.Unicode(c); }
            }
        }
        Thread.Sleep(100); if (GetForegroundWindow() != BoundWindow) throw new InvalidOperationException("Target window lost foreground during element typing.");
        var after = CaptureBoundFrame(); var focused = ReadFocused(); ElementCache.Clear(); ObservationToken = "";
        return new { chars = text.Length, method, automation, element = PublicElement(element), focused, foregroundVerified = true, changedRatio = FrameDifference(before, after), beforeHash = before.Hash, afterHash = after.Hash };
    }

    static SemanticElement RelocateBounds(SemanticElement element, AutomationSelector selector) => element with
    {
        Left = selector.Left,
        Top = selector.Top,
        Width = selector.Width,
        Height = selector.Height,
        Source = selector.Backend,
        Selector = selector,
    };

    static SemanticElement ResolveElement(JsonObject req)
    {
        EnsureBoundForeground(req);
        var id = Required(req, "elementId");
        if (!ElementCache.TryGetValue(id, out var element)) throw new InvalidOperationException($"Element not found or stale: {id}. Call observe again.");
        var expectedRole = req["role"]?.GetValue<string>() ?? "";
        if (!string.IsNullOrEmpty(expectedRole) && !element.Role.Contains(expectedRole, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException($"Element role mismatch: expected {expectedRole}, got {element.Role}");
        var center = new Point(element.Left + element.Width / 2, element.Top + element.Height / 2);
        if (!BoundBounds.Contains(center)) throw new InvalidOperationException("Cached element is outside the bound window.");
        return element;
    }

    static async Task<object> WaitChange(JsonObject req)
    {
        EnsureBoundForeground(req);
        var timeout = Math.Clamp(req["timeoutMs"]?.GetValue<int>() ?? 3000, 100, 60000); var threshold = Math.Clamp((req["threshold"]?.GetValue<int>() ?? 10) / 1000.0, .001, 1); var initial = CaptureBoundFrame(); var sw = Stopwatch.StartNew();
        do
        {
            ThrowIfCancelled();
            await Task.Delay(80);
            if (!IsWindow(BoundWindow)) return new { changed = true, reason = "window_closed", changedRatio = 1.0, frameHash = "window-closed", waitedMs = sw.ElapsedMilliseconds };
            if (GetForegroundWindow() != BoundWindow) return new { changed = true, reason = "foreground_transition", changedRatio = 1.0, foreground = WindowInfo(GetForegroundWindow()), frameHash = "window-transition", waitedMs = sw.ElapsedMilliseconds };
            var current = CaptureBoundFrame(); var ratio = FrameDifference(initial, current);
            if (ratio >= threshold) { LastFrame = current; return new { changed = true, reason = "frame_change", changedRatio = ratio, frameHash = current.Hash, waitedMs = sw.ElapsedMilliseconds }; }
        } while (sw.ElapsedMilliseconds < timeout);
        return new { changed = false, reason = "timeout", changedRatio = 0, frameHash = initial.Hash, waitedMs = sw.ElapsedMilliseconds };
    }

    static object Activate(JsonObject req)
    {
        var h = ResolveRequestedWindow(req, true);
        ForceForeground(h); Thread.Sleep(120);
        if (GetForegroundWindow() != h) { ForceForeground(h); Thread.Sleep(120); }
        if (GetForegroundWindow() != h) throw new InvalidOperationException($"Foreground verification failed for handle {h.ToInt64()}.");
        BindToWindow(h);
        return new { verified = true, session = SessionState(), window = WindowInfo(h) };
    }

    static object Minimize(JsonObject req)
    {
        ThrowIfCancelled();
        var h = ResolveRequestedWindow(req, true);
        ShowWindow(h, 6);
        var sw = Stopwatch.StartNew();
        while (!IsIconic(h) && sw.ElapsedMilliseconds < 1000) Thread.Sleep(25);
        if (!IsIconic(h)) throw new InvalidOperationException($"Window did not minimize: {h.ToInt64()}.");
        if (h == BoundWindow) { ElementCache.Clear(); ObservationToken = ""; LastFrame = null; }
        return new { verified = true, minimized = true, window = WindowInfo(h), elapsedMs = sw.ElapsedMilliseconds };
    }

    static object BindWindow(JsonObject req)
    {
        var h = ResolveRequestedWindow(req, true);
        if (req["activate"]?.GetValue<bool>() ?? true) ForceForeground(h);
        if (GetForegroundWindow() != h) throw new InvalidOperationException($"Target is not foreground: {h.ToInt64()}.");
        BindToWindow(h);
        return SessionState();
    }

    static void BindToWindow(IntPtr h)
    {
        if (!IsWindow(h) || !GetWindowRect(h, out var wr)) throw new InvalidOperationException("Target window is invalid.");
        BoundWindow = h; BoundBounds = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
        ObservationEpoch = 0; ObservationToken = ""; ElementCache.Clear(); LastFrame = null;
    }

    static object SessionState()
    {
        var valid = BoundWindow != IntPtr.Zero && IsWindow(BoundWindow);
        var foreground = valid && GetForegroundWindow() == BoundWindow;
        Rectangle current = Rectangle.Empty;
        if (valid && GetWindowRect(BoundWindow, out var wr)) current = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
        return new { bound = valid, foreground, handle = valid ? BoundWindow.ToInt64() : 0, observationToken = ObservationToken, epoch = ObservationEpoch, bounds = Rect(current), geometryChanged = valid && current != BoundBounds };
    }

    static IntPtr ResolveRequestedWindow(JsonObject req, bool required)
    {
        var query = req["window"]?.GetValue<string>() ?? "";
        var process = req["process"]?.GetValue<string>() ?? "";
        var handle = req["handle"]?.GetValue<long>() ?? 0;
        var h = handle != 0 ? new IntPtr(handle) : (!string.IsNullOrWhiteSpace(query) || !string.IsNullOrWhiteSpace(process) ? FindWindow(query, process) : BoundWindow);
        if (h != IntPtr.Zero && !IsWindow(h)) h = IntPtr.Zero;
        if (required && h == IntPtr.Zero) throw new InvalidOperationException($"Window not found: {query} {process} {handle}".Trim());
        return h;
    }

    static string MakeObservationToken(IntPtr h, Rectangle b, string hash, long epoch)
    {
        var raw = $"{h.ToInt64()}|{b.Left}|{b.Top}|{b.Width}|{b.Height}|{hash}|{epoch}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16];
    }

    static void ForceForeground(IntPtr h)
    {
        ShowWindow(h, 9); var fg = GetForegroundWindow();
        var currentThread = GetCurrentThreadId(); var targetThread = GetWindowThreadProcessId(h, out _); var fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out _);
        try { if (fgThread != 0 && fgThread != currentThread) AttachThreadInput(currentThread, fgThread, true); if (targetThread != currentThread) AttachThreadInput(currentThread, targetThread, true); BringWindowToTop(h); SetForegroundWindow(h); SetFocus(h); }
        finally { if (targetThread != currentThread) AttachThreadInput(currentThread, targetThread, false); if (fgThread != 0 && fgThread != currentThread) AttachThreadInput(currentThread, fgThread, false); }
    }

    static object Move(JsonObject req)
    {
        ThrowIfCancelled();
        var point = ResolvePoint(req, true)!.Value; var duration = Math.Clamp(req["durationMs"]?.GetValue<int>() ?? 120, 0, 5000);
        EnsureBoundForeground(req); lock (InputLock) HumanMove(point.X, point.Y, duration);
        return new { x = point.X, y = point.Y, relativeX = point.X - BoundBounds.Left, relativeY = point.Y - BoundBounds.Top, verifiedWindow = BoundWindow.ToInt64() };
    }

    static object Click(JsonObject req)
    {
        ThrowIfCancelled();
        var point = ResolvePoint(req, false);
        var button = req["button"]?.GetValue<string>()?.ToLowerInvariant() ?? "left";
        var count = Math.Clamp(req["count"]?.GetValue<int>() ?? 1, 1, 3);
        EnsureBoundForeground(req); var before = CaptureBoundFrame();
        lock (InputLock)
        {
            using var input = new InputLease();
            if (point.HasValue) HumanMove(point.Value.X, point.Value.Y, Math.Clamp(req["durationMs"]?.GetValue<int>() ?? 100, 0, 5000));
            for (var i = 0; i < count; i++) { input.Click(button); if (i + 1 < count) Thread.Sleep(70); }
        }
        Thread.Sleep(Math.Clamp(req["settleMs"]?.GetValue<int>() ?? 80, 0, 2000));
        var foreground = GetForegroundWindow(); FollowForegroundWindow(foreground); var foregroundVerified = foreground == BoundWindow; var after = CaptureBoundFrame();
        if (!foregroundVerified) throw new InvalidOperationException("Target window lost foreground during click.");
        GetCursorPos(out var p); return new { x = p.X, y = p.Y, relativeX = p.X - BoundBounds.Left, relativeY = p.Y - BoundBounds.Top, button, count, foregroundVerified, changedRatio = FrameDifference(before, after), beforeHash = before.Hash, afterHash = after.Hash };
    }

    static object Drag(JsonObject req)
    {
        ThrowIfCancelled();
        var from = ResolvePoint(req, true)!.Value;
        var toX = req["toRelativeX"]?.GetValue<int>(); var toY = req["toRelativeY"]?.GetValue<int>();
        var to = toX.HasValue && toY.HasValue
            ? new Point(BoundBounds.Left + toX.Value, BoundBounds.Top + toY.Value)
            : new Point(req["toX"]?.GetValue<int>() ?? throw new InvalidOperationException("toX is required."), req["toY"]?.GetValue<int>() ?? throw new InvalidOperationException("toY is required."));
        if (!BoundBounds.Contains(to)) throw new InvalidOperationException($"Drag destination is outside bound window: {to.X},{to.Y}.");
        var duration = Math.Clamp(req["durationMs"]?.GetValue<int>() ?? 260, 20, 5000);
        var button = req["button"]?.GetValue<string>()?.ToLowerInvariant() ?? "left";
        EnsureBoundForeground(req); var before = CaptureBoundFrame();
        lock (InputLock)
        {
            using var input = new InputLease();
            HumanMove(from.X, from.Y, Math.Min(120, duration / 3));
            input.MouseDown(button);
            try { HumanMove(to.X, to.Y, duration); }
            finally { input.MouseUp(button); }
        }
        Thread.Sleep(Math.Clamp(req["settleMs"]?.GetValue<int>() ?? 100, 0, 2000));
        if (GetForegroundWindow() != BoundWindow) throw new InvalidOperationException("Target window lost foreground during drag.");
        var after = CaptureBoundFrame(); GetCursorPos(out var cursor);
        return new { fromX = from.X, fromY = from.Y, toX = to.X, toY = to.Y, relativeFromX = from.X - BoundBounds.Left, relativeFromY = from.Y - BoundBounds.Top, relativeToX = to.X - BoundBounds.Left, relativeToY = to.Y - BoundBounds.Top, button, foregroundVerified = true, cursorX = cursor.X, cursorY = cursor.Y, changedRatio = FrameDifference(before, after), beforeHash = before.Hash, afterHash = after.Hash };
    }

    static Point? ResolvePoint(JsonObject req, bool required)
    {
        var rx = req["relativeX"]?.GetValue<int>(); var ry = req["relativeY"]?.GetValue<int>();
        var x = req["x"]?.GetValue<int>(); var y = req["y"]?.GetValue<int>();
        Point? point = rx.HasValue && ry.HasValue ? new Point(BoundBounds.Left + rx.Value, BoundBounds.Top + ry.Value) : (x.HasValue && y.HasValue ? new Point(x.Value, y.Value) : null);
        if (required && !point.HasValue) throw new InvalidOperationException("Coordinates are required.");
        if (point.HasValue && !BoundBounds.Contains(point.Value)) throw new InvalidOperationException($"Point is outside bound window: {point.Value.X},{point.Value.Y}.");
        return point;
    }

    static object TypeText(JsonObject req)
    {
        var text = Required(req, "text"); var interval = Math.Clamp(req["intervalMs"]?.GetValue<int>() ?? 0, 0, 500);
        EnsureBoundForeground(req); var before = CaptureBoundFrame(); var focusedBefore = ReadFocused();
        lock (InputLock)
        {
            using var input = new InputLease();
            foreach (var rune in text.EnumerateRunes())
            {
                ThrowIfCancelled();
                foreach (var c in rune.ToString()) input.Unicode(c);
                if (interval > 0) Thread.Sleep(interval);
            }
        }
        Thread.Sleep(80); if (GetForegroundWindow() != BoundWindow) throw new InvalidOperationException("Target window lost foreground during typing.");
        var after = CaptureBoundFrame(); var focusedAfter = ReadFocused();
        return new { chars = text.Length, foregroundVerified = true, focusedBefore, focusedAfter, changedRatio = FrameDifference(before, after), beforeHash = before.Hash, afterHash = after.Hash };
    }

    static object Key(JsonObject req)
    {
        ThrowIfCancelled();
        var key = Required(req, "key"); var count = Math.Clamp(req["count"]?.GetValue<int>() ?? 1, 1, 50);
        EnsureBoundForeground(req); var before = CaptureBoundFrame();
        lock (InputLock)
        {
            using var input = new InputLease();
            for (var i = 0; i < count; i++) { input.Tap(ParseKey(key)); Thread.Sleep(25); }
        }
        Thread.Sleep(80); var after = CaptureBoundFrame();
        if (GetForegroundWindow() != BoundWindow) throw new InvalidOperationException("Target window lost foreground during key action.");
        return new { key, count, foregroundVerified = true, changedRatio = FrameDifference(before, after), beforeHash = before.Hash, afterHash = after.Hash };
    }

    static void EnsureBoundForeground(JsonObject req)
    {
        if (BoundWindow == IntPtr.Zero || !IsWindow(BoundWindow)) throw new InvalidOperationException("No bound window. Call activate or bind_window first.");
        if (!GetWindowRect(BoundWindow, out var wr)) throw new InvalidOperationException("Bound window geometry is unavailable.");
        var current = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
        if (current != BoundBounds)
        {
            BoundBounds = current; ElementCache.Clear(); ObservationToken = "";
            if (!(req["allowGeometryChange"]?.GetValue<bool>() ?? false)) throw new InvalidOperationException("Bound window moved or resized. Observe again before input.");
        }
        if (GetForegroundWindow() != BoundWindow)
        {
            if (req["autoActivate"]?.GetValue<bool>() ?? false) { ForceForeground(BoundWindow); Thread.Sleep(80); }
            if (GetForegroundWindow() != BoundWindow) throw new InvalidOperationException("Bound window is not foreground.");
        }
        var token = req["observationToken"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(token) && token != ObservationToken) throw new InvalidOperationException("Observation token is stale. Observe again.");
    }

    static bool FollowForegroundWindow(IntPtr foreground)
    {
        if (foreground == IntPtr.Zero || foreground == BoundWindow || !IsWindow(foreground) || BoundWindow == IntPtr.Zero) return false;
        GetWindowThreadProcessId(BoundWindow, out var boundPid);
        GetWindowThreadProcessId(foreground, out var foregroundPid);
        if (boundPid == 0 || boundPid != foregroundPid) return false;
        BindToWindow(foreground);
        return true;
    }

    static FrameState CaptureBoundFrame()
    {
        using var bitmap = CaptureForeground(BoundWindow, out _); return MakeFrameState(bitmap);
    }

    static object Hotkey(JsonObject req)
    {
        ThrowIfCancelled();
        EnsureBoundForeground(req);
        var keys = req["keys"]?.AsArray().Select(x => ParseKey(x?.GetValue<string>() ?? "")).ToArray() ?? throw new InvalidOperationException("keys is required");
        if (keys.Length < 1) throw new InvalidOperationException("keys is empty");
        if (!(req["allowClose"]?.GetValue<bool>() ?? false) && keys.Contains((ushort)0x12) && keys.Contains((ushort)0x73))
            throw new InvalidOperationException("ALT+F4 is blocked because it closes the target window. Use minimize to move an app to the background, or set allowClose=true explicitly.");
        lock (InputLock)
        {
            using var input = new InputLease();
            input.Hotkey(keys);
        }
        return new { keys = req["keys"] };
    }

    static object Scroll(JsonObject req)
    {
        ThrowIfCancelled();
        EnsureBoundForeground(req);
        var delta = req["delta"]?.GetValue<int>() ?? -3;
        lock (InputLock) InputLease.Wheel(delta * 120);
        return new { delta };
    }

    static object Wait(JsonObject req)
    {
        var text = Required(req, "text"); var timeout = Math.Clamp(req["timeoutMs"]?.GetValue<int>() ?? 5000, 100, 60000);
        var sw = Stopwatch.StartNew();
        do { ThrowIfCancelled(); if (ForegroundContains(text)) return new { found = true, text, waitedMs = sw.ElapsedMilliseconds }; Thread.Sleep(100); } while (sw.ElapsedMilliseconds < timeout);
        return new { found = false, text, waitedMs = sw.ElapsedMilliseconds };
    }

    static async Task<object> Batch(JsonObject req)
    {
        var actions = req["actions"]?.AsArray() ?? throw new InvalidOperationException("actions is required");
        if (actions.Count > 24) throw new InvalidOperationException("Batch is limited to 24 actions. Observe between batches.");
        TotalSteps = actions.Count;
        var results = new List<object>(); var sw = Stopwatch.StartNew();
        foreach (var node in actions)
        {
            ThrowIfCancelled();
            var a = node?.AsObject() ?? throw new InvalidOperationException("Invalid batch action");
            var name = Required(a, "action");
            ActiveStep++;
            ActiveAction = name;
            object result = name switch { "activate" => Activate(a), "minimize" => Minimize(a), "click" => Click(a), "drag" => Drag(a), "click_element" => ClickElement(a), "type_element" => TypeElement(a), "find_element" => FindElement(a), "move" => Move(a), "type" => TypeText(a), "key" => Key(a), "hotkey" => Hotkey(a), "scroll" => Scroll(a), "wait" => Wait(a), "wait_change" => WaitChange(a).GetAwaiter().GetResult(), _ => throw new InvalidOperationException($"Unsupported batch action: {name}") };
            results.Add(new { action = name, result });
            var resultNode = JsonSerializer.SerializeToNode(result, JsonOptions);
            if (resultNode?["found"] is JsonValue found && found.TryGetValue<bool>(out var matched) && !matched) throw new InvalidOperationException($"Step {ActiveStep} ({name}) did not find its target; batch stopped.");
            var pause = Math.Clamp(a["pauseMs"]?.GetValue<int>() ?? 0, 0, 5000);
            var pauseClock = Stopwatch.StartNew();
            while (pauseClock.ElapsedMilliseconds < pause) { ThrowIfCancelled(); await Task.Delay(20); }
        }
        object? verification = null;
        if (req["verifyText"] is JsonNode v)
        {
            var text = v.GetValue<string>();
            var semanticFound = ForegroundContains(text);
            var visualFound = false;
            if (!semanticFound && BoundWindow != IntPtr.Zero && IsWindow(BoundWindow))
            {
                using var frame = CaptureForeground(BoundWindow, out var bounds);
                var ocr = await OcrElements(frame, bounds);
                visualFound = ocr.Any(e => e.Text.Contains(text, StringComparison.OrdinalIgnoreCase));
            }
            if (!semanticFound && !visualFound) throw new InvalidOperationException($"Batch input completed but verification text was not found: {text}");
            verification = new { text, found = true, method = semanticFound ? "uia" : "ocr" };
        }
        return new { elapsedMs = sw.ElapsedMilliseconds, results, verification };
    }

    static bool ForegroundContains(string text)
    {
        var h = GetForegroundWindow(); if (h == IntPtr.Zero) return false;
        if ((GetWindowText(h) ?? "").Contains(text, StringComparison.OrdinalIgnoreCase)) return true;
        if (Automation.Contains(h, text, out _, out _)) return true;
        if (ElementCache.Values.Any(e => e.Text.Contains(text, StringComparison.OrdinalIgnoreCase))) return true;
        return false;
    }

    static IEnumerable<object> EnumWindowsSnapshot()
    {
        var list = new List<object>();
        EnumWindows((h, _) => { if (IsWindowVisible(h)) { var title = GetWindowText(h); if (!string.IsNullOrWhiteSpace(title)) list.Add(WindowInfo(h)); } return true; }, IntPtr.Zero);
        return list;
    }

    static IntPtr FindWindow(string query, string process = "")
    {
        IntPtr found = IntPtr.Zero; long bestScore = long.MinValue;
        EnumWindows((h, _) => {
            var title = GetWindowText(h);
            var titleMatch = string.IsNullOrEmpty(query) || title.Contains(query, StringComparison.OrdinalIgnoreCase);
            var processMatch = string.IsNullOrEmpty(process);
            if (!processMatch) { try { GetWindowThreadProcessId(h, out var pid); processMatch = Process.GetProcessById((int)pid).ProcessName.Contains(process, StringComparison.OrdinalIgnoreCase); } catch { } }
            if (!titleMatch || !processMatch) return true;
            var visible = IsWindowVisible(h);
            // Background apps such as Weixin keep their logged-in main window
            // hidden in the tray. Accept a hidden match when a process/title
            // filter was supplied. Prefer visible, titled and large app windows
            // over the process's IME/message-only helper windows.
            long area = 0;
            if (GetWindowRect(h, out var rect)) area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
            var score = (visible ? 1_000_000_000L : 0) + (!string.IsNullOrWhiteSpace(title) ? 100_000_000L : 0) + Math.Min(area, 99_999_999L);
            if (score > bestScore) { found = h; bestScore = score; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static object WindowInfo(IntPtr h)
    {
        if (h == IntPtr.Zero) return new { handle = 0L, title = "", process = "", pid = 0, bounds = Rect(new Rectangle()) };
        GetWindowThreadProcessId(h, out var pid); GetWindowRect(h, out var r);
        string process = ""; try { process = Process.GetProcessById((int)pid).ProcessName; } catch { }
        return new { handle = h.ToInt64(), title = GetWindowText(h), process, pid, bounds = new { left = r.Left, top = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top } };
    }

    static void HumanMove(int tx, int ty, int durationMs)
    {
        GetCursorPos(out var p); if (durationMs <= 0) { SetCursorPos(tx, ty); return; }
        var steps = Math.Max(2, durationMs / 12); var rand = Random.Shared;
        for (var i = 1; i <= steps; i++)
        {
            ThrowIfCancelled();
            var t = (double)i / steps; var eased = t * t * (3 - 2 * t);
            var jitter = i == steps ? 0 : rand.NextDouble() * 1.8 - .9;
            SetCursorPos((int)Math.Round(p.X + (tx - p.X) * eased + jitter), (int)Math.Round(p.Y + (ty - p.Y) * eased + jitter));
            Thread.Sleep(Math.Max(1, durationMs / steps));
        }
    }

    static ushort ParseKey(string key)
    {
        var k = key.Trim().ToUpperInvariant();
        if (k.Length == 1 && char.IsLetterOrDigit(k[0])) return (ushort)k[0];
        return k switch { "CTRL" or "CONTROL" => 0x11, "SHIFT" => 0x10, "ALT" => 0x12, "WIN" or "META" => 0x5B, "ENTER" or "RETURN" => 0x0D, "TAB" => 0x09, "ESC" or "ESCAPE" => 0x1B, "SPACE" => 0x20, "BACKSPACE" => 0x08, "DELETE" => 0x2E, "UP" => 0x26, "DOWN" => 0x28, "LEFT" => 0x25, "RIGHT" => 0x27, "HOME" => 0x24, "END" => 0x23, "PAGEDOWN" => 0x22, "PAGEUP" => 0x21, _ when k.StartsWith('F') && int.TryParse(k[1..], out var n) && n is >= 1 and <= 24 => (ushort)(0x70 + n - 1), _ => throw new InvalidOperationException($"Unknown key: {key}") };
    }

    sealed class InputLease : IDisposable
    {
        static readonly object ActiveLock = new();
        static InputLease? Active;
        readonly object gate = new();
        readonly HashSet<ushort> pressedKeys = [];
        readonly HashSet<string> pressedButtons = new(StringComparer.OrdinalIgnoreCase);
        bool disposed;

        public InputLease()
        {
            lock (ActiveLock)
            {
                Active?.ReleaseAllCore();
                Active = this;
            }
        }

        public static void ReleaseActive()
        {
            lock (ActiveLock) Active?.ReleaseAllCore();
        }

        public void MouseDown(string button)
        {
            lock (gate)
            {
                EnsureOpen(); pressedButtons.Add(button); SendMouse(MouseFlag(button, false));
            }
        }

        public void MouseUp(string button)
        {
            lock (gate)
            {
                SendMouse(MouseFlag(button, true)); pressedButtons.Remove(button);
            }
        }

        public void Click(string button)
        {
            MouseDown(button);
            try { Thread.Sleep(Random.Shared.Next(35, 75)); }
            finally { MouseUp(button); }
        }

        public void KeyDown(ushort key)
        {
            lock (gate)
            {
                EnsureOpen(); pressedKeys.Add(key); SendKeyboard(key, false);
            }
        }

        public void KeyUp(ushort key)
        {
            lock (gate)
            {
                SendKeyboard(key, true); pressedKeys.Remove(key);
            }
        }

        public void Tap(ushort key)
        {
            KeyDown(key);
            try { Thread.Sleep(25); }
            finally { KeyUp(key); }
        }

        public void Hotkey(IEnumerable<ushort> keys)
        {
            var ordered = keys.ToArray();
            try { foreach (var key in ordered) KeyDown(key); }
            finally { for (var i = ordered.Length - 1; i >= 0; i--) if (pressedKeys.Contains(ordered[i])) KeyUp(ordered[i]); }
        }

        public void Unicode(char value)
        {
            EnsureOpen();
            var inputs = new[]
            {
                new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wScan = value, dwFlags = 0x0004 } } },
                new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wScan = value, dwFlags = 0x0004 | 0x0002 } } },
            };
            var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
            if (sent != inputs.Length)
            {
                inputs[1].U.ki.dwFlags = 0x0004 | 0x0002;
                SendInput(1, [inputs[1]], Marshal.SizeOf<INPUT>());
                throw new InvalidOperationException($"SendInput unicode failed after {sent} event(s): {Marshal.GetLastWin32Error()}");
            }
        }

        public static void Wheel(int delta) => SendMouse(0x0800, delta);

        public void Dispose()
        {
            lock (ActiveLock)
            {
                ReleaseAllCore(); disposed = true;
                if (ReferenceEquals(Active, this)) Active = null;
            }
        }

        void ReleaseAllCore()
        {
            lock (gate)
            {
                foreach (var key in pressedKeys.Reverse().ToArray()) SendKeyboard(key, true, false);
                foreach (var button in pressedButtons.ToArray()) SendMouse(MouseFlag(button, true), 0, false);
                pressedKeys.Clear(); pressedButtons.Clear();
            }
        }

        void EnsureOpen()
        {
            if (disposed) throw new ObjectDisposedException(nameof(InputLease));
            ThrowIfCancelled();
        }

        static uint MouseFlag(string button, bool up) => button.ToLowerInvariant() switch
        {
            "right" => up ? 0x0010u : 0x0008u,
            "middle" => up ? 0x0040u : 0x0020u,
            "left" => up ? 0x0004u : 0x0002u,
            _ => throw new InvalidOperationException($"Unknown mouse button: {button}")
        };

        static void SendKeyboard(ushort key, bool up, bool throwOnFailure = true)
        {
            var input = new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = key, dwFlags = up ? 0x0002u : 0 } } };
            if (SendInput(1, [input], Marshal.SizeOf<INPUT>()) != 1 && throwOnFailure)
                throw new InvalidOperationException($"SendInput keyboard failed: {Marshal.GetLastWin32Error()}");
        }

        static void SendMouse(uint flags, int data = 0, bool throwOnFailure = true)
        {
            var input = new INPUT { type = 0, U = new InputUnion { mi = new MOUSEINPUT { mouseData = unchecked((uint)data), dwFlags = flags } } };
            if (SendInput(1, [input], Marshal.SizeOf<INPUT>()) != 1 && throwOnFailure)
                throw new InvalidOperationException($"SendInput mouse failed: {Marshal.GetLastWin32Error()}");
        }
    }

    static void ThrowIfCancelled()
    {
        if (Volatile.Read(ref Paused) != 0) throw new OperationCanceledException("Desktop input paused by user.");
        if (Volatile.Read(ref CancelRequested) != 0) throw new OperationCanceledException("Desktop action cancelled.");
    }

    static string Required(JsonObject o, string key) => o[key]?.GetValue<string>() is string s && !string.IsNullOrWhiteSpace(s) ? s : throw new InvalidOperationException($"{key} is required");
    static int RequiredInt(JsonObject o, string key) => o[key]?.GetValue<int>() ?? throw new InvalidOperationException($"{key} is required");
    static object Rect(Rectangle r) => new { left = r.Left, top = r.Top, width = r.Width, height = r.Height };
    static async Task Reply(HttpListenerContext c, int status, object payload) { var data = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions); c.Response.StatusCode = status; c.Response.ContentType = "application/json; charset=utf-8"; c.Response.ContentLength64 = data.Length; await c.Response.OutputStream.WriteAsync(data); c.Response.Close(); }
    static string GetWindowText(IntPtr h) { var n = GetWindowTextLength(h); var b = new StringBuilder(n + 1); _ = GetWindowText(h, b, b.Capacity); return b.ToString(); }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder b, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
}
