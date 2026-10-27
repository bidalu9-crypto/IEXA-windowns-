// Boot one Chrome for the whole run and export it to the tests, so 52 files stop
// paying for 52 cold starts. Without this the variable is unset and each file
// falls back to its own process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CANDIDATES = [
  process.env.IEXA_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startSharedChrome() {
  const chrome = CANDIDATES.find((f) => f && fs.existsSync(f));
  if (!chrome) throw new Error('no Chrome/Edge found for the shared browser');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-shared-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('shared Chrome startup timeout')), 25000);
    proc.stderr.on('data', (data) => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  const endpoint = new URL(wsUrl);
  const http = `http://${endpoint.host}`;
  // Wait until the HTTP endpoint answers, not just until the socket is announced.
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`${http}/json/version`); break; } catch { await sleep(100); }
  }

  return {
    http,
    async stop() {
      if (proc.exitCode === null) { try { proc.kill(); } catch { /* gone */ } }
      await sleep(600);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ }
    },
  };
}

module.exports = { startSharedChrome };
