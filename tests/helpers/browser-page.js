/**
 * One page per test, from one Chrome when a runner provides it.
 *
 * Every browser test used to spawn its own Chrome: about two seconds of cold
 * start, times 52 files, which is most of the suite's wall clock. When
 * `IEXA_TEST_CDP_HTTP` is set the page comes from a shared instance instead —
 * a fresh tab on its own port, so localStorage and cookies stay isolated by
 * origin. Without the variable the old spawn path runs unchanged, which keeps
 * `node --test tests/browser-whatever.test.js` working on its own.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tempDir = require('./temp-dir');

const CHROME_CANDIDATES = [
  process.env.IEXA_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(socket, timeoutMs = 15000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = (error) => { clearTimeout(timer); reject(error); };
  });
  return socket;
}

/** Attach to a tab the runner's shared Chrome already owns. */
async function fromShared(chromeHttp) {
  const created = await fetch(`${chromeHttp}/json/new?about:blank`, { method: 'PUT' }).then((r) => {
    if (!r.ok) throw new Error('shared Chrome refused a new tab: ' + r.status);
    return r.json();
  });
  const socket = await connect(new WebSocket(created.webSocketDebuggerUrl));
  // Background tabs get their rAF paused and timers throttled. Tests here drive
  // animations and scroll positions, so tell Chromium this tab is focused and
  // active even though it is one of many.
  const cdp = client(socket);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  return {
    socket,
    shared: true,
    close: async () => {
      try { await fetch(`${chromeHttp}/json/close/${created.id}`); } catch { /* already gone */ }
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

/** Spawn a private Chrome, exactly as every test did before. */
async function fromOwnProcess() {
  const chrome = CHROME_CANDIDATES.find((file) => file && fs.existsSync(file));
  if (!chrome) throw new Error('no Chrome/Edge found; set IEXA_TEST_BROWSER');
  const profile = tempDir.make('iexa-browser-');
  const proc = spawn(chrome, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('browser startup timeout')), 20000);
    proc.stderr.on('data', (data) => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  const socket = await connect(new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl));

  return {
    socket,
    shared: false,
    close: async () => {
      try { socket.close(); } catch { /* closed */ }
      if (proc.exitCode === null) {
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        try { proc.kill(); } catch { /* gone */ }
        // Deletion only succeeds once the browser has released its profile
        // handles, so wait for the real exit instead of guessing a delay.
        await Promise.race([exited, sleep(3000)]);
      }
      tempDir.remove(profile);
    },
  };
}

async function launchPage(options = {}) {
  const shared = process.env.IEXA_TEST_CDP_HTTP;
  // A few tests change behaviour that belongs to the browser process rather than
  // the page — download handling, for one — and only behave inside a dedicated
  // instance. `{ isolated: true }` keeps those on the old path.
  return shared && !options.isolated ? fromShared(shared) : fromOwnProcess();
}

/** Minimal CDP client: one pending map, per-call timeout. */
function client(socket, defaultTimeoutMs = 10000) {
  let sequence = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(message.id);
    entry.resolve(message);
  };
  return {
    send(method, params = {}, timeoutMs = defaultTimeoutMs) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, timeoutMs);
        waiting.set(id, { resolve, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

module.exports = { launchPage, client };
