// Links and emphasis in the transcript: one sky tone, a globe mark, and a click
// that reaches the system browser instead of dying in the navigation guard.
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

test('real browser: transcript links carry a globe and open outside the app', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-links-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 8000);
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
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof renderMarkdownContent === 'function' && typeof currentSessionId !== 'undefined'");

  // The Electron bridge is absent in a plain browser; stub it to observe calls.
  await evaluate(String.raw`(() => {
    window.__opened = [];
    window.iexaDesktop = { openExternal: (url) => { window.__opened.push(url); return Promise.resolve({ ok: true }); } };
    const markdown = [
      '看这个 [示例站点](https://example.com/a?b=1) 和 **重点内容**。',
      '',
      '也支持 [邮件](mailto:hi@example.com) 与 [页内锚点](#section)。',
    ].join('\n');
    // The transcript is repainted when the session loads, so every probe asks
    // for a live node instead of holding a reference that may be detached.
    window.__linksBody = () => {
      let body = document.querySelector('.message-content.message-answer a[href^="https"]')
        ? document.querySelector('.message-content.message-answer')
        : null;
      if (!body) {
        const message = document.createElement('div');
        message.className = 'message assistant';
        body = document.createElement('div');
        body.className = 'message-content message-answer';
        message.appendChild(body);
        document.querySelector('.welcome')?.remove();
        document.getElementById('chatMessages').appendChild(message);
        renderMarkdownContent(body, markdown, true);
      }
      return body;
    };
    window.__linksBody();
    return true;
  })()`);

  const look = await evaluate(`(() => {
    const body = window.__linksBody();
    const link = body.querySelector('a[href^="https"]');
    const mail = body.querySelector('a[href^="mailto"]');
    const strong = body.querySelector('strong');
    const token = getComputedStyle(document.documentElement).getPropertyValue('--link').trim();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;background:' + token;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const before = getComputedStyle(link, '::before');
    return {
      linkColor: getComputedStyle(link).color,
      mailColor: getComputedStyle(mail).color,
      strongColor: getComputedStyle(strong).color,
      expected,
      token,
      globeMask: before.maskImage || before.webkitMaskImage || '',
      globeWidth: before.width,
      cursor: getComputedStyle(link).cursor,
      underline: getComputedStyle(link).textDecorationLine,
    };
  })()`);

  assert.equal(look.linkColor, look.expected, 'the link uses the --link token');
  assert.equal(look.mailColor, look.expected, 'mailto links share the tone');
  assert.equal(look.strongColor, look.expected, 'emphasis shares the same sky tone');
  assert.match(look.globeMask, /data:image\/svg/, 'the globe is a mask so it inherits the colour');
  assert.notEqual(look.globeWidth, '0px');
  assert.equal(look.cursor, 'pointer');
  assert.equal(look.underline, 'underline');

  // Clicking a web link must reach the bridge, not navigate the window.
  const clicked = await evaluate(`(() => {
    const link = window.__linksBody().querySelector('a[href^="https"]');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    return { prevented: event.defaultPrevented, opened: window.__opened.slice() };
  })()`);
  assert.equal(clicked.prevented, true, 'the default navigation is cancelled');
  assert.deepEqual(clicked.opened, ['https://example.com/a?b=1']);

  const mailClicked = await evaluate(`(() => {
    const link = window.__linksBody().querySelector('a[href^="mailto"]');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return window.__opened.slice();
  })()`);
  assert.deepEqual(mailClicked, ['https://example.com/a?b=1', 'mailto:hi@example.com']);

  // A page anchor is not an external link and must be left alone.
  const anchorClicked = await evaluate(`(() => {
    const link = window.__linksBody().querySelector('a[href^="#"]');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    return { opened: window.__opened.length, prevented: event.defaultPrevented };
  })()`);
  assert.equal(anchorClicked.opened, 2, 'anchors do not open the browser');
  assert.equal(anchorClicked.prevented, false, 'anchors keep their default behaviour');

  // Contrast: the tone has to be readable, not just pretty.
  const contrast = await evaluate(`(() => {
    const parse = (value) => {
      const nums = (value.match(/[\\d.]+/g) || []).map(Number);
      // color-mix() serialises as "color(srgb 0.98 0.98 0.99)": 0-1 floats.
      if (/^\\s*color\\(/i.test(value)) return nums.slice(0, 3).map((v) => v * 255);
      return nums.slice(0, 3);
    };
    const luminance = ([r, g, b]) => {
      const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const link = window.__linksBody().querySelector('a[href^="https"]');
    // Walk up to the first painted surface: the message body itself is often
    // transparent, and measuring against white would overstate contrast.
    const surface = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor;
        const parts = parse(value);
        const alpha = (value.match(/[\\d.]+/g) || [])[3];
        if (parts.length === 3 && alpha === undefined) return parts;
      }
      return [255, 255, 255];
    };
    const linkColor = getComputedStyle(link).color;
    const surfaceValue = surface(link);
    return { ratio: ratio(parse(linkColor), surfaceValue), color: linkColor, surface: surfaceValue, theme: document.documentElement.dataset.theme || 'light' };
  })()`);
  assert.ok(Number.isFinite(contrast.ratio) && contrast.ratio >= 4.5, `link contrast must clear AA (${JSON.stringify(contrast)})`);

  // Dark mode keeps the same contract with its own token.
  await evaluate("document.documentElement.dataset.theme = 'dark'; true");
  await new Promise((r) => setTimeout(r, 250));
  const dark = await evaluate(`(() => {
    const link = window.__linksBody().querySelector('a[href^="https"]');
    const token = getComputedStyle(document.documentElement).getPropertyValue('--link').trim();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;background:' + token;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { color: getComputedStyle(link).color, expected };
  })()`);
  assert.equal(dark.color, dark.expected, 'dark mode uses its own link token');
});
