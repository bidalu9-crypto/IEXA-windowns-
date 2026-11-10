'use strict';

// Real IEXA live-preview surfaces. Every mutation is a production DesktopAgent
// control action; expressions below only read DOM or issue GET requests.
const assert = require('node:assert/strict');

async function runDesktopLive(h) {
  const q = JSON.stringify;
  const panel = '.desktop-live-panel';
  const embedded = name => panel + ' [data-live-' + name + ']';
  const read = expression => h.read(expression);
  const text = selector => read(`document.querySelector(${q(selector)})?.textContent || ''`);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return !e.hidden&&r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const shown = selector => h.until(() => visible(selector), 'Actual live control visible: ' + selector, 12000);
  const click = selector => h.clickSelector(selector);
  const get = route => read(`fetch(${q(route)},{method:'GET',cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('GET '+r.status);return r.json()})`);
  const status = () => get('/api/desktop-live/status');
  const waitText = (selector, expected) => h.until(async () => (await text(selector)).includes(expected), 'Live UI text: ' + expected, 18000);
  const loadedImage = selector => h.until(() => read(`(()=>{const e=document.querySelector(${q(selector)});return e&&!e.hidden&&e.complete&&e.naturalWidth>0&&e.naturalHeight>0?{width:e.naturalWidth,height:e.naturalHeight}:false})()`), 'Decoded real observation image: ' + selector, 18000);
  const frame = () => read("fetch('/api/desktop-live/frame',{method:'GET',cache:'no-store'}).then(async r=>{const b=new Uint8Array(await r.arrayBuffer());return {status:r.status,type:r.headers.get('content-type'),capturedAt:Number(r.headers.get('x-captured-at')),mode:r.headers.get('x-iexa-frame-mode'),bytes:b.length,signature:Array.from(b.slice(0,8)).map(x=>x.toString(16).padStart(2,'0')).join('')}})");
  const assertPng = value => {
    assert.equal(value.status, 200); assert.match(value.type || '', /^image\/png/);
    assert.equal(value.signature, '89504e470d0a1a0a'); assert.ok(value.bytes > 24); assert.ok(value.capturedAt > 0);
  };
  const waitPaused = paused => h.until(async () => { const s = await status(); return s.paused === paused && (!paused || !s.active) && s; }, 'App desktop scheduler paused=' + paused, 12000);
  const check = (name, fn) => h.check('Desktop live / ' + name, fn);
  let sessionId = '', endpoint = h.report.cdpEndpoint || '', standaloneId = '';
  async function targets() {
    const url = new URL(endpoint);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/'); assert.ok(!url.username && !url.password && !url.search && !url.hash);
    const response = await fetch(new URL('/json/list', url), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200); const rows = await response.json(); assert.ok(Array.isArray(rows)); return rows;
  }

  await check('chat invokes app-owned desktop_control observe and records a real cached frame', async () => {
    await h.nav('chat');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
    await h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'Previous chat turn settled', 20000);
    await h.click('newSessionBtn');
    sessionId = await read("document.querySelector('.session-item.active')?.dataset.id || ''"); assert.ok(sessionId);
    const before = await status();
    await h.type('chatInput', 'COMPONENT_DESKTOP_SELF 观察真实 IEXA 窗口，用于实况桌面组件验收。');
    await h.click('sendBtn');
    await waitText('#chatMessages', 'COMPONENT_DESKTOP_SELF_OK');
    await h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'Desktop self-observation chat settled', 22000);
    const actual = await h.until(async () => {
      const s = await status();
      return s.observed === true && s.success === true && s.hasFrame === true && s.control?.backend === 'chromium-cdp' && s.updatedAt > (before.updatedAt || 0) && s;
    }, 'Production app-owned DesktopLiveState updated by successful observe', 18000);
    assert.equal(actual.control.mode, 'background'); assert.equal(actual.control.physicalInput, false);
    const history = await get('/api/sessions/' + encodeURIComponent(sessionId));
    const calls = (history.messages || []).flatMap(message => message.toolCalls || []);
    const observe = calls.find(call => call.name === 'desktop_control' && call.args?.action === 'observe');
    assert.ok(observe, 'Persisted real desktop_control tool invocation'); assert.equal(observe.result?.success, true);
    endpoint ||= observe.args.cdpEndpoint;
    assert.ok(h.report.providerRequests.some(request => request.prompt.includes('COMPONENT_DESKTOP_SELF')));
    const image = await frame(); assertPng(image); assert.equal(image.mode, 'cached-observation');
    await shown(panel); await h.screenshot('desktop-live-embedded-created');
    return { sessionId, control: actual.control, updatedAt: actual.updatedAt, capturedFrame: image, persistedTool: observe.name };
  });

  await check('embedded preview toggle displays and pauses the cached observation', async () => {
    await shown(panel);
    if ((await text(embedded('toggle'))).includes('暂停')) await click(embedded('toggle'));
    assert.equal(await text(embedded('toggle')), '开启预览');
    await click(embedded('toggle')); await waitText(embedded('toggle'), '暂停预览');
    const image = await loadedImage(panel + ' img'); await waitText(embedded('status'), '最近观察快照');
    await h.screenshot('desktop-live-embedded-frame');
    await click(embedded('toggle')); await waitText(embedded('toggle'), '开启预览');
    return { decodedImage: image, enabledThenPaused: true, status: await text(embedded('status')) };
  });

  await check('embedded Stop pauses app scheduler and blocks frame transport', async () => {
    await shown(embedded('stop')); await click(embedded('stop'));
    const actual = await waitPaused(true); const blocked = await frame(); assert.equal(blocked.status, 423);
    await waitText(embedded('status'), '已停止操控');
    return { paused: actual.paused, active: actual.active, frameStatus: blocked.status, status: await text(embedded('status')) };
  });

  await check('embedded Resume restores app permission without replaying a task', async () => {
    await click(embedded('resume')); const actual = await waitPaused(false);
    await waitText(embedded('status'), '已恢复操作权限');
    const image = await frame(); assertPng(image);
    return { paused: actual.paused, frame: image, status: await text(embedded('status')) };
  });

  await check('Detach opens the real desktop-live page and hides embedded panel', async () => {
    await shown(embedded('detach')); await click(embedded('detach'));
    const page = await h.until(async () => (await targets()).find(row => row.type === 'page' && new URL(row.url).pathname === '/desktop-live.html'), 'Actual detached desktop-live CDP target', 12000);
    standaloneId = page.id;
    await h.until(async () => !(await visible(panel)), 'Embedded live panel hidden after detach', 10000);
    return { targetId: standaloneId, url: page.url, embeddedHidden: true };
  });

  if (standaloneId) {
    await h.withTarget('desktop-live.html', async () => {
      await check('standalone preview renders the observation and toggles pause/resume', async () => {
        await shown('[data-live-toggle]'); const actual = await status();
        assert.equal(actual.observed, true); assert.equal(actual.control?.backend, 'chromium-cdp');
        await loadedImage('[data-live-frame]'); await waitText('[data-live-control-mode]', '后台'); await waitText('[data-live-control-route]', 'chromium-cdp');
        await click('[data-live-toggle]'); await waitText('[data-live-toggle]', '继续预览'); await waitText('[data-live-status]', '预览已暂停');
        await click('[data-live-toggle]'); await waitText('[data-live-toggle]', '暂停预览'); const image = await loadedImage('[data-live-frame]');
        await h.screenshot('desktop-live-standalone-frame');
        return { image, mode: await text('[data-live-control-mode]'), route: await text('[data-live-control-route]') };
      });

      await check('standalone pin control changes and restores its displayed state', async () => {
        const pinned = () => read("document.querySelector('[data-live-pin]')?.getAttribute('aria-pressed')");
        const before = await pinned(); assert.ok(['true', 'false'].includes(before));
        await click('[data-live-pin]'); await h.until(async () => (await pinned()) !== before, 'Pin aria state changed');
        const toggled = await pinned(); assert.equal(await text('[data-pin-label]'), toggled === 'true' ? '置顶' : '普通');
        await click('[data-live-pin]'); await h.until(async () => (await pinned()) === before, 'Original pin state restored');
        return { before, toggled, restored: await pinned(), scope: 'Actual UI event, aria state and label; OS always-on-top state is not independently read.' };
      });

      await check('standalone Stop pauses app operations and frame collection', async () => {
        await click('[data-live-stop]'); const actual = await waitPaused(true);
        await waitText('[data-live-toggle]', '继续预览'); await waitText('[data-live-status]', '操作已暂停');
        const blocked = await frame(); assert.equal(blocked.status, 423);
        return { paused: actual.paused, active: actual.active, frameStatus: blocked.status, status: await text('[data-live-status]') };
      });

      await check('standalone Resume restores permission and preview through its controls', async () => {
        await click('[data-live-resume]'); const actual = await waitPaused(false); await waitText('[data-live-status]', '操作权限已恢复');
        if ((await text('[data-live-toggle]')).includes('继续')) await click('[data-live-toggle]');
        await waitText('[data-live-toggle]', '暂停预览'); const image = await loadedImage('[data-live-frame]');
        const cached = await frame(); assertPng(cached);
        return { paused: actual.paused, image, cachedFrame: cached };
      });

      // Preserve a production action failure if closing this target interrupts
      // its required post-observation. A separate GET below proves disappearance;
      // an independently closed window never rewrites a failed tool result.
      await check('standalone Close production action returns its actual control result', async () => {
        await h.screenshot('desktop-live-before-close');
        const result = await h.selectorAction('click', '[data-window-close]', { expectWindowClosed: true });
        return { result };
      });
    });

    await check('closed standalone target disappears and control returns to main IEXA', async () => {
      await h.until(async () => !(await targets()).some(row => row.id === standaloneId), 'Closed desktop-live target absent from GET list', 12000);
      assert.ok(['/', '/index.html'].includes(await read('location.pathname')), 'Returned to actual main IEXA page');
      await shown('#chatInput'); assert.equal(await visible(panel), false);
      assert.equal((await status()).paused, false);
      await h.screenshot('desktop-live-returned-main');
      return { targetId: standaloneId, targetAbsent: true, mainPath: await read('location.pathname'), appSchedulerPaused: false };
    });
  }

  h.report.desktopLiveCoverage = {
    sessionId, targetId: standaloneId || null,
    scope: 'App-owned observe, real cached PNG, embedded toggle/stop/resume/detach, standalone toggle/pin UI/stop/resume/close and return to main.',
    boundaries: [
      'Pin assertion covers actual control handler and displayed state, not an independent OS always-on-top read.',
      'Stop/resume verifies idle scheduler pause and frame 423/200; it does not claim interruption of a long running physical input.',
      'Close tool outcome and independent target disappearance remain separate checks.',
      'No fixture invokes internal product functions, mutates DOM or sends background API POST requests.',
    ],
  };
  h.save();
}

module.exports = { runDesktopLive };
