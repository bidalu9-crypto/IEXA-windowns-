const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Timed out waiting for Edge');
}

async function main() {
  const edge = process.env.IEXA_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'iexa-browser-smoke-'));
  process.env.IEXA_WORKSPACE = path.join(temp, 'workspace');
  const { startServer } = require('../dist/main/server');
  const server = await startServer(0, false, '127.0.0.1');
  const appPort = server.address().port;
  const debugPort = await freePort();
  const edgeProcess = spawn(edge, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temp, 'edge')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `http://127.0.0.1:${appPort}/`,
  ], { windowsHide: true, stdio: 'ignore' });

  let socket;
  try {
    const target = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      return targets.find((item) => item.type === 'page' && item.url.includes(`127.0.0.1:${appPort}`));
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(frame.error.message)); else entry.resolve(frame.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    };

    await send('Runtime.enable');
    await waitFor(async () => evaluate("typeof window.IexaPermissionDialog === 'object'"));
    const hitTest = await evaluate(`(() => {
      window.__permissionCalls = [];
      window.IexaApi.json = async (url, options) => { window.__permissionCalls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; };
      const blocker = document.createElement('div');
      blocker.id = 'permission-smoke-blocker';
      Object.assign(blocker.style, { position: 'fixed', inset: '0', zIndex: '1500', pointerEvents: 'auto' });
      document.body.appendChild(blocker);
      window.IexaPermissionDialog.show({ id: 'perm_browser', tool: { name: 'shell_execute', risk: 'high' }, args: { command: 'reg query HKCU' } }, { onError: (error) => { throw new Error(error); } });
      const overlay = document.querySelector('.permission-dialog-overlay');
      const button = [...overlay.querySelectorAll('button')].find((item) => item.textContent === '允许一次');
      const rect = button.getBoundingClientRect();
      return { zIndex: getComputedStyle(overlay).zIndex, buttonIsTopElement: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button };
    })()`);
    assert.deepEqual(hitTest, { zIndex: '10000', buttonIsTopElement: true });
    await evaluate("document.querySelector('.permission-action-secondary').click(); new Promise((resolve) => setTimeout(() => resolve({ calls: window.__permissionCalls, open: Boolean(document.querySelector('.permission-dialog-overlay')) }), 20))");
    const result = await evaluate("({ calls: window.__permissionCalls, open: Boolean(document.querySelector('.permission-dialog-overlay')) })");
    assert.deepEqual(result, { calls: [{ url: '/api/permissions/approve', body: { id: 'perm_browser', scope: 'once' } }], open: false });
    console.log(JSON.stringify({ ok: true, browser: 'Edge Chromium', hitTest, decision: result.calls[0] }));
  } finally {
    try { socket?.close(); } catch {}
    if (edgeProcess.pid) spawnSync('taskkill.exe', ['/pid', String(edgeProcess.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
