// Capture the feature set for the promo video.
// Seeds a throwaway workspace with realistic data, then screenshots each view at
// 2x so the 1080p edit has room to zoom without softening.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUT = path.resolve('.video-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-video-'));
const projectDir = path.join(workspace, 'IEXA-WIN');
fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

// ---- seed: a conversation that shows thinking, tools, a plan and usage ----
const now = Date.now();
const SESSION = 'sess_promo';
const messages = [
  { role: 'user', content: '把设置页的保存按钮改成有反馈的，保存后要能看出成功了。', timestamp: now - 300000 },
  {
    role: 'assistant', content: '', status: 'done', timestamp: now - 298000,
    thinking: '先看设置页现在怎么保存，再决定是加 toast 还是改按钮文案。改之前要确认没有其他地方复用这个按钮。',
    thinkingLevel: 'high', durationMs: 8400, generationMs: 5200, firstTokenMs: 900,
    usage: { inputTokens: 48210, outputTokens: 1284, cacheReadInputTokens: 39800 },
    toolCalls: [
      { id: 'c1', name: 'grep', args: { tool_title: '定位保存按钮', pattern: 'settingSave|save-settings', path: 'src/renderer' },
        result: { success: true, output: 'src/renderer/services/Settings.js:142:  saveBtn.addEventListener(...)\nsrc/renderer/index.html:318: id="saveSettingsBtn"', durationMs: 128 } },
      { id: 'c2', name: 'file_read', args: { tool_title: '读保存逻辑', path: 'src/renderer/services/Settings.js' },
        result: { success: true, output: '142  saveBtn.addEventListener(\'click\', async () => {\n143    await fetch(\'/api/settings\', { method: \'PUT\', body });\n144    closeDialog();\n145  });', durationMs: 42 } },
      { id: 'c3', name: 'file_edit', args: { tool_title: '加保存反馈', path: 'src/renderer/services/Settings.js', old_string: 'closeDialog();', new_string: 'flashSaved(); closeDialog();' },
        result: { success: true, output: 'Edited src/renderer/services/Settings.js (+1 -1)', durationMs: 96 } },
    ],
    plan: [
      { content: '定位保存按钮与保存逻辑', status: 'completed' },
      { content: '加保存成功反馈', status: 'completed' },
      { content: '补一条断言防止回归', status: 'in_progress' },
      { content: '跑全量测试', status: 'pending' },
    ],
  },
  {
    role: 'assistant', content: '改好了。保存成功后按钮会短暂显示「已保存」，1.2 秒后复原；同时补了一条真实浏览器用例，断言点击后按钮文案确实变化，避免以后又被改回去。',
    status: 'done', timestamp: now - 240000, durationMs: 6200,
    usage: { inputTokens: 52100, outputTokens: 640, cacheReadInputTokens: 44000 },
  },
];
fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${SESSION}.json`), JSON.stringify(messages));
fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
  activeSessionId: SESSION,
  sessions: [
    { id: SESSION, title: '设置页保存反馈', titleSource: 'message', created: now - 300000, updated: now - 240000,
      messageCount: messages.length, projectRoot: projectDir, projectName: 'IEXA-WIN' },
    { id: 'sess_insights', title: '上下文洞察页面', titleSource: 'message', created: now - 900000, updated: now - 800000,
      messageCount: 4, projectRoot: projectDir, projectName: 'IEXA-WIN' },
    { id: 'sess_chart', title: '测试用例增长趋势', titleSource: 'message', created: now - 1800000, updated: now - 1700000,
      messageCount: 2, projectRoot: projectDir, projectName: 'IEXA-WIN' },
  ],
}));

// Insight data needs many turns so the dashboard has something to draw.
const insightMessages = [];
for (let i = 0; i < 24; i += 1) {
  const at = now - (24 - i) * 600000;
  insightMessages.push({ role: 'user', content: `第 ${i + 1} 轮：检查模块 ${i % 6}。`, timestamp: at });
  insightMessages.push({
    role: 'assistant', content: `结论 ${i}：已确认。`, status: 'done', timestamp: at + 9000,
    thinking: '先看调用链，再确认边界。', durationMs: 9200, generationMs: 6100, firstTokenMs: 700,
    usage: { inputTokens: 18000 + i * 900, outputTokens: 320 + i * 30, cacheReadInputTokens: 12000 + i * 700 },
    toolCalls: [
      { id: `i${i}a`, name: 'file_read', args: { tool_title: '读文件', path: `src/m${i % 6}.ts` }, result: { success: true, output: 'ok', durationMs: 120 } },
      { id: `i${i}b`, name: 'grep', args: { tool_title: '搜符号', pattern: 'handler' }, result: { success: true, output: 'ok', durationMs: 88 } },
      { id: `i${i}c`, name: 'shell_execute', args: { tool_title: '跑测试', command: 'npm test' }, result: { success: true, output: 'ok', durationMs: 2400 } },
    ],
  });
}
fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_insights.json'), JSON.stringify(insightMessages));

// A conversation whose reply gets a chart appended at capture time.
fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_chart.json'), JSON.stringify([
  { role: 'user', content: '把测试用例的增长画成图。', timestamp: now - 1800000 },
  { role: 'assistant', content: '按版本推进的顺序画好了，能看到 960 那一步是图表与文档功能带来的跳升。',
    status: 'done', timestamp: now - 1790000, durationMs: 4100,
    usage: { inputTokens: 9200, outputTokens: 210, cacheReadInputTokens: 6100 } },
]));

const chartSpec = {
  type: 'line', title: 'IEXA 全量测试用例数',
  categories: ['插件页', '暂停继续', '截图标注', '桌宠', '上下文洞察', '工具手册', '移动端窗口', '图表+文档'],
  series: [{ name: '用例数', values: [809, 818, 819, 835, 846, 871, 896, 960] }],
};

// A Markdown file for the document workspace.
const docPath = path.join(projectDir, '发布说明.md');
fs.writeFileSync(docPath, [
  '# IEXA-WIN 1.0.5 发布说明',
  '',
  '## 新增',
  '',
  '- **交互式图表**：模型输出 chart 围栏即可渲染折线或柱状图，可悬停、可切换表格。',
  '- **文档工作区**：分栏预览、自动保存、撤销重做、文档内搜索。',
  '- **实时渲染**：图表在围栏闭合的那一刻出现，不必等回合结束。',
  '',
  '## 修复',
  '',
  '- 暂停后继续会新建空气泡。',
  '- 最终总结里图片不显示。',
  '- Ctrl+= 无法放大。',
  '',
  '## 已知限制',
  '',
  '- 图表暂不支持饼图与堆叠。',
  '- 文档导出 PDF 尚未实现。',
].join('\n'), 'utf8');

process.env.IEXA_WORKSPACE = workspace;
const backend = require(path.join(root, 'dist/main/server'));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((f) => fs.existsSync(f));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const creds = backend.getServerCredentials(server);
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${creds.token}` };
  const json = { ...auth, 'Content-Type': 'application/json' };

  for (const [id, model, provider] of [
    ['p_claude', 'claude-opus-4-8', 'anthropic'],
    ['p_ds', 'deepseek-v4.1-flash', 'deepseek'],
    ['p_gpt', 'gpt-6-astra', 'custom'],
  ]) {
    await fetch(`${base}/api/profiles`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ id, name: model, provider, model, apiKey: 'sk-promo', baseURL: '', contextWindow: 200000, maxOutputTokens: 8192 }),
    });
  }
  await fetch(`${base}/api/profiles`, { method: 'PUT', headers: json, body: JSON.stringify({ activeProfileId: 'p_claude' }) });
  await fetch(`${base}/api/appearance`, {
    method: 'PUT', headers: json,
    body: JSON.stringify({ theme: 'dark', accent: 'violet', radius: 12, fontScale: 1 }),
  }).catch(() => {});
  await fetch(`${base}/api/scheduled-tasks`, {
    method: 'POST', headers: json,
    body: JSON.stringify({
      title: '每日构建检查', prompt: '检查昨晚的构建产物与测试结果，有失败就列出原因。',
      profileId: 'p_claude', schedule: { frequency: 'daily', time: '09:00' }, enabled: true,
    }),
  }).catch(() => {});
  await fetch(`${base}/api/scheduled-tasks`, {
    method: 'POST', headers: json,
    body: JSON.stringify({
      title: '每周依赖审计', prompt: '跑 npm audit，把新增的高危项按包名和修复版本列出来。',
      profileId: 'p_claude', schedule: { frequency: 'weekly', time: '18:00', weekday: 1 }, enabled: true,
    }),
  }).catch(() => {});
  const sprite = fs.readFileSync(path.join(root, 'resources', 'icon.png'));
  await fetch(`${base}/api/pet/sprite`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: sprite }).catch(() => {});

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-video-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`, 'about:blank',
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
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 240) };
    return r.result?.result?.value;
  };
  const wait = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await ev(expr)) return true; await sleep(120); }
    return false;
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `${base}/#login=${creds.loginCode}` });
  await wait("typeof currentSessionId !== 'undefined' && !!currentSessionId");
  await sleep(1400);

  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('shot', name.padEnd(20), (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
  };
  const go = async (view) => {
    await ev(`(() => { document.querySelector('.nav-btn[data-view="${view}"]')?.click(); return true; })()`);
    await sleep(1000);
  };

  // 1. landing
  await go('chat');
  await ev("void createSession(); true");
  await sleep(1600);
  await shot('01-hero');

  // 2. conversation, tool rail expanded
  await ev(`void switchSession('${SESSION}'); true`);
  await wait("document.querySelectorAll('#chatMessages .message').length >= 2");
  await sleep(1000);
  const expanded = await ev(`(() => {
    const summaries = [...document.querySelectorAll('.turn-summary')];
    summaries.forEach((s) => { if (s.getAttribute('aria-expanded') === 'false') s.click(); });
    return summaries.length;
  })()`);
  console.log('turn summaries:', expanded);
  await sleep(900);
  await shot('02-chat');
  await ev("(() => { const c = document.getElementById('chatMessages'); c.scrollTop = c.scrollHeight; return true; })()");
  await sleep(800);
  await shot('03-chat-detail');

  // 4. insights
  await go('token-calculator');
  await sleep(2400);
  await shot('04-insights');

  // 5. chart
  await go('chat');
  await ev("void switchSession('sess_chart'); true");
  await wait("document.querySelectorAll('#chatMessages .message').length >= 2");
  await sleep(900);
  const chartCount = await ev(`(() => {
    const spec = ${JSON.stringify(JSON.stringify(chartSpec))};
    const fence = String.fromCharCode(96).repeat(3);
    const nl = String.fromCharCode(10);
    const md = '这是各版本的全量用例数：' + nl + nl + fence + 'chart' + nl + spec + nl + fence + nl;
    const host = document.getElementById('chatMessages');
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const body = document.createElement('div');
    body.className = 'message-content';
    msg.appendChild(body);
    host.appendChild(msg);
    renderMarkdownContent(body, md, true);
    window.IexaChart?.enhance(host);
    return document.querySelectorAll('.chart-card').length;
  })()`);
  console.log('chart cards:', chartCount);
  await sleep(900);
  await ev("(() => { const c = document.getElementById('chatMessages'); c.scrollTop = c.scrollHeight; return true; })()");
  await sleep(700);
  await shot('05-chart');

  // 6. document workspace
  await go('doc');
  await sleep(600);
  const docOpened = await ev(`(async () => { await window.IexaDoc.openFile(${JSON.stringify(docPath.replace(/\\/g, '/'))}); return document.getElementById('docEditor')?.value?.length || 0; })()`);
  console.log('doc chars:', docOpened);
  await sleep(1500);
  await shot('06-doc');

  // 7. screenshot annotation overlay
  await go('chat');
  await sleep(500);
  const shotApi = await ev("(() => { const s = window.IexaScreenshot; return s ? Object.keys(s).join(',') : 'none'; })()");
  console.log('screenshot api:', shotApi);
  await shot('07-chat-idle');

  // 8. appearance
  await go('appearance');
  await sleep(1400);
  await shot('08-appearance');

  // 9. scheduled tasks
  await go('scheduled');
  await sleep(1400);
  await shot('09-scheduled');

  // 10. desktop pet
  await go('pet');
  await sleep(1800);
  await shot('10-pet');

  // 11. paused banner
  await go('chat');
  await ev(`void switchSession('${SESSION}'); true`);
  await sleep(1000);
  const paused = await ev(`(() => {
    const runtime = runtimeForSession(currentSessionId);
    if (runtime) runtime.pausedTurn = { toolCalls: 3 };
    window.syncPausedBanner?.();
    return document.getElementById('pausedBanner')?.hidden === false;
  })()`);
  console.log('paused banner:', paused);
  await sleep(800);
  await shot('11-paused');

  // 12. settings
  await go('settings');
  await sleep(1400);
  await shot('12-settings');

  socket.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ }
  try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ }
  console.log('done ->', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
