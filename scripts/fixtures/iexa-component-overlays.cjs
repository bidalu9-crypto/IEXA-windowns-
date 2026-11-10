'use strict';

// These scenarios control the actual IEXA overlays through DesktopAgent. The
// only direct writes create/change owned fixture input files. CDP reads inspect
// DOM state or make GET requests; no application mutation is evaluated here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deflateSync } = require('node:zlib');

function pngFixture() {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  };
  const width = 64, height = 64, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      pixels[offset] = x < width / 2 ? 109 : 47;
      pixels[offset + 1] = y < height / 2 ? 99 : 170;
      pixels[offset + 2] = 235; pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function runOverlays(h) {
  const q = JSON.stringify, root = fs.realpathSync.native(h.report.fixture.root), project = fs.realpathSync.native(h.report.fixture.project);
  assert.ok(path.resolve(project).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep), 'Overlay inputs belong to this isolated harness fixture');
  const token = h.report.runId.slice(0, 8), imageName = 'component-overlay-' + token + '.png', htmlName = 'component-overlay-' + token + '.html';
  const imageFile = path.join(project, imageName), htmlFile = path.join(project, htmlName);
  const image = pngFixture();
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fs.writeFileSync(imageFile, image, { flag: 'wx' });
  const html = marker => '<!doctype html><html lang="en"><meta charset="utf-8"><title>IEXA overlay fixture</title><style>body{font:22px system-ui;padding:24px;background:#eef3ff;color:#253261}main{border:3px solid #6d63eb;padding:20px}strong{display:block}</style><main><strong>' + marker + '</strong><p>Actual isolated HTML preview input.</p></main></html>';
  fs.writeFileSync(htmlFile, html('COMPONENT_HTML_OVERLAY_INITIAL_' + token), { flag: 'wx' });
  Object.assign(h.report.fixture, { overlayImage: imageFile, overlayHtml: htmlFile }); h.save();

  const read = expression => h.read(expression);
  const click = selector => h.clickSelector(selector);
  const type = (selector, text) => h.typeSelector(selector, text);
  const key = (selector, keys) => h.keySelector(selector, keys);
  const text = selector => read(`document.querySelector(${q(selector)})?.textContent?.trim()||''`);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const shown = selector => h.until(() => visible(selector), 'Overlay control visible: ' + selector);
  const gone = selector => h.until(async () => !await visible(selector), 'Overlay closed: ' + selector);
  async function recover() {
    if (await visible('#imagePreviewClose')) await click('#imagePreviewClose');
    if (await visible('#htmlPreviewClose')) await click('#htmlPreviewClose');
    if (await visible('#commandPaletteInput')) await key('#commandPaletteInput', 'ESC');
    if (await visible('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)')) await click('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)');
  }
  async function conversation() {
    await recover(); await h.nav('chat');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
  }
  const activeFrame = () => read("(()=>{const f=document.querySelector('#htmlPreviewCanvas iframe.is-active');return f?{id:f.id,src:f.getAttribute('src'),loading:!document.querySelector('#htmlPreviewLoading').hidden,sandbox:f.getAttribute('sandbox')}:null})()");
  async function committedFrame(previous) {
    return h.until(async () => {
      const frame = await activeFrame();
      return frame?.src && frame.src !== 'about:blank' && !frame.loading && (!previous || frame.src !== previous.src) && frame;
    }, 'Actual HTML iframe committed' + (previous ? ' a new document' : ''), 12000);
  }
  async function htmlReceipt(frame, receipt) {
    const response = await read(`fetch(${q(frame.src)},{cache:'no-store'}).then(async r=>({status:r.status,text:await r.text()}))`);
    assert.equal(response.status, 200); assert.ok(response.text.includes(receipt), 'Actual active preview resource contains the expected fixture bytes');
    return { status: response.status, receipt };
  }

  let attachmentDraftBefore;
  await h.check('Overlay / native image attachment, gallery zoom and removal', async () => {
    await conversation();
    const originalDraft = await read("document.querySelector('#chatInput').value");
    attachmentDraftBefore = originalDraft;
    assert.equal(await read("document.querySelectorAll('#attachPreview .attach-chip').length"), 0, 'Isolated composer starts with no attachment');
    const draft = 'COMPONENT_ATTACHMENT_DRAFT_' + token;
    await type('#chatInput', draft);
    const nativeReceipt = await h.chooseNativePath(() => h.nativeClickSelector('#attachBtn'), imageFile);
    const chip = '#attachPreview .attach-chip.is-previewable';
    await shown(chip);
    assert.equal(await text(chip + ' .attach-chip-name'), imageName);
    await h.until(() => read(`document.querySelector(${q(chip + ' img')}).complete&&document.querySelector(${q(chip + ' img')}).naturalWidth===64`), 'Selected PNG decoded into actual attachment thumbnail');
    await click(chip); await shown('#imagePreviewOverlay');
    await h.until(() => read("document.querySelector('#imagePreviewImage').complete&&document.querySelector('#imagePreviewImage').naturalWidth===64&&document.querySelector('#imagePreviewImage').naturalHeight===64"), 'Gallery displays actual selected PNG');
    assert.equal(await text('#imagePreviewTitle'), imageName);
    assert.equal(await text('#imagePreviewZoomLabel'), '100%');
    await click('#imagePreviewZoomIn'); assert.equal(await text('#imagePreviewZoomLabel'), '125%');
    await click('#imagePreviewZoomIn'); assert.equal(await text('#imagePreviewZoomLabel'), '156%');
    await click('#imagePreviewZoomOut'); assert.equal(await text('#imagePreviewZoomLabel'), '125%');
    await click('#imagePreviewZoomReset'); assert.equal(await text('#imagePreviewZoomLabel'), '100%');
    assert.equal(await read("document.querySelector('#imagePreviewImage').style.transform"), '');
    await h.screenshot('overlay-image-gallery');
    await click('#imagePreviewClose'); await gone('#imagePreviewOverlay');
    await click(chip + ' .attach-chip-remove');
    await h.until(() => read("document.querySelectorAll('#attachPreview .attach-chip').length===0"), 'Actual attachment removed from composer');
    assert.equal(await read("document.querySelector('#chatInput').value"), draft, 'Removing image preserves draft');
    await type('#chatInput', originalDraft);
    return { nativeReceipt, selectedFile: imageFile, pngBytes: image.length, naturalSize: '64x64', zoomPercentages: [100, 125, 156, 125, 100], removed: true, sentToModel: false, clipboardUsed: false };
  });

  await recover();
  // h.check already captured a failure screenshot. Remove only this scenario's
  // fixture chip afterwards so another overlay check keeps its own baseline.
  const leftoverChip = await read(`(()=>{const e=[...document.querySelectorAll('#attachPreview .attach-chip')].find(e=>e.querySelector('.attach-chip-name')?.textContent===${q(imageName)});return e?.dataset.id||null})()`);
  if (leftoverChip) await click('#attachPreview .attach-chip[data-id=' + q(leftoverChip) + '] .attach-chip-remove');
  if (attachmentDraftBefore !== undefined && await visible('#chatInput')) await type('#chatInput', attachmentDraftBefore);
  await h.check('Overlay / HTML preview viewport, reload and actual live refresh', async () => {
    await conversation();
    await click('[data-workbench-view="files"]'); await shown('#filesList');
    await click('#filesRefreshBtn');
    const file = '#filesList [data-path=' + q(htmlName) + ']';
    await shown(file); await click(file); await shown('#htmlPreviewOverlay');
    const initial = await committedFrame();
    assert.ok(initial.sandbox.includes('allow-scripts') && !initial.sandbox.includes('allow-same-origin'), 'Actual preview keeps an opaque sandbox');
    await htmlReceipt(initial, 'COMPONENT_HTML_OVERLAY_INITIAL_' + token);
    const original = await read("({viewport:document.querySelector('#htmlPreviewStage').dataset.viewport,live:document.querySelector('#htmlPreviewLive').getAttribute('aria-pressed')==='true'})");
    const widths = {};
    for (const viewport of ['desktop', 'tablet', 'mobile']) {
      await click(`[data-preview-viewport="${viewport}"]`);
      await h.until(() => read(`document.querySelector('#htmlPreviewStage').dataset.viewport===${q(viewport)}&&document.querySelector('[data-preview-viewport="${viewport}"]').getAttribute('aria-pressed')==='true'`), 'Actual preview viewport ' + viewport);
      await h.pause(220);
      widths[viewport] = await read("document.querySelector('#htmlPreviewCanvas').getBoundingClientRect().width");
      assert.ok(widths[viewport] > 0, viewport + ' has rendered canvas width');
    }
    assert.ok(widths.mobile <= widths.tablet && widths.mobile <= widths.desktop, 'Mobile preview uses a smaller canvas');
    await h.screenshot('overlay-html-mobile');
    await click('#htmlPreviewReload');
    const reloaded = await committedFrame(initial); await htmlReceipt(reloaded, 'COMPONENT_HTML_OVERLAY_INITIAL_' + token);
    if (await read("document.querySelector('#htmlPreviewLive').getAttribute('aria-pressed')==='true'")) await click('#htmlPreviewLive');
    assert.equal(await read("document.querySelector('#htmlPreviewLive').getAttribute('aria-pressed')"), 'false');
    const paused = await committedFrame();
    // Emulate an external editor changing only this owned input file. Automatic
    // refresh is driven by IEXA's production stat poll, never an evaluated call.
    fs.writeFileSync(htmlFile, html('COMPONENT_HTML_OVERLAY_LIVE_UPDATED_' + token));
    await h.pause(1200);
    assert.equal((await activeFrame()).src, paused.src, 'Paused preview does not reload after the fixture file changes');
    await click('#htmlPreviewLive');
    const updated = await committedFrame(paused);
    await htmlReceipt(updated, 'COMPONENT_HTML_OVERLAY_LIVE_UPDATED_' + token);
    await h.screenshot('overlay-html-live-updated');
    await click(`[data-preview-viewport="${original.viewport}"]`);
    if (!original.live) await click('#htmlPreviewLive');
    await click('#htmlPreviewClose'); await gone('#htmlPreviewOverlay');
    assert.equal(await read("Array.from(document.querySelectorAll('#htmlPreviewCanvas iframe')).every(f=>f.getAttribute('src')==='about:blank')"), true, 'Closing preview clears both frame surfaces');
    return { file: htmlFile, widths, initialFrame: initial.src, manualReloadFrame: reloaded.src, liveUpdatedFrame: updated.src, pauseRespected: true, backingHtmlReceiptVerified: true, renderedScreenshots: ['overlay-html-mobile.png', 'overlay-html-live-updated.png'], oracleBoundary: 'Opaque iframe DOM; active-frame commits, backing HTML GET receipts and actual rendered screenshots', restoredViewportAndLivePreference: true };
  });

  await recover();
  await h.check('Overlay / command palette search, keyboard selection and navigation', async () => {
    await conversation();
    await key('#chatInput', ['CTRL', 'k']); await shown('#commandPaletteInput');
    await type('#commandPaletteInput', 'NO_COMPONENT_COMMAND_' + token);
    await shown('#commandPaletteList .command-palette-empty');
    assert.equal(await read("document.querySelectorAll('#commandPaletteList .command-palette-item').length"), 0);
    await type('#commandPaletteInput', 'settings');
    await shown('#commandPaletteList [data-id="settings"]');
    assert.equal(await read("document.querySelector('#commandPaletteList .command-palette-item.active').dataset.id"), 'settings');
    await key('#commandPaletteInput', 'ENTER'); await gone('#commandPalette');
    await h.until(() => read("document.querySelector('.nav-btn.active')?.dataset.view==='settings'"), 'Palette command opens actual model settings page');
    await key('#localeSelect', ['CTRL', 'k']); await shown('#commandPaletteInput');
    assert.equal(await read("document.querySelector('#commandPaletteList .command-palette-item.active').dataset.id"), 'new-session');
    await key('#commandPaletteInput', 'ARROWDOWN');
    assert.equal(await read("document.querySelector('#commandPaletteList .command-palette-item.active').dataset.id"), 'chat');
    await key('#commandPaletteInput', 'ENTER'); await gone('#commandPalette');
    await h.until(() => read("document.querySelector('.nav-btn.active')?.dataset.view==='chat'"), 'Palette keyboard selection opens actual chat page');
    await key('#chatInput', ['CTRL', 'k']); await shown('#commandPaletteInput');
    await key('#commandPaletteInput', 'ESC'); await gone('#commandPalette');
    return { noMatchSearch: true, searchedCommand: 'settings', settingsNavigation: true, keyboardCommand: 'chat', arrowAndEnterNavigation: true, escapeDismissal: true };
  });
  await recover(); h.save();
}

module.exports = { runOverlays };
