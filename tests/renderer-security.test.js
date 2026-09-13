'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');
const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
const scripts = ['vendor/marked.umd.js', 'vendor/highlight.min.js', 'vendor/purify.min.js', 'services/SafeMarkdown.js'];
const payloads = [
  '<img src=x onerror="window.SECURITY_EXECUTED=1">',
  '<svg><g onload="window.SECURITY_EXECUTED=1"></g><foreignObject><iframe srcdoc="bad"></iframe></foreignObject></svg>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  '[danger](javascript:alert%281%29) <a href="java&#x09;script:alert(1)">bad</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="javascript:alert(1)"></object>',
  '<form id=location><input name=attributes></form><a id=chatMessages name=location href="vbscript:bad">x</a>',
  '<div data-ui-action="deleteSession" data-ui-arg="victim" style="position:fixed" onclick="bad()">action</div>',
  '<img src="https://example.test/a.png" srcset="javascript:bad 1x" onerror="bad()">',
  '<script>window.SECURITY_EXECUTED=1</script><style>@import "https://evil.test/x";</style>',
  '<a href="data:text/html;base64,PHNjcmlwdD4=">bad</a><a href="file:///C:/test">file</a>',
];
function fixture(url = 'https://iexa.test/') {
  const dom = new JSDOM('<!doctype html><body><div id="chatMessages"></div></body>', { url, runScripts: 'outside-only' });
  for (const file of scripts) dom.window.eval(fs.readFileSync(path.join(RENDERER, file), 'utf8'));
  return dom;
}
function functionSource(name) {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} exists`);
  const end = app.indexOf('\n}', start);
  return app.slice(start, end + 2);
}
function assertSafe(root) {
  assert.equal(root.querySelectorAll('script,style,svg,math,iframe,object,embed,form,input,button,meta,base').length, 0);
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      assert.ok(!/^on|^data-|^(style|srcset|id|name)$/i.test(attribute.name), `${attribute.name} removed`);
      if (/^(href|src)$/i.test(attribute.name)) assert.ok(!/^(javascript|vbscript|file):/i.test(attribute.value.replace(/\s/g, '')));
    }
  }
}
test('the shipped DOMPurify neutralizes XSS, mutation payloads, clobbering and delegated actions', () => {
  const dom = fixture();
  try {
    for (const input of payloads) {
      const root = dom.window.document.createElement('div');
      root.innerHTML = dom.window.SafeMarkdown.renderSafeMarkdown(input);
      assertSafe(root);
      assert.equal(dom.window.SECURITY_EXECUTED, undefined);
    }
  } finally { dom.window.close(); }
});
test('Markdown keeps highlighted code, tables, links, images and literal formula text', () => {
  const dom = fixture();
  try {
    const root = dom.window.document.createElement('div');
    root.innerHTML = dom.window.SafeMarkdown.renderSafeMarkdown('**bold**\n\n|a|b|\n|-|-|\n|1|2|\n\n```js\nconst answer = 42;\n```\n\n![image](https://example.test/image.png) [link](https://example.test)\n\n$x^2$');
    assert.equal(root.querySelector('strong').textContent, 'bold');
    assert.equal(root.querySelectorAll('table tbody td').length, 2);
    assert.ok(root.querySelector('code.language-js .hljs-keyword'));
    assert.equal(root.querySelector('img').getAttribute('src'), 'https://example.test/image.png');
    assert.equal(root.querySelector('a').getAttribute('href'), 'https://example.test');
    assert.ok(root.textContent.includes('$x^2$'));
    assertSafe(root);
  } finally { dom.window.close(); }
});
test('actual initial/history and streaming renderer functions share the sanitizer', () => {
  const dom = fixture(); const w = dom.window;
  try {
    w.eval(`const renderSafeMarkdown = SafeMarkdown.renderSafeMarkdown;
      const chatMessages = document.getElementById('chatMessages');
      function normalizeRenderedAssets() {} function enhanceCodeBlocks() {} function enhanceTables() {}
      function appendAssistantMessageActions() {} function scrollToBottom() {} function soulName() { return 'AI'; }
      const isNearChatBottom = false;
      ${functionSource('renderMarkdownContent')}
      ${functionSource('addMessage')}
      window.rendererFixture = { renderMarkdownContent, addMessage };`);
    for (const payload of payloads) {
      const message = w.rendererFixture.addMessage('assistant', payload, [], { messageIndex: 0 });
      const content = message.querySelector('.message-content'); assertSafe(content);
      for (let i = 1; i <= payload.length; i++) {
        w.rendererFixture.renderMarkdownContent(content, payload.slice(0, i), false);
        assertSafe(content);
      }
      w.rendererFixture.renderMarkdownContent(content, payload, true); assertSafe(content);
    }
    assert.doesNotMatch(app, /marked\.parse\s*\(/);
    assert.equal((app.match(/innerHTML = renderSafeMarkdown\(/g) || []).length, 2);
  } finally { w.close(); }
});
test('local-only script/style inventory supports strict script CSP without inline exceptions', () => {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8'));
  try {
    for (const script of dom.window.document.querySelectorAll('script')) {
      assert.ok(script.hasAttribute('src')); assert.equal(script.textContent.trim(), '');
      assert.doesNotMatch(script.src, /^(?:https?:)?\/\//);
      assert.ok(fs.existsSync(path.join(RENDERER, script.getAttribute('src'))));
    }
    for (const link of dom.window.document.querySelectorAll('link[rel="stylesheet"]')) assert.doesNotMatch(link.href, /^(?:https?:)?\/\//);
    for (const node of dom.window.document.querySelectorAll('*')) for (const attribute of node.attributes) assert.doesNotMatch(attribute.name, /^on/i);
    assert.doesNotMatch(app, /\bon[a-z]+\s*=\s*["']/i);
    assert.doesNotMatch(app, /\beval\s*\(|new\s+Function\s*\(/);
  } finally { dom.window.close(); }
  require('../scripts/vendor-renderer.cjs').vendor(true);
});
test('fragment and legacy pairing credentials are scrubbed before the first fetch', async () => {
  for (const url of ['https://iexa.test/?keep=1#pair=secret', 'https://iexa.test/?pair=secret&keep=1', 'https://iexa.test/?keep=1&pair=secret#tab=devices']) {
    for (const authenticated of [false, true]) {
      const dom = fixture(url); const w = dom.window; const calls = [];
      try {
        w.document.body.innerHTML += '<div id="mobilePairGate"></div><div id="mobilePairMessage"></div><button id="mobilePairRetry"></button>';
        w.fetch = async (request, options) => {
          assert.ok(!w.location.href.includes('secret')); assert.ok(!w.location.href.includes('pair='));
          assert.equal(new URL(w.location.href).searchParams.get('keep'), '1');
          calls.push({ request, options });
          return { ok: true, json: async () => request.endsWith('client-status') ? { authenticated, bridgeEnabled: true } : { device: { capability: 'chat' } } };
        };
        w.eval(`const API_BASE = ''; function mobileDeviceName() { return 'test'; } ${functionSource('verifyMobileAccess')}`);
        assert.equal(await w.verifyMobileAccess(), true);
        assert.equal(calls.length, authenticated ? 1 : 2);
        if (!authenticated) assert.equal(JSON.parse(calls[1].options.body).token, 'secret');
      } finally { w.close(); }
    }
  }
});
test('download verification fails closed on mismatched, missing or duplicate official checksums', async () => {
  const { expectedChecksum, verifyArchive, sha256 } = require('../download_electron.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-sha-test-'));
  try {
    const file = path.join(dir, 'fixture.zip'); fs.writeFileSync(file, 'fixture');
    const hash = await sha256(file);
    assert.equal(expectedChecksum(`${hash} *fixture.zip\r\n`, 'fixture.zip'), hash);
    assert.throws(() => expectedChecksum(`${hash} other.zip`, 'fixture.zip'));
    assert.throws(() => expectedChecksum(`${hash} fixture.zip\n${hash} fixture.zip`, 'fixture.zip'));
    await verifyArchive(file, hash);
    await assert.rejects(verifyArchive(file, '0'.repeat(64)), /SHA256 mismatch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('real Chromium fixture sanitizes under strict self-only script CSP', { timeout: 45000 }, async (t) => {
  const candidates = [process.env.IEXA_TEST_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  const browser = candidates.find(file => fs.existsSync(file));
  if (!browser) return t.skip('Set IEXA_TEST_BROWSER to a Chromium executable for this optional browser fixture');
  const runner = `const root = document.getElementById('fixture');
    try {
      for (const source of ${JSON.stringify(payloads)}) {
        root.innerHTML = SafeMarkdown.renderSafeMarkdown(source);
        if (root.querySelector('script,style,svg,math,iframe,object,form,input,button')) throw Error('active element');
        for (const node of root.querySelectorAll('*')) for (const attr of node.attributes) {
          if (/^on|^data-|^(style|srcset|id|name)$/i.test(attr.name)) throw Error('active attribute');
        }
      }
      if (window.SECURITY_EXECUTED) throw Error('event executed');
      document.getElementById('result').textContent = 'PASS';
    } catch (error) { document.getElementById('result').textContent = 'FAIL:' + error; }`;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; script-src-attr 'none'; img-src 'none'; base-uri 'none'");
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="fixture"></div><output id="result">PENDING</output>' + scripts.map(file => `<script src="/${file}"></script>`).join('') + '<script src="/runner.js"></script>'); }
    else if (request.url === '/runner.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(runner); }
    else if (scripts.includes(request.url.slice(1))) { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(RENDERER, request.url.slice(1)))); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-chrome-test-'));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/`], { windowsHide: true });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Browser fixture timeout')); }, 35000);
      child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(stderr)); });
    });
    assert.match(output, /<output id="result">PASS<\/output>/);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // The randomly allocated, absolute temporary profile is this fixture's only cleanup target.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('CSP data-action migration dispatches literal arguments without invoking ancestor actions', async () => {
  const dom = fixture(); const w = dom.window; const calls = [];
  try {
    const start = app.indexOf('const rendererActions =');
    const end = app.indexOf('// Post-process rendered markdown', start);
    const registry = app.slice(start, end);
    for (const [, name] of registry.matchAll(/^  (\w+):/gm)) w[name] = argument => calls.push([name, argument]);
    w.eval(registry);
    const card = w.document.createElement('div');
    card.dataset.uiAction = 'activateProfile'; card.dataset.uiArg = 'parent';
    const button = w.document.createElement('button');
    button.dataset.uiAction = 'editProfile'; button.dataset.uiArg = "quoted'\";notExecutable()";
    card.appendChild(button); w.document.body.appendChild(card);
    button.click(); await Promise.resolve();
    assert.deepEqual(calls, [['editProfile', "quoted'\";notExecutable()"]]);
    const injected = w.document.createElement('div'); injected.className = 'message-content';
    injected.innerHTML = w.SafeMarkdown.renderSafeMarkdown('<a data-ui-action="deleteSession" data-ui-arg="victim">malicious</a>');
    w.document.body.appendChild(injected); injected.querySelector('a').click(); await Promise.resolve();
    assert.equal(calls.length, 1);
  } finally { w.close(); }
});
test('lockfile-based packaging preserves nested production dependencies and omits dev packages', () => {
  const { copyProductionDependencies } = require('../scripts/package-production.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-package-test-'));
  const appDir = path.join(dir, 'app');
  try {
    const packages = { '': {}, 'node_modules/parent': { version: '1.0.0' },
      'node_modules/parent/node_modules/child': { version: '2.0.0' },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
      'node_modules/platform-optional': { version: '1.0.0', optional: true } };
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    for (const name of ['node_modules/parent', 'node_modules/parent/node_modules/child', 'node_modules/dev-only']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ version: packages[name].version }));
    }
    assert.equal(copyProductionDependencies(dir, appDir), 2);
    assert.ok(fs.existsSync(path.join(appDir, 'node_modules/parent/node_modules/child/package.json')));
    assert.equal(fs.existsSync(path.join(appDir, 'node_modules/dev-only')), false);
    fs.writeFileSync(path.join(dir, 'node_modules/parent/package.json'), '{"version":"9.0.0"}');
    assert.throws(() => copyProductionDependencies(dir, appDir), /version differs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ranged download validates byte ranges, caps bodies and removes partial files on failure', async () => {
  const { downloadRanged } = require('../scripts/download-ranged.cjs');
  const originalFetch = global.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-range-test-'));
  try {
    for (const mode of ['valid', 'wrong-range', 'oversized', 'downgrade']) {
      global.fetch = async (url, options) => {
        if (options.method === 'HEAD') {
          if (mode === 'downgrade') return new Response(null, { status: 302, headers: { location: 'http://untrusted.test/file' } });
          return new Response(null, { status: 200, headers: { 'content-length': '3' } });
        }
        return new Response(mode === 'oversized' ? 'oversize' : 'abc', { status: 206,
          headers: { 'content-range': mode === 'wrong-range' ? 'bytes 1-3/4' : 'bytes 0-2/3' } });
      };
      const dest = path.join(dir, mode + '.zip');
      if (mode === 'valid') {
        await downloadRanged('https://official.test/file', dest);
        assert.equal(fs.readFileSync(dest, 'utf8'), 'abc');
      } else {
        await assert.rejects(downloadRanged('https://official.test/file', dest), /range|HTTPS/);
        assert.equal(fs.existsSync(dest), false);
      }
      assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.download')), false);
    }
  } finally { global.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});
