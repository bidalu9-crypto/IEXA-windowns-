'use strict';

// Exercise the production Type method with instrumented provider properties.
// This fixture never starts an application or injects desktop input.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native Value typing verifies readback and never replays an acknowledged write', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-value-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^iexa-native-value-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = fs.readFileSync(path.join(__dirname, '../desktop-agent/MatureAutomation.cs'), 'utf8');
  const section = (start, end) => {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, 'production section: ' + start);
    return source.slice(begin, finish);
  };
  const type = section('    public AutomationActionResult Type(', '    public FocusedElementResult ReadFocused(');
  const helpers = section('    static AutomationActionResult Success(', '    IEnumerable<(AutomationBase Automation, string Backend)> Backends(');
  const resultRecord = section('internal sealed record AutomationActionResult(', 'internal sealed record FocusedElementResult(');
  const project = path.join(directory, 'NativeValue.csproj'), configuration = path.join(directory, 'NuGet.Config');
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  fs.writeFileSync(configuration, '<configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(directory, 'Program.cs'), `using System.Diagnostics;
using System.Text.Json;
internal sealed record AutomationSelector(string Backend);
${resultRecord}
internal sealed record Scenario(string Name, string Text, string Before = "", string Mode = "immediate",
  bool Replace = true, bool Background = false, bool Disabled = false, bool ReadOnly = false);
internal sealed class Property<T> { public T ValueOrDefault { get; set; } = default!; }
internal sealed class ValueProperty {
  public string ValueOrDefault => Program.Stored;
  public bool TryGetValue(out string value) {
    Program.Reads++;
    if (Program.Current.Mode == "delayed" && Program.Reads >= 3) Program.Stored = Program.Requested;
    value = Program.Stored;
    return Program.Current.Mode != "unavailable";
  }
}
internal sealed class ValuePattern {
  public Property<bool> IsReadOnly { get; } = new() { ValueOrDefault = Program.Current.ReadOnly };
  public ValueProperty Value { get; } = new();
  public void SetValue(string text) {
    Program.Writes++; Program.Requested = text;
    Program.Stored = Program.Current.Mode switch {
      "immediate" => text,
      "partial" => text.Length > 0 ? text[..1] : "unexpected",
      "wrong" => new string('x', text.Length),
      _ => Program.Stored
    };
  }
}
internal sealed class ValueSlot {
  public bool TryGetPattern(out ValuePattern pattern) { pattern = new(); return true; }
}
internal sealed class LegacyPattern {
  public ValueProperty Value { get; } = new();
  public void SetValue(string text) { Program.LegacyWrites++; throw new InvalidOperationException("No legacy replay allowed"); }
}
internal sealed class LegacySlot {
  public bool TryGetPattern(out LegacyPattern pattern) { pattern = new(); return false; }
}
internal sealed class Patterns { public ValueSlot Value { get; } = new(); public LegacySlot LegacyIAccessible { get; } = new(); }
internal sealed class AutomationElement { public Patterns Patterns { get; } = new(); }
internal sealed class MatureAutomation {
  AutomationActionResult WithLocatedElement(AutomationSelector selector, string action, Action cancelled,
    Func<AutomationElement, string, AutomationSelector, AutomationActionResult> execute) {
    cancelled(); return execute(new AutomationElement(), selector.Backend, selector);
  }
  static bool IsExplicitlyDisabled(AutomationElement element) => Program.Current.Disabled;
${helpers}
${type}
}
internal static class Program {
  internal static Scenario Current = null!;
  internal static string Stored = "", Requested = "";
  internal static int Writes, Reads, LegacyWrites;
  static void Main(string[] args) {
    var cases = JsonSerializer.Deserialize<Scenario[]>(File.ReadAllText(args[0]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    var results = new List<object>();
    foreach (var c in cases) {
      Current = c; Stored = c.Before; Requested = ""; Writes = Reads = LegacyWrites = 0;
      var result = new MatureAutomation().Type(new AutomationSelector("uia3"), c.Text, c.Replace, () => {}, c.Background);
      results.Add(new { name = c.Name, result, stored = Stored, requested = Requested, writes = Writes, reads = Reads, legacyWrites = LegacyWrites });
    }
    Console.Write(JsonSerializer.Serialize(results));
  }
}
`);
  const cases = [
    { name: 'matching nonempty replacement succeeds after one read', text: 'STATUS DONE', before: 'STATUS PENDING', expected: true, reads: 1 },
    { name: 'asynchronous value propagation is observed without a second write', text: 'ready', mode: 'delayed', expected: true, reads: 3 },
    { name: 'an acknowledged no-op is rejected without fallback', text: 'STATUS PENDING', mode: 'noop', expected: false },
    { name: 'partial mutation is rejected without replacing or appending again', text: 'STATUS DONE', mode: 'partial', expected: false },
    { name: 'same length wrong contents are rejected', text: 'correct', mode: 'wrong', expected: false },
    { name: 'unavailable readback is rejected rather than assumed successful', text: 'ready', mode: 'unavailable', expected: false },
    { name: 'empty replacement is valid and read back exactly', text: '', before: 'erase me', expected: true, reads: 1 },
    { name: 'unchanged but already correct value is successful', text: 'ready', before: 'ready', mode: 'noop', expected: true, reads: 1 },
    { name: 'append verifies old plus new value', text: 'after', before: 'before ', replace: false, expected: true, reads: 1, expectedRequested: 'before after' },
    { name: 'trailing spaces and CRLF are retained in exact readback', text: 'line\r\n  ', expected: true, reads: 1 },
    { name: 'background provider no-op is rejected with no input fallback', text: 'ready', background: true, mode: 'noop', expected: false },
    { name: 'background matched value succeeds without keyboard input', text: 'ready', background: true, expected: true, reads: 1 },
    { name: 'disabled target is not written', text: 'ready', disabled: true, expected: false, expectedStage: 'enabled-check', writes: 0 },
    { name: 'read-only background target is not written', text: 'ready', readOnly: true, background: true, expected: false, expectedStage: 'background-pattern', writes: 0 },
  ];
  const input = path.join(directory, 'cases.json'); fs.writeFileSync(input, JSON.stringify(cases));
  function run(args) {
    const result = spawnSync('dotnet', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, [args.join(' '), result.stdout, result.stderr].join('\n'));
    return result.stdout;
  }
  run(['restore', project, '--configfile', configuration, '--verbosity', 'quiet', '--disable-parallel']);
  run(['build', project, '--no-restore', '--configuration', 'Release', '--verbosity', 'quiet', '--disable-build-servers', '-maxcpucount:1']);
  const results = JSON.parse(run([path.join(directory, 'bin/Release/net8.0/NativeValue.dll'), input]));
  assert.equal(results.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i], actual = results[i];
    await t.test(c.name, () => {
      assert.equal(actual.name, c.name);
      assert.equal(actual.result.Success, c.expected, JSON.stringify(actual));
      assert.equal(actual.result.RequiresInputFallback, false, 'acknowledged provider writes must never trigger automatic input fallback');
      assert.equal(actual.writes, c.writes ?? 1, 'exactly one requested provider mutation');
      assert.equal(actual.legacyWrites, 0, 'no alternate provider mutation');
      if (c.reads !== undefined) assert.equal(actual.reads, c.reads);
      if (c.expected) {
        assert.equal(actual.result.Method, 'uia_value');
        assert.equal(actual.stored, c.expectedRequested ?? c.text);
        assert.equal(actual.requested, c.expectedRequested ?? c.text);
      } else {
        assert.equal(actual.result.ErrorStage, c.expectedStage ?? 'value-verification');
        if (!c.expectedStage) assert.match(actual.result.Error, /No backend or keyboard replay/);
      }
    });
  }
});
