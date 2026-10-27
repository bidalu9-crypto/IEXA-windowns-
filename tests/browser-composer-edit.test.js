'use strict';
// Two composer features that both touch the transcript:
//   - 重新编辑: send replaces the tail instead of appending.
//   - 预览: an image attachment opens the same overlay as the transcript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const root = path.join(__dirname, '..');

test('source: the edit action and the previewable chip are wired', () => {
  const helpers = fs.readFileSync(path.join(root, 'src/renderer/services/UiHelpers.js'), 'utf8');
  assert.match(helpers, /data-action="edit"[^>]*title="重新编辑"/);
  assert.match(helpers, /window\.startEditingMessage\?\.\(msg\)/);
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.match(app, /window\.startEditingMessage = startEditingMessage;/);
  assert.match(app, /window\.cancelPendingEdit = cancelPendingEdit;/);
  assert.match(app, /\/api\/sessions\/\$\{encodeURIComponent\(edit\.sessionId\)\}\/reset/, 'sending an edit truncates the stored tail');
  assert.match(app, /attach-chip is-previewable/, 'image chips advertise the preview');
});

test('real browser: 重新编辑 replaces the tail and an image chip previews', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-composer-edit-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_edit_ui';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '编辑测试', titleSource: 'message', created: at, updated: at, messageCount: 4, projectRoot: '', projectName: '无项目' }],
  }), 'utf8');
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
    { role: 'user', content: '第一问', timestamp: at },
    { role: 'assistant', content: '第一答', timestamp: at + 1000, status: 'done' },
    { role: 'user', content: '第二问有错字', timestamp: at + 2000, attachments: [
      { name: 'shot.png', mime: 'image/png', kind: 'image', size: 100,
        savedPath: 'uploads/sess_edit_ui/abc.png', previewUrl: '/api/attachments/sess_edit_ui/abc.png' },
    ] },
    { role: 'assistant', content: '第二答', timestamp: at + 3000, status: 'done' },
  ]), 'utf8');
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;


  let socket;
  let page;
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  page = await launchPage();
  socket = page.socket;

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
  async function wait(expression) {
    for (let index = 0; index < 150; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait(`typeof currentSessionId !== 'undefined' && currentSessionId === '${sessionId}'`);
  await wait("document.querySelectorAll('#chatMessages .message.user').length === 2");

  // Record the reset call while still letting it reach the real server.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__resets = [];
    window.__chatBody = null;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (/\/api\/sessions\/[^/]+\/reset$/.test(url)) {
        window.__resets.push(JSON.parse((init && init.body) || '{}'));
        return window.__realFetch(input, init);
      }
      if (url === '/api/chat') {
        window.__chatBody = JSON.parse((init && init.body) || '{}');
        return new Response('event: text\ndata: {"content":"已修正"}\n\nevent: done\ndata: {}\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  // 1. The edit button restores the prompt into the composer and warns.
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#chatMessages .message.user')];
    const target = rows.find((row) => row.textContent.includes('第二问'));
    target.querySelector('[data-action="edit"]').click();
    return true;
  })()`);
  await wait("document.getElementById('composerEditStrip').hidden === false");
  assert.equal(await evaluate("chatInput.value"), '第二问有错字');
  assert.match(await evaluate("document.getElementById('composerEditStrip').textContent"), /替换它之后的内容/);
  // The attachment is restored by reference: the original saved copy is reused
  // instead of re-reading or re-uploading the bytes.
  assert.deepEqual(await evaluate("pendingAttachments.map((a) => ({ name: a.name, savedPath: a.savedPath, kind: a.kind }))"),
    [{ name: 'shot.png', savedPath: 'uploads/sess_edit_ui/abc.png', kind: 'image' }]);
  assert.equal(await evaluate("document.querySelectorAll('#chatMessages .message.user').length"), 2,
    'opening the editor does not touch the transcript yet');

  // 2. Sending replaces: one reset at the edited index, then the new text.
  await evaluate("chatInput.value = '第二问已修正'; chatInput.dispatchEvent(new Event('input', { bubbles: true })); true");
  await evaluate("void sendMessage(); true");
  await wait("Array.isArray(window.__resets) && window.__resets.length === 1");
  await wait("!!window.__chatBody");
  assert.deepEqual(await evaluate('window.__resets[0]'), { messageIndex: 2, retainSelected: false });
  assert.equal(await evaluate('window.__chatBody.message'), '第二问已修正');

  await wait("document.getElementById('composerEditStrip').hidden === true");
  await wait("!isProcessing");
  const afterSend = await evaluate(`({
    users: [...document.querySelectorAll('#chatMessages .message.user')].map((row) => row.querySelector('.message-content').innerText.trim()),
    editHidden: document.getElementById('composerEditStrip').hidden,
    input: chatInput.value,
  })`);
  assert.deepEqual(afterSend.users, ['第一问', '第二问已修正'], 'the old tail is replaced, not duplicated');
  assert.equal(afterSend.editHidden, true);
  assert.equal(afterSend.input, '', 'the composer clears after sending');

  // 3. Cancelling an edit clears both the strip and the draft.
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#chatMessages .message.user')].find((el) => el.textContent.includes('第一问'));
    row.querySelector('[data-action="edit"]').click();
    return true;
  })()`);
  await wait("document.getElementById('composerEditStrip').hidden === false");
  await evaluate("document.querySelector('.composer-edit-cancel').click(); true");
  assert.equal(await evaluate("document.getElementById('composerEditStrip').hidden"), true);
  assert.equal(await evaluate("chatInput.value"), '');

  // 4. An image attachment previews, and its remove button does not.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVQIW2P8z8Dwn4GBgYERxAAAAP//AwB1WwYF8m0mQAAAAABJRU5ErkJggg==';
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('attachInput');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await wait("!!document.querySelector('.attach-chip.is-previewable')");
  const chip = await evaluate(`(() => {
    const el = document.querySelector('.attach-chip.is-previewable');
    return { role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), label: el.getAttribute('aria-label'), img: !!el.querySelector('img') };
  })()`);
  assert.equal(chip.role, 'button');
  assert.equal(chip.tabindex, '0');
  assert.match(chip.label, /预览图片 shot\.png/);
  assert.equal(chip.img, true);

  await evaluate("document.querySelector('.attach-chip.is-previewable').click(); true");
  await wait("document.getElementById('imagePreviewOverlay').style.display === 'flex'");
  assert.match(await evaluate("document.getElementById('imagePreviewImage').src"), /^data:image\/png/);
  await evaluate("closeImagePreview(); true");
  await wait("document.getElementById('imagePreviewOverlay').style.display !== 'flex'");

  // The remove button sits inside the chip: it must not open the preview.
  await evaluate("document.querySelector('.attach-chip-remove').click(); true");
  await wait("!document.querySelector('.attach-chip')");
  assert.equal(await evaluate("document.getElementById('imagePreviewOverlay').style.display !== 'flex'"), true,
    'removing an attachment does not open the preview');
});
