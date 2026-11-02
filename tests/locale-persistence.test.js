// Interfaces language must survive a restart even when the renderer origin
// changes. Two mechanisms are covered here:
//   1. the desktop shell no longer picks a random port (stable origin keeps every
//      localStorage preference);
//   2. the chosen locale is mirrored to /api/appearance, so a renderer with empty
//      storage still boots into it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

// --- 1. backend contract ---------------------------------------------------

test('the appearance store accepts and normalises a locale', () => {
  const { normalizeAppearance } = require('../dist/main/appearance/AppearanceSchema');
  assert.equal(normalizeAppearance({ locale: 'en-US' }).locale, 'en-US');
  assert.equal(normalizeAppearance({ locale: 'ja-JP' }).locale, 'ja-JP');
  assert.equal(normalizeAppearance({ locale: 'zh-CN' }).locale, 'zh-CN');
  assert.equal(normalizeAppearance({}).locale, 'zh-CN', 'missing value falls back');
  assert.equal(normalizeAppearance({ locale: 'fr-FR' }).locale, 'zh-CN', 'unknown value falls back');
  assert.equal(normalizeAppearance({ locale: 42 }).locale, 'zh-CN', 'wrong type falls back');
});

test('the appearance route round-trips a locale through the real server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-locale-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ sessions: [] }));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const credentials = backend.getServerCredentials(server);
  const headers = { 'Content-Type': 'application/json', Cookie: `${credentials.cookieName}=${credentials.token}` };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  });

  const saved = await fetch(`http://127.0.0.1:${port}/api/appearance`, {
    method: 'PUT', headers, body: JSON.stringify({ theme: 'dark', locale: 'en-US' }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).locale, 'en-US');

  const read = await fetch(`http://127.0.0.1:${port}/api/appearance`, { headers, cache: 'no-store' });
  const value = await read.json();
  assert.equal(value.locale, 'en-US', 'the locale is persisted, not just echoed');
});

// --- 2. renderer bootstrap -------------------------------------------------

function bootAppearance(savedAppearance) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:19840/', runScripts: 'outside-only',
  });
  const w = dom.window;
  w.iexaDesktop = savedAppearance ? { initialAppearance: savedAppearance } : {};
  require('./helpers/install-i18n')(w);
  w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'InitialAppearance.js'), 'utf8'));
  return { dom, w };
}

test('a mirrored locale seeds storage before I18n init on a fresh origin', () => {
  const { dom, w } = bootAppearance({ theme: 'dark', locale: 'en-US' });
  try {
    assert.equal(w.localStorage.getItem('iexa-locale'), 'en-US');
    // init() is the call that normally reads storage; it must now find the value.
    w.IexaI18n.init();
    assert.equal(w.IexaI18n.getLocale(), 'en-US');
  } finally { dom.window.close(); }
});

test('an explicit local choice is never overwritten by the mirrored value', () => {
  const { dom, w } = bootAppearance({ locale: 'en-US' });
  try {
    w.localStorage.setItem('iexa-locale', 'ja-JP');
    w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'InitialAppearance.js'), 'utf8'));
    assert.equal(w.localStorage.getItem('iexa-locale'), 'ja-JP', 'the newer local choice wins');
  } finally { dom.window.close(); }
});

test('a document with no mirrored locale leaves storage untouched', () => {
  const { dom, w } = bootAppearance(null);
  try {
    assert.equal(w.localStorage.getItem('iexa-locale'), null);
    assert.equal(w.document.documentElement.getAttribute('data-glass'), 'on', 'previous bootstrap still runs');
  } finally { dom.window.close(); }
});

// --- 3. desktop port choice ------------------------------------------------

function loadPortHelpers() {
  // electron-entry.js runs Electron at import time, so the helper is extracted
  // textually (the same approach the tool-row tests use for renderer source).
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron-entry.js'), 'utf8');
  const lines = source.split('\n');
  const startLine = lines.findIndex((line) => line.startsWith('function claimPort('));
  assert.ok(startLine >= 0, 'claimPort is present');
  let depth = 0;
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i += 1) {
    for (const char of lines[i]) {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
    }
    if (depth === 0) { endLine = i; break; }
  }
  const preferred = lines.find((line) => line.startsWith('const PREFERRED_PORT'));
  assert.ok(preferred, 'PREFERRED_PORT is present');
  return lines.slice(startLine, endLine + 1).join('\n') + '\n' + preferred + '\n';
}

test('the desktop keeps a stable preferred port instead of a random one', async () => {
  const net = require('node:net');
  const vm = require('node:vm');
  const body = loadPortHelpers();
  const context = { net, process: { env: {} }, resolve: null };
  vm.createContext(context);
  vm.runInContext(body + '\nthis.claimPort = claimPort; this.PREFERRED_PORT = PREFERRED_PORT;', context);

  assert.equal(context.PREFERRED_PORT, 19840, 'the origin must be stable by default');

  const free = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  assert.equal(await context.claimPort(free), free, 'a free port is claimed');

  const held = net.createServer();
  await new Promise((resolve) => held.listen(free, '127.0.0.1', resolve));
  try {
    assert.equal(await context.claimPort(free), null, 'a busy port reports null so the caller can fall back');
  } finally {
    await new Promise((resolve) => held.close(resolve));
  }
});
