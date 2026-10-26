// Render the title cards with Chrome so typography is exactly what the edit uses.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUT = path.resolve('.video-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARD = (title, subtitle, footer) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; }
  body {
    background: #131318;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    display: grid; place-items: center;
    position: relative;
  }
  /* Two soft radial washes keep the flat fill from looking like a solid colour. */
  .glow-a {
    position: absolute; width: 1400px; height: 1400px; border-radius: 50%;
    left: 50%; top: 42%; transform: translate(-50%, -50%);
    background: radial-gradient(circle, rgba(124,108,240,0.22) 0%, rgba(124,108,240,0) 62%);
  }
  .glow-b {
    position: absolute; width: 900px; height: 900px; border-radius: 50%;
    left: 18%; top: 78%;
    background: radial-gradient(circle, rgba(56,189,248,0.14) 0%, rgba(56,189,248,0) 65%);
  }
  .stage { position: relative; display: flex; flex-direction: column; align-items: center; }
  .mark { width: 168px; height: 168px; margin-bottom: 44px; }
  h1 {
    font-size: 104px; font-weight: 700; letter-spacing: 0.06em;
    color: #f4f4f6; line-height: 1;
  }
  .rule {
    width: 84px; height: 3px; margin: 34px 0 30px;
    background: linear-gradient(90deg, #7c6cf0, #38bdf8);
    border-radius: 2px;
  }
  p {
    font-size: 34px; font-weight: 400; letter-spacing: 0.04em;
    color: #a6a6b2; line-height: 1.5;
  }
  .footer {
    position: absolute; left: 0; right: 0; bottom: 78px;
    text-align: center; font-size: 22px; letter-spacing: 0.22em;
    color: #5d5d68; text-transform: uppercase;
  }
</style></head>
<body>
  <div class="glow-a"></div><div class="glow-b"></div>
  <div class="stage">
    <img class="mark" src="file:///${path.join(process.cwd(), 'resources', 'icon.png').replace(/\\/g, '/')}">
    <h1>${title}</h1>
    <div class="rule"></div>
    <p>${subtitle}</p>
  </div>
  <div class="footer">${footer}</div>
</body></html>`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((f) => fs.existsSync(f));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-cards-'));
  const cards = [
    ['00-intro', CARD('IEXA-WIN', '把 AI 代理放进你的 Windows 桌面', 'Private AI Agent for Windows')],
    ['12-outro', CARD('IEXA-WIN', '你的私有 Windows AI 代理', 'Local-first · Apache 2.0')],
  ];
  for (const [name, html] of cards) fs.writeFileSync(path.join(dir, `${name}.html`), html, 'utf8');

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', '--force-device-scale-factor=1',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    chrome.stderr.on('data', (d) => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    chrome.once('error', reject);
    setTimeout(() => reject(new Error('chrome timeout')), 20000);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  const socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });

  let seq = 0; const waiting = new Map();
  socket.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } };
  const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); socket.send(JSON.stringify({ id, method, params })); });

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  for (const [name] of cards) {
    await cdp('Page.navigate', { url: `file:///${path.join(dir, name + '.html').replace(/\\/g, '/')}` });
    await sleep(1200);
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log('card', name, (fs.statSync(path.join(OUT, `${name}.png`)).size / 1024).toFixed(0) + ' KB');
  }

  socket.close();
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
