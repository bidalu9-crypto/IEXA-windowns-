using System.Diagnostics;
using System.Drawing;
using System.Security.Cryptography;
using System.Text;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Patterns;
using FlaUI.UIA2;
using FlaUI.UIA3;

namespace Iexa.DesktopAgent;

internal sealed record AutomationSelector(
    string Backend,
    long Hwnd,
    int ProcessId,
    int[] RuntimeId,
    string AutomationId,
    string ControlType,
    string Name,
    string ClassName,
    int Left,
    int Top,
    int Width,
    int Height,
    long Generation);

internal sealed record MatureElement(
    string Id,
    string Role,
    string Text,
    Rectangle Bounds,
    bool Enabled,
    AutomationSelector Selector);

internal sealed record AutomationObservation(
    string Backend,
    bool FallbackUsed,
    MatureElement[] Elements,
    string[] Diagnostics);

internal sealed record AutomationActionResult(
    bool Success,
    bool RequiresInputFallback,
    string Backend,
    string Method,
    AutomationSelector Selector,
    string ErrorStage = "",
    string Error = "");

internal sealed record FocusedElementResult(
    string Role,
    string Text,
    string Method,
    string AutomationId,
    string Backend,
    AutomationSelector? Selector,
    string Error = "");

/// <summary>
/// Owns the Windows UI Automation backends and all stable-selector logic.
/// UIA3 is preferred; UIA2 is retried when a provider is incompatible.
/// </summary>
internal sealed class MatureAutomation : IDisposable
{
    const int MaxVisited = 700;
    static readonly TimeSpan ProviderTimeout = TimeSpan.FromMilliseconds(900);
    static readonly TimeSpan ConnectionTimeout = TimeSpan.FromMilliseconds(900);

    readonly UIA3Automation uia3 = Configure(new UIA3Automation());
    // UIA2 intentionally keeps its framework defaults. Its COM API rejects
    // the UIA3-only transaction/connection timeout properties at runtime.
    readonly UIA2Automation uia2 = new();
    bool disposed;

    public AutomationObservation Observe(IntPtr hwnd, int limit, long generation, Action cancellationCheck)
    {
        var diagnostics = new List<string>();
        var primary = ObserveBackend(uia3, "uia3", hwnd, limit, generation, cancellationCheck, diagnostics);
        if (primary.Count > 1)
            return new AutomationObservation("uia3", false, primary.ToArray(), diagnostics.ToArray());

        var fallback = ObserveBackend(uia2, "uia2", hwnd, limit, generation, cancellationCheck, diagnostics);
        return fallback.Count > primary.Count
            ? new AutomationObservation("uia2", true, fallback.ToArray(), diagnostics.ToArray())
            : new AutomationObservation("uia3", false, primary.ToArray(), diagnostics.ToArray());
    }

    public AutomationActionResult Click(AutomationSelector selector, Action cancellationCheck)
    {
        return WithLocatedElement(selector, "click", cancellationCheck, (element, backend, resolved) =>
        {
            if (IsExplicitlyDisabled(element))
                return Failure(resolved, backend, "enabled-check", "The resolved UI Automation element is disabled.");

            if (element.Patterns.Invoke.TryGetPattern(out var invoke))
            {
                invoke.Invoke();
                return Success(resolved, backend, "uia_invoke");
            }
            if (element.Patterns.SelectionItem.TryGetPattern(out var selection))
            {
                selection.Select();
                return Success(resolved, backend, "uia_select");
            }
            if (element.Patterns.Toggle.TryGetPattern(out var toggle))
            {
                toggle.Toggle();
                return Success(resolved, backend, "uia_toggle");
            }
            if (element.Patterns.ExpandCollapse.TryGetPattern(out var expand))
            {
                expand.Expand();
                return Success(resolved, backend, "uia_expand");
            }
            if (element.Patterns.LegacyIAccessible.TryGetPattern(out var legacy))
            {
                legacy.DoDefaultAction();
                return Success(resolved, backend, "uia_legacy_default");
            }

            return new AutomationActionResult(false, true, backend, "pointer", resolved, "pattern-selection", "No actionable UI Automation pattern is exposed.");
        });
    }

    public AutomationActionResult Type(AutomationSelector selector, string text, bool replace, Action cancellationCheck)
    {
        return WithLocatedElement(selector, "type", cancellationCheck, (element, backend, resolved) =>
        {
            if (IsExplicitlyDisabled(element))
                return Failure(resolved, backend, "enabled-check", "The resolved UI Automation element is disabled.");

            if (element.Patterns.Value.TryGetPattern(out var value) && !value.IsReadOnly.ValueOrDefault)
            {
                var next = replace ? text : (value.Value.ValueOrDefault ?? "") + text;
                value.SetValue(next);
                return Success(resolved, backend, "uia_value");
            }
            if (element.Patterns.LegacyIAccessible.TryGetPattern(out var legacy))
            {
                var previous = replace ? "" : legacy.Value.ValueOrDefault ?? "";
                legacy.SetValue(previous + text);
                return Success(resolved, backend, "uia_legacy_value");
            }

            return new AutomationActionResult(false, true, backend, "keyboard", resolved, "pattern-selection", "No writable UI Automation value pattern is exposed.");
        });
    }

    public FocusedElementResult ReadFocused(IntPtr hwnd)
    {
        var errors = new List<string>();
        foreach (var (automation, backend) in Backends("uia3"))
        {
            try
            {
                var element = automation.FocusedElement();
                if (element is null) throw new InvalidOperationException("No focused element was returned.");
                var selector = CreateSelector(element, backend, hwnd, 0);
                var (text, method) = ReadText(element, 8192);
                return new FocusedElementResult(Role(element), text, method, element.Properties.AutomationId.ValueOrDefault ?? "", backend, selector);
            }
            catch (Exception ex) { errors.Add(Diagnostic(backend, "read-focused", ex)); }
        }
        return new FocusedElementResult("", "", "error", "", "none", null, string.Join(" | ", errors));
    }

    public bool Contains(IntPtr hwnd, string text, out string backend, out string diagnostic)
    {
        var errors = new List<string>();
        foreach (var (automation, name) in Backends("uia3"))
        {
            try
            {
                foreach (var element in Traverse(automation, hwnd, 900, 1600, static () => { }, errors, name))
                {
                    var (value, _) = ReadText(element, 4096);
                    if (value.Contains(text, StringComparison.OrdinalIgnoreCase))
                    {
                        backend = name;
                        diagnostic = string.Join(" | ", errors);
                        return true;
                    }
                }
            }
            catch (Exception ex) { errors.Add(Diagnostic(name, "contains", ex)); }
        }
        backend = "none";
        diagnostic = string.Join(" | ", errors);
        return false;
    }

    AutomationActionResult WithLocatedElement(
        AutomationSelector selector,
        string action,
        Action cancellationCheck,
        Func<AutomationElement, string, AutomationSelector, AutomationActionResult> execute)
    {
        var errors = new List<string>();
        AutomationActionResult? inputFallback = null;
        foreach (var (automation, backend) in Backends(selector.Backend))
        {
            cancellationCheck();
            try
            {
                var element = Locate(automation, backend, selector, cancellationCheck, errors);
                if (element is null)
                {
                    errors.Add($"[{backend}:{action}-locate] selector did not resolve");
                    continue;
                }
                var resolved = CreateSelector(element, backend, new IntPtr(selector.Hwnd), selector.Generation);
                try
                {
                    var result = execute(element, backend, resolved);
                    if (result.Success || !result.RequiresInputFallback) return result;
                    inputFallback = result;
                    errors.Add($"[{backend}:{action}-pattern] {result.Error}");
                }
                catch (Exception ex) { errors.Add(Diagnostic(backend, action + "-pattern", ex)); }
            }
            catch (Exception ex) { errors.Add(Diagnostic(backend, action + "-locate", ex)); }
        }
        return inputFallback is not null
            ? inputFallback with { Error = string.Join(" | ", errors) }
            : new AutomationActionResult(false, true, "none", action == "type" ? "keyboard" : "pointer", selector, action + "-locate", string.Join(" | ", errors));
    }

    AutomationElement? Locate(
        AutomationBase automation,
        string backend,
        AutomationSelector selector,
        Action cancellationCheck,
        List<string> diagnostics)
    {
        AutomationElement? best = null;
        var bestScore = int.MinValue;
        foreach (var candidate in Traverse(automation, new IntPtr(selector.Hwnd), MaxVisited, 1800, cancellationCheck, diagnostics, backend))
        {
            cancellationCheck();
            AutomationSelector current;
            try { current = CreateSelector(candidate, backend, new IntPtr(selector.Hwnd), selector.Generation); }
            catch (Exception ex) { diagnostics.Add(Diagnostic(backend, "selector-read", ex)); continue; }

            if (backend == selector.Backend && selector.RuntimeId.Length > 0 && current.RuntimeId.SequenceEqual(selector.RuntimeId))
                return candidate;

            var score = SelectorScore(selector, current);
            if (score > bestScore) { best = candidate; bestScore = score; }
        }
        return bestScore >= 90 ? best : null;
    }

    List<MatureElement> ObserveBackend(
        AutomationBase automation,
        string backend,
        IntPtr hwnd,
        int limit,
        long generation,
        Action cancellationCheck,
        List<string> diagnostics)
    {
        var result = new List<MatureElement>();
        try
        {
            foreach (var element in Traverse(automation, hwnd, MaxVisited, 1400, cancellationCheck, diagnostics, backend))
            {
                cancellationCheck();
                try
                {
                    var bounds = element.Properties.BoundingRectangle.ValueOrDefault;
                    if (bounds.Width < 2 || bounds.Height < 2 || IsExplicitlyOffscreen(element)) continue;
                    var selector = CreateSelector(element, backend, hwnd, generation);
                    var (text, _) = ReadText(element, 4096);
                    var role = Role(element);
                    result.Add(new MatureElement(StableId(selector), role, text.Trim(), bounds, !IsExplicitlyDisabled(element), selector));
                    if (result.Count >= limit) break;
                }
                catch (Exception ex) { diagnostics.Add(Diagnostic(backend, "element-read", ex)); }
            }
        }
        catch (Exception ex) { diagnostics.Add(Diagnostic(backend, "observe", ex)); }
        return result;
    }

    static IEnumerable<AutomationElement> Traverse(
        AutomationBase automation,
        IntPtr hwnd,
        int maxVisited,
        int deadlineMs,
        Action cancellationCheck,
        List<string> diagnostics,
        string backend)
    {
        var root = automation.FromHandle(hwnd) ?? throw new InvalidOperationException($"No {backend} root for hwnd {hwnd.ToInt64()}.");
        var walker = automation.TreeWalkerFactory.GetControlViewWalker();
        var pending = new Queue<AutomationElement>();
        pending.Enqueue(root);
        var clock = Stopwatch.StartNew();
        var visited = 0;
        while (pending.Count > 0 && visited++ < maxVisited && clock.ElapsedMilliseconds < deadlineMs)
        {
            cancellationCheck();
            var current = pending.Dequeue();
            yield return current;

            AutomationElement? child;
            try { child = walker.GetFirstChild(current); }
            catch (Exception ex) { diagnostics.Add(Diagnostic(backend, "first-child", ex)); continue; }
            while (child is not null && pending.Count < maxVisited && clock.ElapsedMilliseconds < deadlineMs)
            {
                pending.Enqueue(child);
                try { child = walker.GetNextSibling(child); }
                catch (Exception ex) { diagnostics.Add(Diagnostic(backend, "next-sibling", ex)); break; }
            }
        }
        if (clock.ElapsedMilliseconds >= deadlineMs)
            diagnostics.Add($"[{backend}:traverse] deadline reached after {clock.ElapsedMilliseconds} ms and {visited} elements");
    }

    static AutomationSelector CreateSelector(AutomationElement element, string backend, IntPtr hwnd, long generation)
    {
        var bounds = element.Properties.BoundingRectangle.ValueOrDefault;
        return new AutomationSelector(
            backend,
            hwnd.ToInt64(),
            element.Properties.ProcessId.ValueOrDefault,
            element.Properties.RuntimeId.ValueOrDefault ?? [],
            element.Properties.AutomationId.ValueOrDefault ?? "",
            element.Properties.ControlType.ValueOrDefault.ToString(),
            element.Properties.Name.ValueOrDefault ?? "",
            element.Properties.ClassName.ValueOrDefault ?? "",
            bounds.Left,
            bounds.Top,
            bounds.Width,
            bounds.Height,
            generation);
    }

    static (string Text, string Method) ReadText(AutomationElement element, int maxLength)
    {
        if (element.Patterns.Value.TryGetPattern(out var value))
        {
            var text = value.Value.ValueOrDefault ?? "";
            if (!string.IsNullOrWhiteSpace(text)) return (Trim(text, maxLength), "uia_value");
        }
        if (element.Patterns.Text.TryGetPattern(out var textPattern))
        {
            var text = textPattern.DocumentRange.GetText(maxLength).TrimEnd('\r', '\n', '\0');
            if (!string.IsNullOrWhiteSpace(text)) return (Trim(text, maxLength), "uia_text");
        }
        return (Trim(element.Properties.Name.ValueOrDefault ?? "", maxLength), "uia_name");
    }

    static int SelectorScore(AutomationSelector expected, AutomationSelector current)
    {
        if (expected.ProcessId != 0 && current.ProcessId != expected.ProcessId) return int.MinValue;
        var score = 0;
        if (!string.IsNullOrEmpty(expected.AutomationId) && expected.AutomationId == current.AutomationId) score += 90;
        if (expected.ControlType == current.ControlType) score += 30;
        if (!string.IsNullOrEmpty(expected.Name) && expected.Name == current.Name) score += 35;
        if (!string.IsNullOrEmpty(expected.ClassName) && expected.ClassName == current.ClassName) score += 25;
        var expectedCenter = new Point(expected.Left + expected.Width / 2, expected.Top + expected.Height / 2);
        var currentCenter = new Point(current.Left + current.Width / 2, current.Top + current.Height / 2);
        var distance = Math.Abs(expectedCenter.X - currentCenter.X) + Math.Abs(expectedCenter.Y - currentCenter.Y);
        if (distance <= 8) score += 25;
        else if (distance <= 40) score += 12;
        return score;
    }

    static string StableId(AutomationSelector selector)
    {
        var runtime = selector.RuntimeId.Length > 0 ? string.Join('.', selector.RuntimeId) : "none";
        var raw = $"{selector.Backend}|{selector.ProcessId}|{runtime}|{selector.AutomationId}|{selector.ControlType}|{selector.Name}|{selector.ClassName}";
        return "e_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..12];
    }

    static string Role(AutomationElement element) => element.Properties.ControlType.ValueOrDefault.ToString().ToLowerInvariant();
    static bool IsExplicitlyDisabled(AutomationElement element) => element.Properties.IsEnabled.TryGetValue(out var enabled) && !enabled;
    static bool IsExplicitlyOffscreen(AutomationElement element) => element.Properties.IsOffscreen.TryGetValue(out var offscreen) && offscreen;
    static string Trim(string value, int maxLength) => value.Length <= maxLength ? value : value[..maxLength];
    static string Diagnostic(string backend, string stage, Exception ex) => $"[{backend}:{stage}] {ex.GetType().Name}: {ex.Message}";
    static AutomationActionResult Success(AutomationSelector selector, string backend, string method) => new(true, false, backend, method, selector);
    static AutomationActionResult Failure(AutomationSelector selector, string backend, string stage, string error) => new(false, false, backend, "none", selector, stage, error);

    IEnumerable<(AutomationBase Automation, string Backend)> Backends(string preferred)
    {
        if (preferred.Equals("uia2", StringComparison.OrdinalIgnoreCase))
        {
            yield return (uia2, "uia2");
            yield return (uia3, "uia3");
        }
        else
        {
            yield return (uia3, "uia3");
            yield return (uia2, "uia2");
        }
    }

    static T Configure<T>(T automation) where T : AutomationBase
    {
        automation.TransactionTimeout = ProviderTimeout;
        automation.ConnectionTimeout = ConnectionTimeout;
        automation.ConnectionRecoveryBehavior = ConnectionRecoveryBehaviorOptions.Enabled;
        automation.CoalesceEvents = CoalesceEventsOptions.Enabled;
        return automation;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        uia3.Dispose();
        uia2.Dispose();
    }
}
