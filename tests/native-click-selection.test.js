'use strict';

// Execute production click dispatch against instrumented UIA/input boundaries.
// No desktop, native helper, or external application is touched by this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native click selects on single click and activates only on explicit double click', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-click-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^iexa-native-click-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const automationSource = fs.readFileSync(path.join(__dirname, '../desktop-agent/MatureAutomation.cs'), 'utf8');
  const programSource = fs.readFileSync(path.join(__dirname, '../desktop-agent/Program.cs'), 'utf8');
  function section(source, start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, 'production section: ' + start);
    return source.slice(begin, finish);
  }
  const click = section(automationSource, '    public AutomationActionResult Click(', '    public AutomationActionResult Type(');
  const locateWrapper = section(automationSource, '    AutomationActionResult WithLocatedElement(', '    AutomationElement? Locate(');
  const helpers = section(automationSource, '    static AutomationActionResult Success(', '    IEnumerable<(AutomationBase Automation, string Backend)> Backends(');
  const dispatch = section(programSource, '    static object ClickElement(', '    static async Task<object> TypeElement(');
  const resultRecord = section(automationSource, 'internal sealed record AutomationActionResult(', 'internal sealed record FocusedElementResult(');
  const project = path.join(directory, 'NativeClick.csproj'), configuration = path.join(directory, 'NuGet.Config');
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  fs.writeFileSync(configuration, '<configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(directory, 'Program.cs'), `using System.Drawing;
using System.Text.Json;
using System.Text.Json.Nodes;
internal sealed record AutomationSelector(string Backend, string ControlType, long Hwnd = 10, long Generation = 1);
${resultRecord}
internal sealed record Scenario(string Name, string ControlType = "ListItem", bool Invoke = true,
  bool Selection = true, bool FocusSucceeds = true, bool Disabled = false, bool Background = false,
  bool Isolated = false, int? Count = null, bool ForcePointer = false, bool Selector = true,
  bool Toggle = false, bool Expand = false, bool Legacy = false, bool Value = false,
  bool ReadOnly = false, bool ReadOnlyAvailable = true, string Button = "left", bool Foreground = true, bool Outside = false);
internal sealed class Property<T> {
  public T ValueOrDefault { get; set; } = default!;
  public bool Available { get; set; } = true;
  public bool TryGetValue(out T value) { value = ValueOrDefault; return Available; }
}
internal sealed class Properties { public Property<bool> HasKeyboardFocus { get; } = new(); }
internal sealed class Pattern {
  readonly string name;
  public Property<bool> IsReadOnly { get; } = new() { ValueOrDefault = Program.Current.ReadOnly, Available = Program.Current.ReadOnlyAvailable };
  public Pattern(string name) { this.name = name; }
  public void Invoke() => Program.Trace.Add("invoke");
  public void Select() => Program.Trace.Add("select");
  public void Toggle() => Program.Trace.Add("toggle");
  public void Expand() => Program.Trace.Add("expand");
  public void DoDefaultAction() => Program.Trace.Add("legacy");
}
internal sealed class PatternSlot {
  readonly bool available; readonly string name;
  public PatternSlot(bool available, string name) { this.available = available; this.name = name; }
  public bool TryGetPattern(out Pattern pattern) { pattern = new Pattern(name); return available; }
}
internal sealed class Patterns {
  public PatternSlot Invoke { get; }
  public PatternSlot SelectionItem { get; }
  public PatternSlot Toggle { get; }
  public PatternSlot ExpandCollapse { get; }
  public PatternSlot LegacyIAccessible { get; }
  public PatternSlot Value { get; }
  public Patterns(Scenario c) {
    Invoke = new(c.Invoke, "invoke"); SelectionItem = new(c.Selection, "select");
    Toggle = new(c.Toggle, "toggle"); ExpandCollapse = new(c.Expand, "expand");
    LegacyIAccessible = new(c.Legacy, "legacy");
    Value = new(c.Value, "value");
  }
}
internal sealed class AutomationElement {
  public Patterns Patterns { get; }
  public Properties Properties { get; } = new();
  public AutomationElement FrameworkAutomationElement => this;
  public AutomationElement(Scenario c) { Patterns = new(c); }
  public void SetFocus() { Program.Trace.Add("focus"); Properties.HasKeyboardFocus.ValueOrDefault = Program.Current.FocusSucceeds; }
}
internal static class Win32MenuAutomation {
  public static AutomationActionResult Click(AutomationSelector selector, Action cancelled)
    => throw new InvalidOperationException("Fixture does not exercise native menus.");
}
internal sealed class MatureAutomation {
  IEnumerable<(object Automation, string Backend)> Backends(string preferred) {
    yield return (new object(), "uia3"); yield return (new object(), "uia2");
  }
  AutomationElement? Locate(object automation, string backend, AutomationSelector selector, Action cancelled, List<string> errors) {
    Program.BackendAttempts.Add(backend); return new AutomationElement(Program.Current);
  }
  static AutomationSelector CreateSelector(AutomationElement element, string backend, IntPtr hwnd, long generation)
    => new(backend, Program.Current.ControlType, hwnd.ToInt64(), generation);
  static string Diagnostic(string backend, string stage, Exception error) => backend + ":" + stage + ":" + error.Message;
  static bool IsExplicitlyDisabled(AutomationElement element) => Program.Current.Disabled;
${locateWrapper}
${helpers}
${click}
}
internal sealed record Element(AutomationSelector? Selector, int Left = 20, int Top = 30, int Width = 50, int Height = 40);
internal sealed record Frame(string Hash);
internal static class IsolatedDesktopHost { public static bool IsVerified() => Program.Current.Isolated; }
internal static class Program {
  internal static Scenario Current = null!;
  internal static readonly List<string> Trace = new();
  internal static readonly List<string> BackendAttempts = new();
  static readonly MatureAutomation Automation = new();
  static readonly object InputLock = new();
  static readonly Dictionary<int, Element> ElementCache = new();
  static string ObservationToken = "";
  static readonly IntPtr BoundWindow = new(10);
  static readonly Rectangle BoundBounds = new(0,0,1000,1000);
  static readonly List<int[]> Moves = new();
  static void Main(string[] args) {
    var cases = JsonSerializer.Deserialize<Scenario[]>(File.ReadAllText(args[0]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    var results = new List<object>();
    foreach (var c in cases) {
      Current = c; Trace.Clear(); BackendAttempts.Clear(); Moves.Clear(); object? result = null; string error = "";
      var req = new JsonObject { ["background"] = c.Background, ["forcePointer"] = c.ForcePointer, ["button"] = c.Button, ["settleMs"] = 0 };
      if (c.Count.HasValue) req["count"] = c.Count.Value;
      try { result = ClickElement(req); } catch (Exception ex) { error = ex.Message; }
      results.Add(new { name = c.Name, result, error, trace = Trace.ToArray(), backends = BackendAttempts.ToArray(), moves=Moves.ToArray() });
    }
    Console.Write(JsonSerializer.Serialize(results));
  }
  static void ThrowIfCancelled() { }
  static void EnsureBoundForeground(JsonObject req) { if (!Current.Foreground) throw new InvalidOperationException("foreground fixture"); }
  static Task<Element> ResolveTargetAsync(JsonObject req, bool allowTextAsLabel)
    => Task.FromResult(new Element(Current.Selector ? new AutomationSelector("uia3", Current.ControlType) : null));
  static IntPtr GetForegroundWindow() => BoundWindow;
  static Frame CaptureBoundFrame() => new("fixture-frame");
  static Element RelocateBounds(Element element, AutomationSelector selector) { Trace.Add("relocate"); return Current.Outside ? element with { Left=2000 } : Current.Button.ToLowerInvariant() != "left" ? element with { Left=120 } : element; }
  static void HumanMove(int x, int y, int duration) { Trace.Add("move"); Moves.Add(new[] {x,y}); }
  static void GrantPostActionModalFollow() { }
  static void FollowForegroundWindow(IntPtr window, bool expectedClosed) { }
  static bool IsWindow(IntPtr window) => true;
  static double FrameDifference(Frame before, Frame after) => 0.01;
  static object WindowInfo(IntPtr window) => new { handle = window.ToInt64() };
  static object PublicElement(Element element) => element;
  sealed class InputLease : IDisposable {
    public void Click(string button) => Trace.Add("pointer:" + button);
    public void Dispose() { }
  }
${dispatch}
}
`);
  const cases = [];
  function add(name, options, trace, method, error) {
    cases.push({ name, ...options, expectedTrace: trace, expectedMethod: method, expectedError: error });
  }
  for (const controlType of ['ListItem', 'DataItem', 'TreeItem', 'TabItem']) {
    add(controlType + ' single click selects and focuses without invoking', { controlType }, ['select', 'focus'], 'uia_select_focus');
  }
  add('explicit double click invokes once without selecting first', { count: 2 }, ['invoke'], 'uia_invoke');
  add('explicit triple click uses one semantic activation', { count: 3 }, ['invoke'], 'uia_invoke');
  add('single button click preserves Invoke', { controlType: 'Button' }, ['invoke'], 'uia_invoke');
  add('failed focus stops without Invoke or pointer replay', { focusSucceeds: false }, ['select', 'focus'], undefined, 'selection-focus');
  add('disabled item performs no action', { disabled: true }, [], undefined, 'enabled-check');
  add('ordinary background click preserves Invoke without changing focus', { background: true }, ['invoke'], 'uia_invoke');
  add('ordinary background click does not select when Invoke is absent', { background: true, invoke: false }, [], undefined, 'background-pattern');
  add('isolated background single click selects and focuses within its desktop', { background: true, isolated: true }, ['select', 'focus'], 'uia_select_focus');
  add('isolated double click invokes once', { background: true, isolated: true, count: 2 }, ['invoke'], 'uia_invoke');
  add('isolated double click without Invoke never injects physical input', { background: true, isolated: true, count: 2, invoke: false }, [], undefined, 'background-pattern');
  add('foreground double click without Invoke dispatches two pointer clicks', { count: 2, invoke: false }, ['relocate', 'move', 'pointer:left', 'pointer:left'], 'pointer');
  add('foreground triple click without Invoke dispatches three pointer clicks', { count: 3, invoke: false }, ['relocate', 'move', 'pointer:left', 'pointer:left', 'pointer:left'], 'pointer');
  add('forced pointer bypasses semantic patterns but preserves double count', { forcePointer: true, count: 2 }, ['move', 'pointer:left', 'pointer:left'], 'pointer');
  add('background rejects forcePointer before dispatch', { forcePointer: true, background: true }, [], undefined, 'physical fallback is disabled');
  add('background rejects an absent selector before dispatch', { selector: false, background: true }, [], undefined, 'physical fallback is disabled');
  add('selectorless foreground double click preserves count', { selector: false, count: 2 }, ['move', 'pointer:left', 'pointer:left'], 'pointer');
  add('invalid low count clamps to a single selection', { count: 0 }, ['select', 'focus'], 'uia_select_focus');
  add('oversized pointer count clamps to three clicks', { forcePointer: true, count: 99 }, ['move', 'pointer:left', 'pointer:left', 'pointer:left'], 'pointer');
  add('single checkbox preserves Toggle', { controlType: 'CheckBox', invoke: false, selection: false, toggle: true }, ['toggle'], 'uia_toggle');
  add('single expandable nonselectable item preserves Expand', { controlType: 'TreeItem', invoke: false, selection: false, expand: true }, ['expand'], 'uia_expand');
  add('double click does not silently become Toggle', { controlType: 'CheckBox', count: 2, invoke: false, selection: false, toggle: true }, ['relocate', 'move', 'pointer:left', 'pointer:left'], 'pointer');
  add('editable combo foreground click preselects pointer without provider mutation or alternate backend', { controlType: 'ComboBox', value: true }, ['relocate', 'move', 'pointer:left'], 'pointer');
  add('editable combo foreground click never attempts unreliable semantic focus', { controlType: 'ComboBox', value: true, focusSucceeds: false }, ['relocate', 'move', 'pointer:left'], 'pointer');
  add('editable combo ordinary background click retains Invoke without focus', { controlType: 'ComboBox', value: true, background: true }, ['invoke'], 'uia_invoke');
  add('editable combo isolated background click focuses its own desktop', { controlType: 'ComboBox', value: true, background: true, isolated: true }, ['focus'], 'uia_focus');
  add('editable combo isolated focus failure never injects physical input or retries a backend', { controlType: 'ComboBox', value: true, background: true, isolated: true, focusSucceeds: false }, ['focus'], undefined, 'editable-focus');
  add('isolated desktop does not select pointer even if background flag is absent', { controlType: 'ComboBox', value: true, isolated: true }, ['focus'], 'uia_focus');
  add('read-only combo retains Invoke', { controlType: 'ComboBox', value: true, readOnly: true }, ['invoke'], 'uia_invoke');
  add('combo with unavailable read-only flag does not assume editable', { controlType: 'ComboBox', value: true, readOnlyAvailable: false }, ['invoke'], 'uia_invoke');
  add('combo with no Value pattern retains Invoke', { controlType: 'ComboBox' }, ['invoke'], 'uia_invoke');
  add('editable combo explicit double click retains activation', { controlType: 'ComboBox', value: true, count: 2 }, ['invoke'], 'uia_invoke');
  add('button with a Value pattern retains Invoke', { controlType: 'Button', value: true }, ['invoke'], 'uia_invoke');
  add('Edit foreground click bypasses legacy default and Invoke', { controlType: 'Edit', legacy: true }, ['relocate', 'move', 'pointer:left'], 'pointer');
  add('Edit without Value still uses pointer focus', { controlType: 'Edit', invoke: false, selection: false, legacy: true }, ['relocate', 'move', 'pointer:left'], 'pointer');
  add('Edit read-only text still uses pointer for selection', { controlType: 'Edit', value: true, readOnly: true }, ['relocate', 'move', 'pointer:left'], 'pointer');
  add('Edit double click uses two physical clicks without Invoke', { controlType: 'Edit', count: 2, legacy: true }, ['relocate', 'move', 'pointer:left', 'pointer:left'], 'pointer');
  add('Edit background rejects even when Invoke is exposed', { controlType: 'Edit', background: true, legacy: true }, [], undefined, 'editable-focus');
  add('Edit isolated focuses with verified keyboard focus', { controlType: 'Edit', background: true, isolated: true, legacy: true }, ['focus'], 'uia_focus');
  add('Edit isolated focus failure never replays legacy or pointer', { controlType: 'Edit', background: true, isolated: true, focusSucceeds: false, legacy: true }, ['focus'], undefined, 'editable-focus');
  add('Edit isolated repeated click rejects before focus mutation', { controlType: 'Edit', background: true, isolated: true, count: 2 }, [], undefined, 'editable-focus');
  add('Edit disabled does not attempt focus or pointer', { controlType: 'Edit', disabled: true }, [], undefined, 'enabled-check');
  for (const button of ['right', 'middle', 'RIGHT']) {
    add('explicit ' + button + ' never invokes a primary action', { button }, ['relocate', 'move', 'pointer:' + button.toLowerCase()], 'pointer');
    add('explicit ' + button + ' with forcePointer still relocates without Invoke', { button, forcePointer: true }, ['relocate', 'move', 'pointer:' + button.toLowerCase()], 'pointer');
    add('background ' + button + ' rejected before provider mutation', { button, background: true }, [], undefined, 'no matching capability');
    add('isolated ' + button + ' rejected before provider mutation', { button, isolated: true }, [], undefined, 'no matching capability');
  }
  add('right double click preserves requested button and count', { button: 'right', count: 2 }, ['relocate', 'move', 'pointer:right', 'pointer:right'], 'pointer');
  add('selectorless right click preserves explicit pointer', { button: 'right', selector: false }, ['move', 'pointer:right'], 'pointer');
  add('disabled right target never receives input', { button: 'right', disabled: true }, [], undefined, 'enabled-check');
  add('right target loses foreground after relocation', { button: 'right', foreground: false }, ['relocate'], undefined, 'foreground fixture');
  add('right relocated target outside window receives no input', { button: 'right', outside: true }, ['relocate'], undefined, 'outside the bound window');
  add('invalid button does not invoke provider', { button: 'aux' }, [], undefined, 'Unknown mouse button');

  const input = path.join(directory, 'cases.json');
  fs.writeFileSync(input, JSON.stringify(cases));
  function run(args) {
    const result = spawnSync('dotnet', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, [args.join(' '), result.stdout, result.stderr].join('\n'));
    return result.stdout;
  }
  run(['restore', project, '--configfile', configuration, '--verbosity', 'quiet', '--disable-parallel']);
  run(['build', project, '--no-restore', '--configuration', 'Release', '--verbosity', 'quiet', '--disable-build-servers', '-maxcpucount:1']);
  const results = JSON.parse(run([path.join(directory, 'bin/Release/net8.0/NativeClick.dll'), input]));
  assert.equal(results.length, cases.length);
  for (let index = 0; index < cases.length; index++) {
    const expected = cases[index], actual = results[index];
    await t.test(expected.name, () => {
      assert.equal(actual.name, expected.name);
      assert.deepEqual(actual.trace, expected.expectedTrace, JSON.stringify(actual));
      if (expected.controlType === 'Edit') assert.deepEqual(actual.backends, ['uia3'], 'Edit route never retries a second provider or replays input');
      if (expected.controlType === 'ComboBox' && expected.value && !expected.forcePointer && (expected.count ?? 1) === 1)
        assert.deepEqual(actual.backends, ['uia3'], 'editable route is chosen before provider mutation and never retried on another backend');
      if (expected.expectedError) {
        assert.ok(actual.error.includes(expected.expectedError), JSON.stringify(actual));
        assert.equal(actual.result, null);
      } else {
        assert.equal(actual.error, '', JSON.stringify(actual));
        assert.equal(actual.result.method, expected.expectedMethod);
        assert.equal(actual.result.count, Math.max(1, Math.min(3, expected.count ?? 1)));
        assert.equal(actual.result.button, (expected.button ?? 'left').toLowerCase());
        if (expected.button && expected.button.toLowerCase() !== 'left' && expected.selector !== false) {
          assert.deepEqual(actual.backends, ['uia3'], 'pointer route is selected before any provider mutation');
          assert.deepEqual(actual.moves, [[145, 50]], 'use freshly relocated selector bounds');
        }
      }
    });
  }
});
