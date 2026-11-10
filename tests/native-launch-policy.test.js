'use strict';

// Run the production launch orchestration and window finders with fixture-only
// process/Win32 reads. No application or desktop helper is started by this test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native launch delivers arguments and binds Explorer folder windows across broker PIDs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-launch-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^iexa-native-launch-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = fs.readFileSync(path.join(__dirname, '../desktop-agent/Program.cs'), 'utf8');
  const section = (start, end) => {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, `production section: ${start}`);
    return source.slice(begin, finish);
  };
  const production = [
    section('    static async Task<object> Launch(', '    static (string FileName, string Arguments, string ExpectedProcess) ResolveLaunchSpec('),
    section('    static HashSet<long> SnapshotWindowHandles(', '    static object Minimize('),
    section('    static bool IsUsableAppWindow(', '    static object WindowInfo('),
  ].join('\n')
    .replace('Process? started;', 'FixtureProcess? started;')
    .replace('Process.Start(info)', 'FixtureProcess.Start(info)')
    .replaceAll('Process.GetProcessById(', 'FixtureProcess.GetProcessById(');

  const project = path.join(directory, 'NativeLaunch.csproj');
  const configuration = path.join(directory, 'NuGet.Config');
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  fs.writeFileSync(configuration, '<configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(directory, 'Program.cs'), `using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed record Window(long Handle, string Title, string Class, string Process = "explorer", int Pid = 100,
  bool Visible = true, int Width = 1200, int Height = 800, long ExStyle = 0);
internal sealed record Scenario(string Name, string App, string Arguments, Window[] Before, Window[] After,
  long ForegroundBefore = 0, long ForegroundAfter = 0, long MainWindow = 0, bool ForceNew = false,
  bool TransitionOnly = false, long Original = 0);
internal sealed class FixtureProcess {
  internal int Id { get; init; } = 900;
  internal string ProcessName { get; init; } = "broker";
  internal IntPtr MainWindowHandle => new(Program.Current.MainWindow);
  internal void Refresh() { }
  internal static FixtureProcess Start(ProcessStartInfo info) {
    Program.Starts.Add(new { file = info.FileName, arguments = info.Arguments });
    foreach (var window in Program.Current.After) Program.Windows[window.Handle] = window;
    Program.Foreground = Program.Current.ForegroundAfter;
    return new FixtureProcess();
  }
  internal static FixtureProcess GetProcessById(int pid) => new() { Id = pid,
    ProcessName = Program.Windows.Values.First(w => w.Pid == pid).Process };
}
internal static class IsolatedDesktopHost { internal static bool Requested => false; }
internal static class Program {
  internal static Scenario Current = null!;
  internal static Dictionary<long, Window> Windows = new();
  internal static List<object> Starts = new();
  internal static long Foreground;
  static long Bound;
  static readonly List<long> Activated = new();
  static readonly FakeAutomation Automation = new();
  static async Task Main(string[] args) {
    var cases = JsonSerializer.Deserialize<Scenario[]>(File.ReadAllText(args[0]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    var results = new List<object>();
    foreach (var item in cases) {
      Current = item; Windows = item.Before.ToDictionary(w => w.Handle); Starts = new();
      Foreground = item.ForegroundBefore; Bound = 0; Activated.Clear();
      object? result = null; string error = "";
      try {
        if (item.TransitionOnly) {
          Foreground = item.ForegroundAfter;
          var original = new IntPtr(item.Original);
          var selected = FollowLaunchWindowTransition(original, GetWindowText(original), (uint)Windows[item.Original].Pid, true);
          Bound = selected.ToInt64(); result = new { window = WindowInfo(selected) };
        } else result = await Launch(new JsonObject { ["app"] = item.App, ["arguments"] = item.Arguments,
          ["forceNew"] = item.ForceNew, ["waitForWindowMs"] = 500 });
      }
      catch (Exception ex) { error = ex.Message; }
      results.Add(new { name = item.Name, result, error, starts = Starts.ToArray(), bound = Bound, activated = Activated.ToArray() });
    }
    Console.Write(JsonSerializer.Serialize(results));
  }
  static (string FileName, string Arguments, string ExpectedProcess) ResolveLaunchSpec(string app, string arguments)
    => (app, arguments, Path.GetFileNameWithoutExtension(app));
  static void ThrowIfCancelled() { }
  static bool IsWindow(IntPtr h) => Windows.ContainsKey(h.ToInt64());
  static bool IsWindowVisible(IntPtr h) => Windows.TryGetValue(h.ToInt64(), out var w) && w.Visible;
  static string GetWindowText(IntPtr h) => Windows.TryGetValue(h.ToInt64(), out var w) ? w.Title : "";
  static string GetClassName(IntPtr h) => Windows.TryGetValue(h.ToInt64(), out var w) ? w.Class : "";
  static IntPtr GetWindowLongPtr(IntPtr h, int index) => new(Windows[h.ToInt64()].ExStyle);
  struct RECT { internal int Left, Top, Right, Bottom; }
  static bool GetWindowRect(IntPtr h, out RECT r) { var w = Windows[h.ToInt64()]; r = new RECT { Left = 0, Top = 0, Right = w.Width, Bottom = w.Height }; return true; }
  static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid = (uint)Windows[h.ToInt64()].Pid; return 1; }
  static IntPtr GetForegroundWindow() => new(Foreground);
  static void ForceForeground(IntPtr h) { Foreground = h.ToInt64(); Activated.Add(Foreground); }
  static void BindToWindow(IntPtr h) => Bound = h.ToInt64();
  static object SessionState() => new { bound = Bound };
  static object WindowInfo(IntPtr h) { var w = Windows[h.ToInt64()]; return new { handle = w.Handle, title = w.Title, className = w.Class, pid = w.Pid }; }
  static bool EnumWindows(Func<IntPtr, IntPtr, bool> callback, IntPtr parameter) {
    foreach (var window in Windows.Keys.ToArray()) if (!callback(new IntPtr(window), parameter)) break;
    return true;
  }
  sealed class FakeAutomation {
    internal (int[] Elements, string Backend) Observe(IntPtr h, int limit, int generation, Action cancelled) => (new[] { 1, 2, 3 }, "fixture");
  }
${production}
}
`);

  const shell = [
    { handle: 1, title: 'Program Manager', class: 'Progman', width: 2560, height: 1440 },
    { handle: 2, title: '', class: 'ApplicationFrameWindow', width: 2560, height: 1400 },
    { handle: 3, title: '', class: 'Shell_TrayWnd', width: 2560, height: 80 },
  ];
  const folder = { handle: 10, title: '任务 文件夹', class: 'CabinetWClass', pid: 100 };
  const legacyFolder = { ...folder, handle: 11, class: 'ExploreWClass' };
  const app = { handle: 20, title: 'Existing viewer', class: 'ViewerWindow', process: 'viewer', pid: 200 };
  const cases = [
    { name: 'directory arguments reach Explorer despite shell and existing folder', app: 'explorer.exe', arguments: '"E:\\任务 目录\\测试"', before: [...shell, { ...folder, handle: 9, title: 'Unrelated folder' }], after: [folder], foregroundBefore: 1, foregroundAfter: 10, expectedHandle: 10, expectedStarts: 1 },
    { name: 'broker has no window and the folder belongs to the existing Explorer PID', app: 'explorer.exe', arguments: '"E:\\task-files"', before: shell, after: [folder], foregroundBefore: 1, foregroundAfter: 1, expectedHandle: 10, expectedStarts: 1 },
    { name: 'broker main handle is a desktop shell frame', app: 'explorer.exe', arguments: '"E:\\task-files"', before: shell, after: [legacyFolder], foregroundBefore: 1, foregroundAfter: 1, mainWindow: 2, expectedHandle: 11, expectedStarts: 1 },
    { name: 'Explorer with no arguments still launches Home', app: 'explorer.exe', arguments: '', before: shell, after: [folder], foregroundBefore: 1, foregroundAfter: 10, expectedHandle: 10, expectedStarts: 1 },
    { name: 'titled desktop shells and shell frames are never accepted', app: 'explorer.exe', arguments: '"E:\\task-files"', before: shell, after: [{ handle: 4, title: 'Shell frame', class: 'ApplicationFrameWindow', width: 2560, height: 1400 }], foregroundBefore: 1, foregroundAfter: 4, mainWindow: 4, expectedHandle: 0, expectedStarts: 1, expectedError: true },
    { name: 'an unrelated newly opened application cannot replace a folder', app: 'explorer.exe', arguments: '"E:\\task-files"', before: shell, after: [app], foregroundBefore: 1, foregroundAfter: 20, mainWindow: 20, expectedHandle: 0, expectedStarts: 1, expectedError: true },
    { name: 'another process using the folder class cannot replace Explorer', app: 'explorer.exe', arguments: '"E:\\task-files"', before: shell, after: [{ ...folder, handle: 30, process: 'viewer', pid: 300 }], foregroundBefore: 1, foregroundAfter: 30, mainWindow: 30, expectedHandle: 0, expectedStarts: 1, expectedError: true },
    { name: 'hidden Explorer folder is not a launch result', app: 'explorer.exe', arguments: '"E:\\task-files"', before: shell, after: [{ ...folder, visible: false }], foregroundBefore: 1, foregroundAfter: 1, mainWindow: 10, expectedHandle: 0, expectedStarts: 1, expectedError: true },
    { name: 'document arguments reach an already running single instance app', app: 'viewer.exe', arguments: '"E:\\报告 文档.rtf" /readonly', before: [app], after: [], foregroundBefore: 20, foregroundAfter: 20, expectedHandle: 20, expectedStarts: 1 },
    { name: 'no argument single instance activation keeps the existing shortcut', app: 'viewer.exe', arguments: '', before: [app], after: [], foregroundBefore: 20, foregroundAfter: 20, expectedHandle: 20, expectedStarts: 0 },
    { name: 'forceNew still delivers a no argument launch', app: 'viewer.exe', arguments: '', forceNew: true, before: [app], after: [{ ...app, handle: 21 }], foregroundBefore: 20, foregroundAfter: 21, expectedHandle: 21, expectedStarts: 1 },
    { name: 'same title desktop shell cannot replace an observed folder during transition', app: 'explorer.exe', arguments: '', before: [...shell, { ...folder, title: 'Program Manager' }], after: [], foregroundAfter: 1, transitionOnly: true, original: 10, expectedHandle: 10, expectedStarts: 0 },
    { name: 'same title and folder class from another process cannot replace Explorer during transition', app: 'explorer.exe', arguments: '', before: [folder, { ...folder, handle: 30, process: 'viewer', pid: 300 }], after: [], foregroundAfter: 30, transitionOnly: true, original: 10, expectedHandle: 10, expectedStarts: 0 },
    { name: 'same title ordinary application cannot replace Explorer during transition', app: 'explorer.exe', arguments: '', before: [folder, { ...app, title: folder.title }], after: [], foregroundAfter: 20, transitionOnly: true, original: 10, expectedHandle: 10, expectedStarts: 0 },
    { name: 'same title real Explorer folder can finish a broker transition', app: 'explorer.exe', arguments: '', before: [folder, { ...folder, handle: 12 }], after: [], foregroundAfter: 12, transitionOnly: true, original: 10, expectedHandle: 12, expectedStarts: 0 },
  ];
  const input = path.join(directory, 'cases.json');
  fs.writeFileSync(input, JSON.stringify(cases));
  const run = args => {
    const result = spawnSync('dotnet', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, [args.join(' '), result.stdout, result.stderr].join('\n'));
    return result.stdout;
  };
  run(['restore', project, '--configfile', configuration, '--verbosity', 'quiet', '--disable-parallel']);
  run(['build', project, '--no-restore', '--configuration', 'Release', '--verbosity', 'quiet', '--disable-build-servers', '-maxcpucount:1']);
  const results = JSON.parse(run([path.join(directory, 'bin/Release/net8.0/NativeLaunch.dll'), input]));
  assert.equal(results.length, cases.length);
  for (let index = 0; index < cases.length; index++) {
    const expected = cases[index], actual = results[index];
    await t.test(expected.name, () => {
      assert.equal(actual.name, expected.name);
      assert.equal(actual.starts.length, expected.expectedStarts, JSON.stringify(actual));
      for (const start of actual.starts) {
        assert.equal(start.file, expected.app);
        assert.equal(start.arguments, expected.arguments, 'the original Unicode, quotes and options reach Process.Start');
      }
      assert.equal(actual.bound, expected.expectedHandle, JSON.stringify(actual));
      assert.equal(Boolean(actual.error), Boolean(expected.expectedError), JSON.stringify(actual));
      if (expected.expectedError) {
        assert.match(actual.error, /no controllable top-level window/);
        assert.deepEqual(actual.activated, [], 'failed launch must not activate a desktop shell or an unrelated app');
      } else {
        assert.equal(actual.result.window.handle, expected.expectedHandle);
        if (expected.expectedStarts) assert.equal(actual.result.launched, true, 'a dispatched launch is recorded as launched');
        else if (!expected.transitionOnly) assert.equal(actual.result.reused, true);
      }
    });
  }
});
