// Pins the dsh-derived surface layer: named radii/durations resolve, the view
// and popover entry animations are attached, card entry uses translate so a
// hover transform still wins, and both reduced-motion paths switch everything
// off. Also captures a frame for the review notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

const now = Date.now();
const seeds = Array.from({ length: 5 }, (_, index) => ({
  id: `motion-${index}`,
  name: `动效夹具 ${index + 1}`,
  description: '用于验证卡片入场、悬停与圆角的占位技能。',
  useCount: index,
  enabled: true,
  systemPrompt: false,
  updatedAt: now - index * 60000,
}));

test('real browser: surface scale and motion behave once, and stop on request', { skip: !browser, timeout: 150000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-motion-'));
  const workspace = path.join(dir, 'workspace');
  process.env.IEXA_WORKSPACE = workspace;
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  for (const seed of seeds) {
    const skillDir = path.join(workspace, 'skills', seed.id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
      `---\nname: ${seed.name}\ndescription: ${seed.description}\nversion: 1.0.0\n---\n\n# ${seed.name}\n`);
  }
  fs.writeFileSync(path.join(workspace, '.iexa-skills.json'), JSON.stringify({
    skills: seeds.map(seed => ({
      id: seed.id, name: seed.name, description: seed.description, version: '1.0.0',
      source: 'session', enabled: seed.enabled, installedAt: now - 86400000,
      updatedAt: seed.updatedAt, useCount: seed.useCount, systemPrompt: seed.systemPrompt,
    })),
  }));

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;


  let socket;
  let page;
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows file lock */ }
  });

  page = await launchPage();
  socket = page.socket;

  let sequence = 0;
  const waiting = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 600));
    return result.result?.result?.value;
  }
  async function wait(expression, message) {
    for (let i = 0; i < 240; i++) {
      try { if (await evaluate(expression)) return; } catch { /* transient */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1512, height: 978, deviceScaleFactor: 1, mobile: false });
  // Headless Chrome inherits the host's animation setting; this machine reports
  // "reduce", which is exactly the case the last assertions cover. Start from
  // no-preference so the entry animations can be observed at all.
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');

  const tokens = await evaluate(`(() => {
    const style = getComputedStyle(document.body);
    return {
      radiusMid: style.getPropertyValue('--ds-r-md').trim(),
      radiusLarge: style.getPropertyValue('--ds-r-lg').trim(),
      duration: style.getPropertyValue('--ds-dur-3').trim(),
      ease: style.getPropertyValue('--ds-ease-out').trim(),
      elevation: style.getPropertyValue('--ds-elev-2').trim(),
    };
  })()`);
  assert.equal(tokens.radiusMid, '10px');
  assert.equal(tokens.radiusLarge, '14px');
  assert.equal(tokens.duration, '220ms');
  assert.match(tokens.ease, /cubic-bezier/);
  assert.match(tokens.elevation, /0 0 0 0?\.5px/);

  // The view that becomes active carries the shared entry animation.
  await evaluate("document.querySelector('.nav-btn[data-view=\"skills\"]').click()");
  await wait("document.getElementById('view-skills')?.classList.contains('active')", 'skills view');
  const view = await evaluate(`(() => {
    const panel = document.getElementById('view-skills');
    const style = getComputedStyle(panel);
    return { name: style.animationName, duration: style.animationDuration, translate: style.translate };
  })()`);
  assert.equal(view.name, 'ds-view-settle');
  assert.equal(view.duration, '0.18s');

  await wait("document.querySelectorAll('#skillList .skill-card').length === 5", 'five cards');
  const cards = await evaluate(`(() => {
    const list = [...document.querySelectorAll('#skillList .skill-card')];
    return list.slice(0, 3).map(card => {
      const style = getComputedStyle(card);
      return { name: style.animationName, delay: style.animationDelay, radius: style.borderRadius, shadow: style.boxShadow };
    });
  })()`);
  assert.deepEqual(cards.map(card => card.name), ['ds-card-in', 'ds-card-in', 'ds-card-in']);
  assert.deepEqual(cards.map(card => card.delay), ['0s', '0.018s', '0.036s']);
  for (const card of cards) assert.equal(card.radius, '10px');
  assert.match(cards[0].shadow, /0\.5px/);

  // Entry uses translate, so a hover transform is free to apply afterwards.
  const hover = await evaluate(`(() => {
    const card = document.querySelector('#skillList .skill-card');
    card.classList.add('is-hover-fixture');
    const probe = document.createElement('style');
    probe.textContent = '.skill-card.is-hover-fixture { transform: translateY(-1px); }';
    document.head.appendChild(probe);
    const value = getComputedStyle(card).transform;
    probe.remove();
    return value;
  })()`);
  assert.match(hover, /matrix|translate/);

  // Popover material and entry. The menu is display:none until opened, which
  // is also when the animation starts.
  await evaluate("document.getElementById('skillAddBtn').click()");
  await wait("getComputedStyle(document.getElementById('skillAddMenu')).display !== 'none'", 'menu open');
  const menu = await evaluate(`(() => {
    const style = getComputedStyle(document.getElementById('skillAddMenu'));
    return { name: style.animationName, radius: style.borderRadius, shadow: style.boxShadow };
  })()`);
  assert.equal(menu.name, 'ds-pop-in');
  assert.equal(menu.radius, '14px');
  assert.match(menu.shadow, /0\.5px/);

  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join('workspace', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join('workspace', 'attachments', 'dsh-motion-skills.png'), Buffer.from(shot.result.data, 'base64'));

  // Explicit "reduced" must win even when the OS keeps motion on.
  await evaluate("document.documentElement.setAttribute('data-motion', 'reduced')");
  const reduced = await evaluate(`(() => {
    const panel = getComputedStyle(document.getElementById('view-skills'));
    const card = getComputedStyle(document.querySelector('#skillList .skill-card'));
    const pop = getComputedStyle(document.getElementById('skillAddMenu'));
    return { view: panel.animationName, card: card.animationName, pop: pop.animationName, hoverTransform: card.transform };
  })()`);
  assert.equal(reduced.view, 'none');
  assert.equal(reduced.card, 'none');
  assert.equal(reduced.pop, 'none');

  // And the system media query does the same while the preference is "system".
  await evaluate("document.documentElement.setAttribute('data-motion', 'system')");
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await wait("getComputedStyle(document.querySelector('#skillList .skill-card')).animationName === 'none'", 'media reduce');
  await wait("document.getElementById('motionHelp').textContent.includes('系统当前要求减少动效')", 'reduced hint');
  // Choosing "full" outranks the OS hint, which is what lets a user on a machine
  // with Windows animations disabled still get the transitions.
  await evaluate("document.documentElement.setAttribute('data-motion', 'full'); syncThemeUI()");
  await wait("getComputedStyle(document.querySelector('#skillList .skill-card')).animationName === 'ds-card-in'", 'full overrides media');
  assert.doesNotMatch(await evaluate("document.getElementById('motionHelp').textContent"), /系统当前要求减少动效/);
  await cdp('Emulation.setEmulatedMedia', { features: [] });

  assert.equal(exceptions.length, 0, JSON.stringify(exceptions[0] || {}));

  // The running label's highlight must come from the shell module and animate
  // transforms only. A text-clipped background-position sweep would repaint every
  // glyph of the label on every frame; this pins the loaded implementation.
  await evaluate("document.documentElement.setAttribute('data-motion', 'full')");
  const glow = await evaluate(`(() => {
    const row = document.createElement('div');
    row.className = 'tool-block activity-row is-active';
    row.innerHTML = '<div class="tool-header"><span class="tool-name">grep</span></div>';
    document.querySelector('.workbench-shell, body').append(row);
    const sync = typeof window.IexaLabelGlow?.syncRow === 'function';
    window.IexaLabelGlow?.syncRow(row);
    const sweep = row.querySelector('.label-glow__sweep');
    const out = {
      sync,
      hasGlow: !!row.querySelector('.label-glow'),
      anim: sweep ? getComputedStyle(sweep).animationName : null,
      mask: sweep ? getComputedStyle(sweep).maskImage.slice(0, 16) : null,
      decorative: row.querySelector('.label-glow')?.getAttribute('aria-hidden'),
    };
    // The band has to lift the glyphs toward the primary label colour. It used
    // to reuse --thinking-sheen, which is black in the dark theme: the band then
    // erased the characters it crossed and the label read as a broken glyph.
    const lum = (css) => {
      const [r, g, b] = css.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const sample = (theme) => {
      document.documentElement.dataset.theme = theme;
      const label = row.querySelector('.tool-name');
      const copy = row.querySelector('.label-glow__copy');
      return { label: lum(getComputedStyle(label).color), copy: lum(getComputedStyle(copy).color) };
    };
    out.originalTheme = document.documentElement.dataset.theme;
    out.dark = sample('dark');
    out.light = sample('light');
    document.documentElement.dataset.theme = out.originalTheme;
    const theme = row.closest('[data-theme]');
    row.classList.remove('is-active');
    window.IexaLabelGlow?.syncRow(row);
    out.removed = !row.querySelector('.label-glow');
    row.remove();
    out.themeRestored = theme === null;
    return out;
  })()`);
  assert.equal(glow.sync, true, 'IexaLabelGlow did not load in the app shell');
  assert.equal(glow.hasGlow, true, 'a running row got no highlight');
  assert.equal(glow.anim, 'iexa-label-glow-sweep');
  assert.match(glow.mask, /linear-gradient/);
  assert.equal(glow.decorative, 'true', 'the decorative copy is not hidden from assistive tech');
  assert.ok(glow.dark.copy > glow.dark.label + 0.02,
    'in the dark theme the band must be brighter than the label: ' + JSON.stringify(glow.dark));
  assert.ok(glow.light.copy < glow.light.label - 0.02,
    'in the light theme the band must be darker than the label: ' + JSON.stringify(glow.light));
  assert.equal(glow.removed, true, 'a finished row kept its highlight');
  await evaluate("document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'dark'");
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions[0] || {}));
});
