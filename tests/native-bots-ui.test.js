'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/services/BotsView.js'), 'utf8');
const payloadKeys = ['allowedTools', 'description', 'memory', 'name', 'persona', 'profileId'];
const hostile = '<img src=x onerror="alert(1)"><script>alert(1)</script>';

function setup(t, options = {}) {
  const dom = new JSDOM('<body><button class="nav-btn" data-view="bots">Bot 团队</button><button class="nav-btn" data-view="chat">对话</button><section id="view-bots"></section></body>', {
    runScripts: 'outside-only', url: 'http://localhost',
  });
  const w = dom.window;
  const d = w.document;
  t.after(() => w.close());
  // jsdom has no native dialog presentation. Keep the production close lifecycle.
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const state = {
    bots: options.bots ?? [{ id: 'bot/1', name: '审查助手', description: '代码审查', persona: '先给结论', memory: '使用中文', profileId: 'p1', updated: 1000 }],
    profiles: [{ id: 'p1', name: '模型一', model: 'test-one' }, { id: 'p2', name: '模型二', model: 'test-two' }],
    calls: [], confirmations: [], switched: [], navigation: [], histories: [{ id: 'old', modelBinding: { profileId: 'p1' } }],
    tools: [{ name: 'shell_execute', description: '执行程序' }, { name: 'file_read', description: '读取文件' }],
    packages: [{ format: 'iexa-bot', version: 1, bot: { name: '模板', persona: hostile, allowedTools: ['file_read'], memory: '模板记忆' } }],
    teams: [], imports: [], downloads: [], timers: new Map(), timerId: 0,
    confirm: true, profileError: false, saveError: false, switchError: false, cancelError: false,
  };
  w.API_BASE = '';
  w.setTimeout = (callback, delay) => { const id = ++state.timerId; state.timers.set(id, { callback: () => { state.timers.delete(id); callback(); }, delay }); return id; };
  w.clearTimeout = id => state.timers.delete(id);
  w.URL.createObjectURL = blob => { state.downloads.push(blob); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { state.filename = this.download; };
  d.querySelector('[data-view="bots"]').addEventListener('click', () => d.getElementById('view-bots').classList.add('active'));
  d.querySelector('[data-view="chat"]').addEventListener('click', () => d.getElementById('view-bots').classList.remove('active'));
  w.IexaDialogs = { confirm: async message => { state.confirmations.push(message); return state.confirm; } };
  w.switchSession = async id => {
    state.navigation.push(`switch:${id}`);
    if (state.switchError) throw new Error('会话切换失败');
    state.switched.push(id);
  };
  w.loadSessionList = async () => state.navigation.push('reload');
  d.querySelector('[data-view="chat"]').addEventListener('click', () => state.navigation.push('chat'));
  w.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    state.calls.push({ url, method, body: init.body });
    let status = 200;
    let data;
    if (url === '/api/bots/tools') data = { tools: state.tools };
    else if (url === '/api/bots/catalog') data = { packages: state.packages };
    else if (url === '/api/bots/convert-tobs') {
      const payload = JSON.parse(init.body);
      data = { package: { format: 'iexa-bot', version: 1, bot: { name: payload.descriptor.name, description: '转换简介', persona: payload.persona, memory: 'not imported', allowedTools: ['shell_execute'] } }, warning: hostile };
    }
    else if (url === '/api/bots/import' && method === 'POST') {
      const payload = JSON.parse(init.body); state.imports.push(payload);
      const bot = { id: 'imported', ...payload.package.bot, profileId: payload.profileId };
      state.bots.push(bot); data = { bot };
    } else if (url.endsWith('/export')) data = { format: 'iexa-bot', version: 1, bot: { ...state.bots[0], memory: 'SECRET_MEMORY' } };
    else if (url === '/api/bot-teams' && method === 'GET') data = { teams: state.teams };
    else if (url === '/api/bot-teams' && method === 'POST') {
      const body = JSON.parse(init.body);
      const team = { id: 'team/1', goal: body.goal, status: 'planning', tasks: body.botIds.map(botId => ({ botId, instruction: '计划中', status: 'pending' })) };
      state.teams.push(team); data = { team };
    } else if (url === '/api/bot-teams/team%2F1/cancel') {
      status = state.cancelError ? 500 : 200;
      data = state.cancelError ? { error: '取消失败' } : { team: { ...state.teams[0], status: 'cancelling' } };
    } else if (url === '/api/profiles') {
      status = state.profileError ? 503 : 200;
      // The minimal backend contract does not require activeProfileId.
      data = state.profileError ? { error: '配置暂不可用' } : { profiles: state.profiles };
    } else if (url === '/api/bots' && method === 'GET') {
      data = { bots: state.bots };
    } else if (method === 'POST' && url === '/api/bots') {
      if (state.saveError) { status = 400; data = { error: hostile }; }
      else {
        const bot = { id: 'created', ...JSON.parse(init.body) };
        state.bots.push(bot);
        data = { bot };
      }
    } else if (url === '/api/bots/bot%2F1' && method === 'PUT') {
      Object.assign(state.bots[0], JSON.parse(init.body));
      data = { bot: state.bots[0] };
    } else if (url === '/api/bots/bot%2F1/chat' && method === 'POST') {
      const session = { id: 'new-session', modelBinding: { profileId: state.bots[0].profileId } };
      state.histories.push(session);
      data = { session };
    } else if (url === '/api/bots/bot%2F1' && method === 'DELETE') {
      state.bots = state.bots.filter(bot => bot.id !== 'bot/1');
      data = { ok: true };
    } else {
      status = 404;
      data = { error: `Unexpected request: ${method} ${url}` };
    }
    return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(data)) };
  };
  w.eval(source);
  const click = (label, parent = d) => {
    const target = [...parent.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(target, `button exists: ${label}`);
    assert.equal(target.disabled, false, `button enabled: ${label}`);
    target.click();
  };
  const idle = async () => {
    for (let turn = 0; turn < 100; turn++) {
      await new Promise(resolve => setImmediate(resolve));
      if (d.getElementById('view-bots').getAttribute('aria-busy') === 'false') return;
    }
    assert.fail('Bot UI did not become idle');
  };
  const submit = () => d.querySelector('dialog form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { w, d, state, click, idle, submit, open: async () => { await new Promise(resolve => setImmediate(resolve)); click('Bot 团队'); await idle(); } };
}

test('native Bot entry uses existing navigation and external CSP-safe resources', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html);
  try {
    const d = dom.window.document;
    assert.equal(d.querySelector('.nav-btn[data-view="bots"] span').textContent, 'Bot 团队');
    assert.ok(d.querySelector('#view-bots.view'));
    assert.ok(d.querySelector('link[href="styles/bots.css"]'));
    const scripts = [...d.querySelectorAll('script[src]')].map(node => node.getAttribute('src'));
    assert.ok(scripts.indexOf('services/BotsView.js') < scripts.indexOf('app.js'));
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  } finally { dom.window.close(); }
});

test('active Bot pane defers requests until app globals are initialized', async t => {
  const dom = new JSDOM('<button class="nav-btn" data-view="bots"></button><section class="active" id="view-bots"></section>', {
    runScripts: 'outside-only', url: 'http://localhost',
  });
  const w = dom.window;
  t.after(() => w.close());
  const calls = [];
  w.fetch = async url => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ profiles: [], bots: [], tools: [], teams: [] }) };
  };
  // API_BASE is in the temporal dead zone during the service's evaluation.
  w.eval(`${source}\nconst API_BASE = '/ready';`);
  assert.deepEqual(calls, [], 'no request during service evaluation');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.sort(), ['/ready/api/bot-teams', '/ready/api/bots', '/ready/api/bots/tools', '/ready/api/profiles']);
  assert.equal(w.document.querySelector('.bots-status.is-error'), null);
});

test('loads /api/profiles directly and renders user-controlled fields only as text', async t => {
  const ui = setup(t, { bots: [{ id: 'bot/1', name: hostile, description: hostile, persona: hostile, memory: hostile, profileId: 'p1' }] });
  ui.state.profiles[0].name = hostile;
  await ui.open();
  assert.deepEqual([...new Set(ui.state.calls.map(call => call.url))].sort(), ['/api/bot-teams', '/api/bots', '/api/bots/tools', '/api/profiles']);
  assert.equal(ui.d.querySelector('.bots-card h3').textContent, hostile);
  assert.equal(ui.d.querySelector('.bots-description').textContent, hostile);
  assert.deepEqual([...ui.d.querySelectorAll('.bots-details dd')].map(node => node.textContent), [hostile, hostile]);
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
  ui.click('编辑');
  assert.equal(ui.d.querySelector('[name="persona"]').value, hostile);
  assert.ok(ui.d.querySelector('[name="profileId"]').textContent.includes(hostile));
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
});

test('create validates names, preserves failed input and submits exactly the Bot fields', async t => {
  const ui = setup(t, { bots: [] });
  await ui.open();
  assert.ok(ui.d.querySelector('.bots-empty'));
  ui.click('创建 Bot');
  const name = ui.d.querySelector('[name="name"]');
  name.value = '   ';
  ui.submit();
  assert.equal(ui.state.calls.filter(call => call.method === 'POST').length, 0);
  name.value = '  新助手  ';
  ui.d.querySelector('[name="persona"]').value = hostile;
  ui.d.querySelector('[name="memory"]').value = '明确保存的偏好';
  ui.state.saveError = true;
  ui.submit();
  await ui.idle();
  assert.ok(ui.d.querySelector('dialog'));
  assert.equal(name.value, '  新助手  ');
  assert.ok(ui.d.querySelector('.bots-form-error').textContent.includes(hostile));
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
  ui.state.saveError = false;
  ui.submit();
  await ui.idle();
  const body = JSON.parse(ui.state.calls.filter(call => call.method === 'POST').at(-1).body);
  assert.deepEqual(Object.keys(body).sort(), payloadKeys);
  assert.equal(body.name, '新助手');
  assert.equal(body.persona, hostile);
  assert.equal(body.profileId, '');
  assert.deepEqual(body.allowedTools, []);
  assert.equal(ui.d.querySelector('dialog'), null);
  assert.equal(ui.d.querySelectorAll('.bots-card').length, 1);
});

test('editing profile targets only the Bot; existing chat binding is untouched and new chat is opened', async t => {
  const ui = setup(t);
  await ui.open();
  ui.click('编辑');
  const hint = ui.d.getElementById('bots-editor-profileId-hint').textContent;
  assert.match(hint, /仅用于新聊天/);
  assert.match(hint, /已有聊天保持原模型绑定/);
  ui.d.querySelector('[name="profileId"]').value = 'p2';
  ui.submit();
  await ui.idle();
  const update = ui.state.calls.find(call => call.method === 'PUT');
  assert.equal(update.url, '/api/bots/bot%2F1');
  assert.deepEqual(Object.keys(JSON.parse(update.body)).sort(), payloadKeys);
  assert.equal(JSON.parse(update.body).profileId, 'p2');
  assert.equal(ui.state.histories[0].modelBinding.profileId, 'p1');
  assert.equal(ui.state.calls.some(call => call.url.startsWith('/api/sessions')), false);
  ui.click('开始聊天');
  await ui.idle();
  assert.deepEqual(ui.state.switched, ['new-session']);
  assert.deepEqual(ui.state.navigation, ['switch:new-session', 'chat', 'reload']);
  assert.equal(ui.state.histories[1].modelBinding.profileId, 'p2');
});

test('missing profile survives edit when profile list fails, with visible warning', async t => {
  const ui = setup(t);
  ui.state.bots[0].profileId = 'removed-profile';
  ui.state.profileError = true;
  await ui.open();
  assert.match(ui.d.querySelector('.bots-status').textContent, /模型配置读取失败/);
  ui.click('编辑');
  assert.equal(ui.d.querySelector('[name="profileId"]').value, 'removed-profile');
  ui.submit();
  await ui.idle();
  assert.equal(JSON.parse(ui.state.calls.find(call => call.method === 'PUT').body).profileId, 'removed-profile');
  assert.equal(ui.state.calls.some(call => call.url === '/api/config'), false);
});

test('delete confirms retained readable history and HTTP 409, never deletes sessions', async t => {
  const ui = setup(t);
  await ui.open();
  ui.state.confirm = false;
  ui.click('删除');
  await ui.idle();
  assert.equal(ui.state.calls.some(call => call.method === 'DELETE'), false);
  ui.state.confirm = true;
  ui.click('删除');
  await ui.idle();
  assert.match(ui.state.confirmations.at(-1), /聊天历史会保留并可继续阅读/);
  assert.match(ui.state.confirmations.at(-1), /无法继续执行.*HTTP 409/);
  assert.equal(ui.state.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(ui.state.calls.find(call => call.method === 'DELETE').url, '/api/bots/bot%2F1');
  assert.equal(ui.state.histories.length, 1);
  assert.ok(ui.d.querySelector('.bots-empty'));
  assert.match(ui.d.querySelector('.bots-status').textContent, /聊天历史仍可阅读.*HTTP 409/);
});

test('failed session switch retries the existing created chat without duplicate POST', async t => {
  const ui = setup(t);
  await ui.open();
  ui.state.switchError = true;
  ui.click('开始聊天');
  await ui.idle();
  assert.match(ui.d.querySelector('.bots-status').textContent, /打开对话失败/);
  ui.state.switchError = false;
  ui.click('打开已创建对话');
  await ui.idle();
  assert.equal(ui.state.calls.filter(call => call.url.endsWith('/chat')).length, 1);
  assert.deepEqual(ui.state.switched, ['new-session']);
});

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const readBlob = (w, blob) => new Promise((resolve, reject) => {
  const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob);
});

test('tool permissions default to none and explicit selection is persisted safely', async t => {
  const ui = setup(t);
  ui.state.tools[0].description = hostile;
  await ui.open();
  ui.click('创建 Bot');
  assert.equal(ui.d.querySelectorAll('[name="allowedTools"]:checked').length, 0);
  assert.match(ui.d.querySelector('dialog').textContent, /shell.*可执行程序.*不等于沙箱/);
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
  ui.d.querySelector('[name="name"]').value = '工具助手';
  ui.d.querySelector('[name="allowedTools"][value="shell_execute"]').checked = true;
  ui.submit(); await ui.idle();
  assert.deepEqual(JSON.parse(ui.state.calls.find(call => call.url === '/api/bots' && call.method === 'POST').body).allowedTools, ['shell_execute']);
});

test('catalog package preview requires a local profile and explicit import confirmation', async t => {
  const ui = setup(t); await ui.open();
  ui.click('内置模板'); await flush(); ui.click('预览模板');
  assert.ok(ui.d.querySelector('.bots-package-preview').textContent.includes(hostile));
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
  assert.equal(ui.state.imports.length, 0);
  ui.click('确认导入'); await flush(); assert.equal(ui.state.imports.length, 0);
  ui.d.querySelector('[name="importProfileId"]').value = 'p2';
  ui.click('确认导入'); await flush();
  assert.equal(ui.state.imports.length, 1);
  assert.equal(ui.state.imports[0].profileId, 'p2');
  assert.deepEqual(ui.state.imports[0].package.bot.allowedTools, ['file_read']);
  assert.equal(ui.state.imports[0].package.bot.persona, hostile);
});

test('JSON file import previews first, rejects invalid formats and exports omit memory', async t => {
  const ui = setup(t); await ui.open();
  const input = ui.d.querySelector('input[type="file"]');
  const setFile = raw => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new ui.w.File([raw], 'bot.json', { type: 'application/json' })] });
    input.dispatchEvent(new ui.w.Event('change'));
  };
  setFile('{');
  for (let i = 0; i < 30 && !ui.d.querySelector('.bots-status').textContent.includes('导入失败'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(ui.d.querySelector('.bots-status').textContent, /导入失败/);
  const pkg = ui.state.packages[0]; setFile(JSON.stringify(pkg));
  for (let i = 0; i < 30 && !ui.d.querySelector('[name="importProfileId"]'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(ui.d.querySelector('[name="importProfileId"]'));
  assert.equal(ui.state.imports.length, 0);
  ui.click('取消'); ui.click('导出 Bot 包'); await ui.idle();
  const exported = JSON.parse(await readBlob(ui.w, ui.state.downloads[0]));
  assert.equal(exported.format, 'iexa-bot'); assert.equal(exported.version, 1);
  assert.equal(Object.hasOwn(exported.bot, 'memory'), false);
  assert.equal(Object.hasOwn(exported.bot, 'profileId'), false);
  assert.match(ui.state.filename, /\.iexa-bot\.json$/);
});

test('teams validate 2–4 members, display server results, cancel truthfully and poll only active view', async t => {
  const ui = setup(t, { bots: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}` })) });
  await ui.open();
  const form = ui.d.querySelector('.bots-team-form');
  const submit = () => form.dispatchEvent(new ui.w.Event('submit', { cancelable: true }));
  ui.d.querySelector('[name="teamGoal"]').value = hostile;
  submit(); await flush();
  assert.equal(ui.state.calls.some(call => call.url === '/api/bot-teams' && call.method === 'POST'), false);
  const checks = [...ui.d.querySelectorAll('[name="teamBotId"]')];
  checks.forEach(node => { node.checked = true; }); submit(); await flush();
  assert.equal(ui.state.calls.some(call => call.url === '/api/bot-teams' && call.method === 'POST'), false);
  checks.forEach((node, i) => { node.checked = i < 2; }); submit(); await flush();
  const call = ui.state.calls.find(item => item.url === '/api/bot-teams' && item.method === 'POST');
  assert.deepEqual(JSON.parse(call.body), { goal: hostile, botIds: ['b0', 'b1'] });
  assert.equal(ui.d.querySelector('.bots-team-state').textContent, '规划中');
  ui.state.cancelError = true;
  ui.click('取消团队任务'); await flush();
  assert.equal(ui.d.querySelector('.bots-team-state').textContent, '规划中');
  ui.state.cancelError = false;
  ui.click('取消团队任务'); await flush();
  assert.equal(ui.d.querySelector('.bots-team-state').textContent, '取消中');
  assert.doesNotMatch(ui.d.querySelector('.bots-team-state').textContent, /已完成|已取消/);
  ui.state.teams[0] = { id: 'team/1', goal: hostile, status: 'completed', plan: hostile, tasks: [{ botId: 'b0', instruction: hostile, result: hostile, status: 'completed', sessionId: 'step-session' }] };
  const timer = [...ui.state.timers.values()].find(item => item.delay === 2500); assert.ok(timer); timer.callback(); await flush();
  assert.equal(ui.d.querySelector('.bots-team-state').textContent, '已完成');
  assert.ok(ui.d.querySelector('.bots-team-task').textContent.includes(hostile));
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
  ui.click('打开步骤会话'); await flush();
  assert.deepEqual(ui.state.switched, ['step-session']);
  const before = ui.state.calls.filter(item => item.url === '/api/bot-teams' && item.method === 'GET').length;
  timer.callback(); await flush();
  assert.equal(ui.state.calls.filter(item => item.url === '/api/bot-teams' && item.method === 'GET').length, before);
  assert.equal([...ui.state.timers.values()].some(item => item.delay === 2500), false);
});

test('Tobs conversion enforces file limits, previews safely and imports only explicit persona after profile confirmation', async t => {
  const ui = setup(t); await ui.open(); ui.click('导入 Tobs 描述');
  const setFile = (name, raw, filename) => Object.defineProperty(ui.d.querySelector(`[name="${name}"]`), 'files', {
    configurable: true, value: [new ui.w.File([raw], filename)],
  });
  const waitFor = async predicate => {
    for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('Tobs UI did not settle');
  };
  const convertCalls = () => ui.state.calls.filter(call => call.url === '/api/bots/convert-tobs');
  assert.match(ui.d.querySelector('dialog').textContent, /不导入记忆、权限或插件/);
  setFile('tobsDescriptor', 'x'.repeat(16385), 'bot.json'); ui.click('转换并预览'); await flush();
  assert.match(ui.d.querySelector('dialog .bots-form-error').textContent, /16 KB/);
  assert.equal(convertCalls().length, 0);
  setFile('tobsDescriptor', JSON.stringify({ name: hostile }), 'bot.json');
  setFile('tobsPersona', 'x'.repeat(12001), 'SOUL.md'); ui.click('转换并预览');
  await waitFor(() => ui.d.querySelector('dialog .bots-form-error')?.textContent.includes('12000'));
  assert.equal(convertCalls().length, 0);
  setFile('tobsPersona', '明确人格 ' + hostile, 'PERSONA.md'); ui.click('转换并预览');
  await waitFor(() => ui.d.querySelector('[name="importProfileId"]'));
  assert.equal(ui.state.imports.length, 0);
  assert.equal(JSON.parse(convertCalls()[0].body).persona, '明确人格 ' + hostile);
  assert.ok(ui.d.querySelector('dialog .bots-permission-note').textContent.includes(hostile));
  assert.equal(ui.d.querySelectorAll('img,script').length, 0);
  ui.d.querySelector('[name="importProfileId"]').value = 'p1'; ui.click('确认导入'); await flush();
  assert.equal(ui.state.imports[0].profileId, 'p1');
  assert.equal(ui.state.imports[0].package.bot.memory, '');
  assert.deepEqual(ui.state.imports[0].package.bot.allowedTools, []);
  assert.equal(ui.state.imports[0].package.bot.persona, '明确人格 ' + hostile);
  ui.click('导入 Tobs 描述'); setFile('tobsDescriptor', '{"name":"无人格"}', 'bot.json'); ui.click('转换并预览');
  await waitFor(() => ui.d.querySelector('[name="importProfileId"]'));
  assert.equal(JSON.parse(convertCalls()[1].body).persona, '');
  assert.equal(ui.state.imports.length, 1, 'conversion alone never stores a Bot');
});
