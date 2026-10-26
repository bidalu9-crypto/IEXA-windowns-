// The document workspace: editing, history, search, preview, and saving to the
// project. The transcript must never be mutated by "open as document".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the document editor edits, previews and saves', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-doc-ui-'));
  const workspace = path.join(dir, 'workspace');
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'existing.md'), '# 已有文档\n\n第一行。\n', 'utf8');

  const sessionId = 'sess_doc_ui';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '文档来源', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: project, projectName: 'project' }],
  }));
  const original = '## 结论\n\n这段文字来自回复，编辑它不应该改动原消息。\n\n- 条目一\n- 条目二\n';
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '写个结论', timestamp: at },
    { role: 'assistant', content: original, status: 'done', timestamp: at + 2000 },
  ]));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const token = backend.getServerCredentials(server).token;
  const code = backend.getServerCredentials(server).loginCode;
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const setProject = await fetch(`http://127.0.0.1:${port}/api/project`, { method: 'POST', headers: auth, body: JSON.stringify({ root: project }) });
  assert.equal(setProject.status, 200, await setProject.text());

  const proc = spawn(browser, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', (data) => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let sequence = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression, timeoutMs = 14000) {
    const deadline = Date.now() + timeoutMs;
    for (let index = 0; index < 2000; index++) {
      if (await evaluate(expression)) return;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  // Typing through the real event path keeps the input handlers honest.
  const type = (text) => evaluate(`(() => {
    const editor = document.getElementById('docEditor');
    editor.focus();
    editor.value = ${JSON.stringify(text)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return editor.value.length;
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId === '" + sessionId + "'");
  await wait("!!document.querySelector('.assistant-message-action[data-action=\"doc\"]')");

  // ---- open a reply as a document ----
  await evaluate("document.querySelector('.assistant-message-action[data-action=\"doc\"]').click(); true");
  await wait("document.getElementById('view-doc').classList.contains('active') && !!document.getElementById('docEditor')");
  await wait("document.getElementById('docEditor').value.length > 0");

  const opened = await evaluate(`(() => ({
    value: document.getElementById('docEditor').value,
    title: document.getElementById('docTitle').textContent,
    path: document.getElementById('docPath').textContent,
    dirty: document.getElementById('view-doc').dataset.dirty,
    status: document.getElementById('docStatus').textContent,
  }))()`);
  assert.equal(opened.value, original, 'the editor receives the exact source');
  assert.match(opened.title, /文档来源/, 'the title comes from the session');
  assert.match(opened.path, /尚未保存/, 'a copy starts unsaved');
  assert.equal(opened.dirty, 'false', 'an untouched copy is not dirty');
  assert.match(opened.status, /副本/);

  // The transcript itself is untouched. textContent, not innerText: the chat view
  // is not active any more, and innerText of a hidden element is empty by spec.
  const transcript = await evaluate(`(() => {
    const body = document.querySelectorAll('.message.assistant .message-content')[0];
    return body.textContent;
  })()`);
  assert.match(transcript, /编辑它不应该改动原消息/, 'the original message is unchanged');

  // ---- edit, dirty marker, counts ----
  await type('# 标题\n\n改过的内容。\n');
  await wait("document.getElementById('view-doc').dataset.dirty === 'true'");
  const edited = await evaluate(`(() => ({
    title: document.getElementById('docTitle').textContent,
    counts: document.querySelector('.doc-counts').textContent,
    saveDisabled: document.getElementById('docSaveBtn').disabled,
  }))()`);
  assert.match(edited.title, /^• /, 'the dirty marker is visible in the title');
  assert.match(edited.counts, /字 · /);
  assert.equal(edited.saveDisabled, false, 'save becomes available');

  // ---- undo / redo ----
  await wait("document.getElementById('docUndoBtn').disabled === false");
  await evaluate("document.getElementById('docUndoBtn').click(); true");
  await wait("document.getElementById('docEditor').value.includes('这段文字来自回复')");
  assert.equal(await evaluate("document.getElementById('docRedoBtn').disabled"), false);
  await evaluate("document.getElementById('docRedoBtn').click(); true");
  await wait("document.getElementById('docEditor').value.includes('改过的内容')");

  // ---- preview ----
  await wait("document.querySelectorAll('#docPreview h1').length === 1");
  const preview = await evaluate(`(() => {
    const root = document.getElementById('docPreview');
    return { h1: root.querySelector('h1')?.textContent, text: root.textContent.includes('改过的内容') };
  })()`);
  assert.equal(preview.h1, '标题');
  assert.equal(preview.text, true);

  // ---- search ----
  await evaluate(`(() => {
    const input = document.getElementById('docSearchInput');
    input.value = '内容';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait("document.getElementById('docSearchCount').textContent.includes('/')");
  const searched = await evaluate(`(() => {
    const editor = document.getElementById('docEditor');
    return { count: document.getElementById('docSearchCount').textContent, selection: editor.value.slice(editor.selectionStart, editor.selectionEnd) };
  })()`);
  assert.match(searched.count, /^1\//);
  assert.equal(searched.selection, '内容', 'the match is selected in the editor');

  // ---- save to the project ----
  // IexaDialogs is frozen, so the real prompt has to be driven, not stubbed.
  async function saveViaDialog(target, buttonId = 'docSaveBtn') {
    await evaluate(`document.getElementById('${buttonId}').click(); true`);
    await wait("!!document.querySelector('dialog.iexa-app-dialog input')");
    await evaluate(`(() => {
      const dialog = document.querySelector('dialog.iexa-app-dialog');
      dialog.querySelector('input').value = ${JSON.stringify(target)};
      dialog.querySelector('.btn-primary').click();
      return true;
    })()`);
  }
  await saveViaDialog('docs/saved.md');
  await wait("document.getElementById('docStatus').dataset.tone === 'ok'");
  const saved = await evaluate(`(() => ({
    status: document.getElementById('docStatus').textContent,
    path: document.getElementById('docPath').textContent,
    dirty: document.getElementById('view-doc').dataset.dirty,
  }))()`);
  assert.match(saved.status, /已保存/);
  assert.equal(saved.path, 'docs/saved.md');
  assert.equal(saved.dirty, 'false');
  assert.equal(fs.readFileSync(path.join(project, 'docs/saved.md'), 'utf8'), '# 标题\n\n改过的内容。\n');

  // ---- autosave: a debounced write with no button press ----
  await type('# 标题\n\n自动保存写入的内容。\n');
  await wait("document.getElementById('view-doc').dataset.dirty === 'true'");
  await wait("document.getElementById('docStatus').dataset.tone === 'ok' && document.getElementById('view-doc').dataset.dirty === 'false'", 4000);
  assert.equal(fs.readFileSync(path.join(project, 'docs/saved.md'), 'utf8'), '# 标题\n\n自动保存写入的内容。\n',
    'the file is written by the debounce, not by a click');
  assert.match(await evaluate("document.getElementById('docStatus').textContent"), /已保存/);

  // ---- open an existing file through the picker ----
  await evaluate("document.getElementById('docOpenBtn').click(); true");
  await wait("!!document.querySelector('#docPicker .doc-picker-row')");
  const listed = await evaluate(`(() => [...document.querySelectorAll('#docPicker .doc-picker-name')].map((n) => n.textContent))()`);
  assert.ok(listed.includes('docs'), 'directories are listed: ' + listed.join(','));
  await evaluate(`(() => {
    [...document.querySelectorAll('#docPicker .doc-picker-row')].find((row) => row.textContent.includes('docs')).click();
    return true;
  })()`);
  await wait("[...document.querySelectorAll('#docPicker .doc-picker-name')].some((n) => n.textContent === 'existing.md')");
  await evaluate(`(() => {
    [...document.querySelectorAll('#docPicker .doc-picker-row')].find((row) => row.textContent.includes('existing.md')).click();
    return true;
  })()`);
  await wait("document.getElementById('docPath').textContent === 'docs/existing.md'");
  assert.equal(await evaluate("document.getElementById('docEditor').value"), '# 已有文档\n\n第一行。\n');
  assert.equal(await evaluate("document.getElementById('docPicker')"), null, 'the picker closes after choosing');

  // ---- a failed save keeps the buffer ----
  // The document now has a path, so plain Save would write straight through;
  // 另存为 is the path that asks for a target.
  await type('这段内容必须留在编辑器里');
  await saveViaDialog('../outside.md', 'docSaveAsBtn');
  await wait("document.getElementById('docStatus').dataset.tone === 'error'");
  const failed = await evaluate(`(() => ({
    status: document.getElementById('docStatus').textContent,
    value: document.getElementById('docEditor').value,
    dirty: document.getElementById('view-doc').dataset.dirty,
  }))()`);
  assert.match(failed.status, /内容仍保留/);
  assert.equal(failed.value, '这段内容必须留在编辑器里', 'the text survives a failed save');
  assert.equal(failed.dirty, 'true');
  assert.equal(fs.existsSync(path.join(dir, 'outside.md')), false);

  // ---- narrow window stacks instead of clipping ----
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true,
    'the editor does not overflow horizontally on a phone');
});
