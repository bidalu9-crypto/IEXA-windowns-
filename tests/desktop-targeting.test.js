// Guards for label-based targeting. This is what makes self-drawn UI (Qt,
// canvas, games) drivable without coordinates: locate the control now instead of
// asking the caller to estimate pixels from a screenshot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('targeting resolves UI Automation first, then OCR', () => {
  const source = read('desktop-agent/Program.cs');
  const fn = source.slice(source.indexOf('static async Task<SemanticElement> ResolveTargetAsync'));
  const body = fn.slice(0, fn.indexOf('static object ClickElement'));
  const uiaAt = body.indexOf('Automation.Observe');
  const ocrAt = body.indexOf('OcrElements');
  assert.ok(uiaAt > 0 && ocrAt > 0, 'both resolvers are used');
  assert.ok(uiaAt < ocrAt, 'UI Automation is tried before OCR');
  assert.match(body, /PickBestMatch\(await OcrElements/, 'the OCR result goes through the same ranking');
});

test('the ranking prefers an exact label and then the smallest box', () => {
  const source = read('desktop-agent/Program.cs');
  const fn = source.slice(source.indexOf('static SemanticElement? PickBestMatch'));
  assert.match(fn, /string\.Equals\(e\.Text\.Trim\(\), text\.Trim\(\)/, 'exact matches win');
  assert.match(fn, /ThenBy\(e => \(long\)e\.Width \* e\.Height\)/, 'the smallest containing box wins');
});

test('label is separate from the text to type, and both are accepted', () => {
  const source = read('desktop-agent/Program.cs');
  assert.match(source, /bool allowTextAsLabel/, 'the ambiguity is explicit');
  assert.match(source, /ResolveTargetAsync\(req, allowTextAsLabel: true\)/, 'click_element may use text as the label');
  assert.match(source, /ResolveTargetAsync\(req, allowTextAsLabel: false\)/, 'type_element must not: its text is the content');
  const definitions = read('src/main/tools/ToolDefinitions.ts');
  assert.match(definitions, /label: \{ type: 'string'/, 'label is documented');
  assert.match(definitions, /'label',/, 'and whitelisted');
});

test('click and type no longer require a prior observation', () => {
  const source = read('desktop-agent/Program.cs');
  const click = source.slice(source.indexOf('static object ClickElement'));
  const type = source.slice(source.indexOf('static async Task<object> TypeElement'));
  assert.match(click.slice(0, 600), /ResolveTargetAsync/, 'click resolves the target itself');
  assert.match(type.slice(0, 600), /ResolveTargetAsync/, 'type resolves the target itself');
  // find_element also looks live when the cache has nothing.
  const find = source.slice(source.indexOf('static async Task<object> FindElement'));
  assert.match(find.slice(0, 1600), /Automation\.Observe/, 'find_element searches when nothing is cached');
});

test('OCR upscales small captures and maps the boxes back', () => {
  const source = read('desktop-agent/Program.cs');
  const fn = source.slice(source.indexOf('static async Task<IEnumerable<SemanticElement>> OcrElements'));
  const body = fn.slice(0, fn.indexOf('static IEnumerable<SemanticElement> DetectRegions'));
  assert.match(body, /var scale = bitmap\.Width < 1600/, 'small windows are upscaled');
  assert.match(body, /HighQualityBicubic/, 'bilinear rather than nearest neighbour');
  assert.match(body, /origin\.Left \+ \(int\)\(minX \/ scale\)/, 'x is divided back by the scale');
  assert.match(body, /origin\.Top \+ \(int\)\(minY \/ scale\)/, 'y is divided back by the scale');
  assert.match(body, /finally \{ upscaled\?\.Dispose\(\)/, 'the upscaled bitmap is released');
});

// Opt-in: drives the real agent against Notepad's menu, which lives in a classic
// Win32 tree, so this exercises the UI Automation tier of the resolver.
test('real agent: a control is found and clicked by label alone', { skip: !process.env.IEXA_TEST_DESKTOP_AGENT, timeout: 90000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const exe = path.join(root, 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe');
  if (!fs.existsSync(exe)) return t.skip('agent not built');
  const port = 18791;
  const child = spawn(exe, [], {
    stdio: ['pipe', 'ignore', 'ignore', 'ignore'], windowsHide: true,
    env: { ...process.env, IEXA_DESKTOP_PORT: String(port), IEXA_DESKTOP_OWNER_PIPE: 'stdin-v1' },
  });
  t.after(() => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await sleep(100);
  }
  const call = async (payload) => JSON.parse(await (await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })).text());

  const launch = await call({ action: 'launch', app: 'C:\\Windows\\System32\\notepad.exe', waitForWindowMs: 20000 });
  assert.equal(launch.ok, true, JSON.stringify(launch));

  const found = await call({ action: 'find_element', text: '编辑' });
  assert.ok(found.data?.count >= 1, 'the Edit menu is located without a prior observe: ' + JSON.stringify(found));

  const clicked = await call({ action: 'click_element', label: '编辑' });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  // No element id was ever supplied; the resolver found it and used the
  // accessibility action when the control exposes one, otherwise the pointer.
  assert.ok(['pointer', 'uia_invoke'].includes(clicked.data?.method), 'click method: ' + clicked.data?.method);

  const handle = launch.data?.window?.handle;
  if (handle) await call({ action: 'window_command', handle, command: 'close' }).catch(() => {});
});
