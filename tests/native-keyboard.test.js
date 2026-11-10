'use strict';

// Execute production dispatch and InputLease with a recorded SendInput boundary.
// No desktop application or Windows input is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native keyboard preserves chords, repeat limits, cancellation and close receipts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-keyboard-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^iexa-native-keyboard-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = fs.readFileSync(path.join(__dirname, '../desktop-agent/Program.cs'), 'utf8').replace(/\r\n/g, '\n');
  function section(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, start);
    return source.slice(begin, finish);
  }
  const methods = section('    static object Hotkey(', '    static object Scroll(')
    + section('    static object ClickElement(', '    static async Task<object> TypeElement(')
    + section('    static object Key(', '    static void EnsureBoundForeground(')
    + section('    static object Click(JsonObject', '    static object Drag(')
    + section('    static ushort ParseKey(', '    static void ThrowIfCancelled(');
  const structs = section('    [StructLayout(LayoutKind.Sequential)] struct INPUT', '\n}\n\n// BEGIN NATIVE_MODAL_POLICY');
  const project = path.join(directory, 'NativeKeyboard.csproj');
  const configuration = path.join(directory, 'NuGet.Config');
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  fs.writeFileSync(configuration, '<configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(directory, 'Program.cs'), `using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
internal static class Program {
  static readonly object InputLock = new();
  static IntPtr BoundWindow = new(10), Foreground = new(10);
  static Rectangle BoundBounds = new(0,0,100,100);
  static string WindowTransitionDiagnostic = "fixture";
  static string Mode = "";
  static int Completed, Packets, FailPacket, FollowCalls;
  static bool Exists = true;
  static readonly HashSet<ushort> Held = new();
  static readonly List<object> Events = new();
  static class IsolatedDesktopHost { public static bool Requested => false; public static bool IsVerified() => false; }
  static readonly Dictionary<string,object> ElementCache = new();
  static string ObservationToken = "fixture";
  sealed record SemanticElement(object? Selector,int Left=0,int Top=0,int Width=10,int Height=10);
  sealed record AutomationActionResult(bool Success,bool RequiresInputFallback=false,string Method="uia_invoke",string ErrorStage="provider",string Error="provider fixture",object? Selector=null);
  static Task<SemanticElement> ResolveTargetAsync(JsonObject req,bool allowTextAsLabel) => Task.FromResult(new SemanticElement(new object()));
  static SemanticElement RelocateBounds(SemanticElement element,object? selector) => element;
  static object PublicElement(SemanticElement element) => new { id="button" };
  static object WindowInfo(IntPtr h) => new { handle=h.ToInt64() };
  static class Automation {
    public static AutomationActionResult Click(object selector,Action cancel,bool background,bool isolated,int count,string button = "left") {
      cancel();
      if (Mode == "provider-fail") return new(false);
      CompleteInput(); return new(true);
    }
  }
  sealed record FrameState(string Hash);
  struct POINT { public int X, Y; }
  static bool GetCursorPos(out POINT point) { point = new POINT(); return true; }
  static (int X,int Y)? ResolvePoint(JsonObject req, bool unused) => null;
  static void HumanMove(int x,int y,int duration) { }
  static FrameState CaptureBoundFrame() => new("frame");
  static double FrameDifference(FrameState a,FrameState b) => 0;
  static string Required(JsonObject req,string key) => req[key]!.GetValue<string>();
  static IntPtr GetForegroundWindow() => Foreground;
  static bool IsWindow(IntPtr h) => Exists && h == new IntPtr(10);
  static void GrantPostActionModalFollow() { }
  static bool FollowForegroundWindow(IntPtr h,bool close = false) { FollowCalls++; return false; }
  static void EnsureBoundForeground(JsonObject req) {
    if (!Exists || BoundWindow != new IntPtr(10) || Foreground != BoundWindow) throw new InvalidOperationException("foreground fixture");
  }
  static void ThrowIfCancelled() {
    if (Mode == "cancel" && Completed > 0) throw new OperationCanceledException("cancel fixture");
  }
  static void CompleteInput() {
    Completed++;
    if (Mode == "focus") Foreground = new IntPtr(20);
    if (Mode == "close") { Exists = false; Foreground = new IntPtr(20); }
    if (Mode == "rebind") BoundWindow = new IntPtr(20);
  }
  static uint SendInput(uint count, INPUT[] inputs,int size) {
    foreach (var input in inputs) {
      Packets++;
      if (FailPacket == Packets) return 0;
      if (input.type == 1) {
        var key=input.U.ki.wVk; var flags=input.U.ki.dwFlags;
        Events.Add(new { key,flags });
        if ((flags & 2) == 0) Held.Add(key);
        else { Held.Remove(key); if (Held.Count == 0) CompleteInput(); }
      } else {
        Events.Add(new { mouse=input.U.mi.dwFlags });
        if (input.U.mi.dwFlags is 4 or 16 or 64) CompleteInput();
      }
    }
    return count;
  }
  static void Main(string[] args) {
    var cases=JsonNode.Parse(File.ReadAllText(args[0]))!.AsArray();
    var results=new List<object>();
    foreach(var item in cases) {
      var c=item!.AsObject(); var req=c["req"]!.AsObject();
      Mode=c["mode"]?.GetValue<string>() ?? ""; FailPacket=c["failPacket"]?.GetValue<int>() ?? 0;
      Completed=Packets=FollowCalls=0; Exists=true; BoundWindow=Foreground=new IntPtr(10); Held.Clear(); Events.Clear();
      object? result=null; string error="";
      try { result=req["action"]?.GetValue<string>() switch { "key" => Key(req), "click" => Click(req), "click_element" => ClickElement(req), _ => Hotkey(req) }; }
      catch(Exception ex) { error=ex.Message; }
      results.Add(new { name=c["name"]!.GetValue<string>(),result,error,events=Events.ToArray(),held=Held.ToArray(),completed=Completed,followCalls=FollowCalls,windowExists=Exists,boundHandle=BoundWindow.ToInt64() });
    }
    Console.Write(JsonSerializer.Serialize(results));
  }
${methods}
${structs}
}
`);
  const cases = [];
  const add = (name, req, extra = {}) => cases.push({ name, req: { action: 'hotkey', keys: ['SHIFT', 'END'], ...req }, ...extra });
  add('default chord');
  add('three chords', { count: 3 });
  add('upper bound', { count: 50 });
  for (const count of [0, 51, -1, 1.5, '3', null]) add('invalid count ' + JSON.stringify(count), { count }, { invalid: true });
  for (const mode of ['focus', 'cancel', 'close', 'rebind']) add('repeat stops ' + mode, { count: 3, expectWindowClosed: true }, { mode, partial: true });
  add('failed chord releases modifiers', {}, { failPacket: 2, inputFailure: true });
  add('close guard', { keys: ['ALT', 'F4'] }, { invalid: true });
  add('explicit close receipt', { keys: ['ALT', 'F4'], allowClose: true, expectWindowClosed: true }, { mode: 'close', closure: true });
  add('unrequested close remains failure', { keys: ['ALT', 'F4'], allowClose: true }, { mode: 'close', partial: true });
  add('completed hotkey retains ACK while original HWND still exists', { expectWindowClosed: true }, { mode: 'focus', closure: true, stillAlive: true });
  add('focus loss without explicit expectation remains failure', {}, { mode: 'focus', partial: true });
  add('async close does not bypass ALT F4 guard', { keys: ['ALT', 'F4'], expectWindowClosed: true }, { mode: 'focus', invalid: true });
  add('key close receipt', { action: 'key', key: 'ESC', expectWindowClosed: true }, { mode: 'close', closure: true });
  add('click close receipt', { action: 'click', expectWindowClosed: true, settleMs: 0 }, { mode: 'close', closure: true });
  add('provider click close receipt', { action: 'click_element', expectWindowClosed: true, settleMs: 0 }, { mode: 'close', closure: true });
  for (const action of ['key', 'click', 'click_element'])
    add('completed ' + action + ' retains async close ACK without following foreground', { action, key: 'ESC', expectWindowClosed: true, settleMs: 0 }, { mode: 'focus', closure: true, stillAlive: true });
  add('failed provider has no completion receipt', { action: 'click_element', expectWindowClosed: true }, { mode: 'provider-fail', invalid: true });
  add('background provider cannot claim closed foreground', { action: 'click_element', background: true, expectWindowClosed: true, settleMs: 0 }, { mode: 'close', partial: true });
  add('background provider cannot claim asynchronous close', { action: 'click_element', background: true, expectWindowClosed: true, settleMs: 0 }, { mode: 'focus', partial: true });
  add('partial SendInput cannot produce async close ACK', { expectWindowClosed: true }, { mode: 'focus', failPacket: 2, inputFailure: true });
  add('partial key close fails', { action: 'key', key: 'ESC', count: 3, expectWindowClosed: true }, { mode: 'close', partial: true });
  add('partial click close fails', { action: 'click', count: 2, expectWindowClosed: true }, { mode: 'close', partial: true });
  for (const action of ['key', 'click'])
    add('partial ' + action + ' focus transition remains failure', { action, key: 'ESC', count: 2, expectWindowClosed: true }, { mode: 'focus', partial: true });
  add('coordinate right button preserves packets', { action: 'click', button: 'right', settleMs: 0 }, { mouse: [8, 16] });
  add('coordinate middle button preserves packets', { action: 'click', button: 'middle', settleMs: 0 }, { mouse: [32, 64] });
  for (const key of ['HOME', 'END', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'PAGEUP', 'PAGEDOWN', 'DELETE'])
    add('extended ' + key, { keys: ['SHIFT', key] }, { extended: true });
  add('ordinary letter remains nonextended', { keys: ['CTRL', 'B'] }, { letter: true });
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
  const results = JSON.parse(run([path.join(directory, 'bin/Release/net8.0/NativeKeyboard.dll'), input]));
  assert.equal(results.length, cases.length);
  for (let i = 0; i < cases.length; i++) await t.test(cases[i].name, () => {
    const expected = cases[i], actual = results[i];
    assert.equal(actual.name, expected.name);
    assert.deepEqual(actual.held, [], 'all modifiers released');
    if (expected.invalid) {
      assert.ok(actual.error, JSON.stringify(actual));
      assert.deepEqual(actual.events, []);
    } else if (expected.partial || expected.inputFailure) {
      assert.ok(actual.error, JSON.stringify(actual));
      assert.equal(actual.result, null);
      if (expected.partial) assert.equal(actual.completed, 1, 'never repeat into another window');
    } else {
      assert.equal(actual.error, '', JSON.stringify(actual));
      if (expected.closure) {
        assert.equal(actual.result.inputCompleted, true);
        assert.equal(actual.result.closurePendingVerification, true);
        assert.equal(actual.result.foregroundVerified, false);
        assert.equal(actual.result.closedHandle, 10);
        assert.equal(actual.followCalls, 0, 'closure ACK never follows the replacement foreground');
        assert.equal(actual.boundHandle, 10, 'original binding retained until control-plane verification');
        assert.equal(actual.result.windowClosed, undefined, 'ACK does not claim window disappearance');
        if (expected.stillAlive) assert.equal(actual.windowExists, true);
      } else {
        assert.equal(actual.result.count, expected.req.count ?? 1);
        assert.equal(actual.completed, expected.req.count ?? 1);
        if (expected.mouse) assert.deepEqual(actual.events.map(e => e.mouse), expected.mouse);
        else {
          const expectedFlags = expected.letter ? [0, 0, 2, 2] : [0, 1, 3, 2];
          for (let offset = 0; offset < actual.events.length; offset += 4)
            assert.deepEqual(actual.events.slice(offset, offset + 4).map(e => e.flags), expectedFlags);
        }
      }
    }
  });
});
