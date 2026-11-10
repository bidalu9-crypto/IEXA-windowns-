'use strict';
// Compile the actual production merge/overlap functions. No OCR engine, UIA
// provider, application or input is used by this deterministic geometry test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native perception keeps text inside containers and deduplicates matching semantic labels', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-perception-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^iexa-native-perception-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = fs.readFileSync(path.join(__dirname, '../desktop-agent/Program.cs'), 'utf8');
  function section(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, start);
    return source.slice(begin, finish);
  }
  const methods = section('    static SemanticElement[] MergeElements(', '    static object PublicElement(')
    + section('    static double Overlap(', '    static object ReadFocused(');
  const project = path.join(directory, 'NativePerception.csproj');
  const configuration = path.join(directory, 'NuGet.Config');
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  fs.writeFileSync(configuration, '<configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(directory, 'Program.cs'), `using System.Text.Json;
internal sealed record SemanticElement(string Id,string Role,string Text,int Left,int Top,int Width,int Height,string Source,double? Confidence,object? Selector);
internal sealed record Scenario(string Name,SemanticElement[] Elements);
internal static class Program {
  static void Main(string[] args) {
    var cases=JsonSerializer.Deserialize<Scenario[]>(File.ReadAllText(args[0]),new JsonSerializerOptions {PropertyNameCaseInsensitive=true})!;
    Console.Write(JsonSerializer.Serialize(cases.Select(c=>new {name=c.Name,elements=MergeElements(c.Elements)})));
  }
${methods}
}
`);
  const element = (id, text, options = {}) => ({ id, role: 'text', text, left: 120, top: 150, width: 100, height: 20, source: 'ocr', confidence: null, selector: null, ...options });
  const semantic = (id, text, options = {}) => element(id, text, { source: 'uia3', confidence: 1, selector: { hwnd: 10, automationId: id }, ...options });
  const cases = [];
  const add = (name, elements, ids) => cases.push({ name, elements, ids });
  const pane = semantic('pane', '', { role: 'pane', left: 114, top: 132, width: 514, height: 537 });
  const lines = Array.from({ length: 17 }, (_, i) => element('ocr-' + i, 'Menu entry ' + i, { top: 150 + i * 25 }));
  add('real menu geometry empty Pane preserves all 17 OCR lines', [pane, ...lines], ['pane', ...lines.map(e => e.id)]);
  add('same label same bounds prefers UIA over higher-confidence OCR', [element('ocr', 'Copy', { confidence: 1 }), semantic('uia', 'Copy', { confidence: 0.8 })], ['uia']);
  add('trimmed case-equivalent label with same bounds prefers UIA', [element('ocr', ' copy '), semantic('uia', 'COPY')], ['uia']);
  add('same label at different positions remains distinct', [semantic('first', 'Copy'), element('second', 'Copy', { top: 190 })], ['first', 'second']);
  add('large named container does not swallow equally named child', [semantic('parent', 'Copy', { width: 500, height: 400 }), element('child', 'Copy', { top: 190 })], ['parent', 'child']);
  add('same box empty UIA container cannot erase OCR label', [semantic('empty', '', { role: 'pane' }), element('text', 'Properties')], ['empty', 'text']);
  add('empty candidate cannot erase already retained text', [semantic('text', 'Properties'), element('empty', '', { role: 'pane' })], ['text', 'empty']);
  add('empty semantic parent cannot erase valid semantic child', [pane, semantic('child', 'Save as', { role: 'button', top: 190 })], ['pane', 'child']);
  add('substring label is distinct evidence rather than automatic duplication', [semantic('full', 'Save as'), element('partial', 'Save')], ['full', 'partial']);
  add('same box different labels preserve conflicting OCR evidence', [semantic('first', 'Open'), element('second', 'Copy')], ['first', 'second']);
  add('equivalent empty same-role same-geometry candidates may deduplicate', [semantic('first', '', { role: 'pane' }), element('second', '', { role: 'pane' })], ['first']);
  add('zero area does not manufacture overlap duplicate', [semantic('first', 'Copy', { width: 0 }), element('second', 'Copy')], ['first', 'second']);
  const input = path.join(directory, 'cases.json'); fs.writeFileSync(input, JSON.stringify(cases));
  function run(args) {
    const result = spawnSync('dotnet', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, [args.join(' '), result.stdout, result.stderr].join('\n')); return result.stdout;
  }
  run(['restore', project, '--configfile', configuration, '--verbosity', 'quiet', '--disable-parallel']);
  run(['build', project, '--no-restore', '--configuration', 'Release', '--verbosity', 'quiet', '--disable-build-servers', '-maxcpucount:1']);
  const results = JSON.parse(run([path.join(directory, 'bin/Release/net8.0/NativePerception.dll'), input]));
  assert.equal(results.length, cases.length);
  for (let i = 0; i < cases.length; i++) await t.test(cases[i].name, () => {
    const actual = results[i], expected = cases[i];
    assert.deepEqual(actual.elements.map(e => e.Id), expected.ids);
    for (const e of actual.elements) {
      const original = expected.elements.find(item => item.id === e.Id);
      assert.equal(e.Source, original.source);
      assert.deepEqual(e.Selector, original.selector, 'Merging never grants a selector to OCR or changes UIA identity');
      assert.equal(e.Text, original.text, 'Merging preserves the original observed evidence');
    }
  });
});
