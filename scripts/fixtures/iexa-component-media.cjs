'use strict';

// Exercise the shipped screen picker, desktop capture and annotation controls.
// No synthetic screen/audio source is installed. CDP evaluates only observations;
// all application input goes through the production DesktopAgent harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function runMedia(h) {
  const q = JSON.stringify;
  const read = expression => h.read(expression);
  const click = selector => h.clickSelector(selector);
  const type = (selector, value) => h.typeSelector(selector, value);
  const targets = async () => {
    const response = await fetch(h.report.cdpEndpoint + '/json/list', { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200, 'Owned Electron debugger target list');
    return response.json();
  };
  const pickerPages = async () => (await targets()).filter(row => row.type === 'page' && row.url.includes('/capture-picker.html'));
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const shown = selector => h.until(() => visible(selector), 'Actual media control visible: ' + selector, 12000);
  const gone = selector => h.until(async () => !await visible(selector), 'Actual media control closed: ' + selector, 8000);
  const attachments = () => read("Array.from(document.querySelectorAll('#attachPreview .attach-chip')).map(e=>({id:e.dataset.id,name:e.querySelector('.attach-chip-name')?.textContent}))");

  async function closePickerControl(selector) {
    // A picker choice synchronously destroys this secondary page. The production
    // controller verifies disappearance instead of observing a destroyed page.
    return h.selectorAction('click', selector, { expectWindowClosed: true });
  }

  async function recover() {
    if ((await pickerPages()).length) {
      await h.withTarget('capture-picker.html', async () => {
        await shown('#cancel'); await closePickerControl('#cancel');
      });
      await h.until(async () => !(await pickerPages()).length, 'Capture picker dismissed during cleanup');
    }
    if (await visible('.shot-overlay .shot-actions button:nth-child(3)')) {
      await click('.shot-overlay .shot-actions button:nth-child(3)'); await gone('.shot-overlay');
    }
    if (await visible('#imagePreviewClose')) await click('#imagePreviewClose');
  }

  async function conversation() {
    await recover(); await h.nav('chat');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
    assert.equal(await read('isProcessing'), false, 'Media scenario uses an idle actual composer');
  }

  async function openPicker() {
    assert.equal((await pickerPages()).length, 0, 'No previous capture picker');
    let dispatchError;
    try { await h.nativeClickSelector('#screenshotBtn'); }
    catch (error) {
      if (!error.desktopResult?.metadata?.desktop?.dispatchedActions) throw error;
      dispatchError = error;
    }
    const page = await h.until(async () => {
      const pages = await pickerPages(); return pages.length === 1 && pages[0];
    }, 'Real capture picker opened by actual screenshot button', 12000);
    if (dispatchError) {
      h.report.knownToolIssues ||= [];
      h.report.knownToolIssues.push({ action: 'screen-picker-open', issue: dispatchError.message, independentlyVerified: 'Owned capture-picker.html appeared; input was not replayed' }); h.save();
    }
    return { targetId: page.id, url: page.url };
  }

  async function pickOwnWindow() {
    const mainTitle = await read('document.title');
    const picker = await openPicker();
    let selected;
    await h.withTarget('capture-picker.html', async () => {
      await shown('#grid .card');
      const sources = await read("Array.from(document.querySelectorAll('#grid .card')).map((e,index)=>({index,name:e.querySelector('.name')?.textContent,kind:e.querySelector('.kind')?.textContent,thumbnail:!!e.querySelector('.thumb')?.style.backgroundImage}))");
      const own = sources.filter(source => source.kind === '窗口' && source.name === mainTitle);
      assert.equal(own.length, 1, 'Choose the actual IEXA main window by its exact observed title; no screen or other application fallback');
      selected = own[0]; assert.equal(selected.thumbnail, true, 'Real desktopCapturer source has a thumbnail');
      await h.screenshot('media-capture-picker-own-window');
      await closePickerControl('#grid .card:nth-child(' + (selected.index + 1) + ')');
    });
    await h.until(async () => !(await pickerPages()).some(row => row.id === picker.targetId), 'Selected capture picker target disappeared');
    await shown('.shot-overlay.is-ready .shot-canvas');
    return { ...picker, source: selected, scope: 'Actual IEXA application window; audio:false; no synthetic source' };
  }

  async function canvasReceipt(artifact) {
    const image = await read("(()=>{const c=document.querySelector('.shot-canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data,colors=new Set(),step=Math.max(4,Math.floor(p.length/4096/4)*4);for(let i=0;i<p.length;i+=step)colors.add(p[i]+','+p[i+1]+','+p[i+2]+','+p[i+3]);return {width:c.width,height:c.height,colors:colors.size,dataUrl:c.toDataURL('image/png')};})()");
    const png = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Actual frozen canvas exports valid PNG');
    const receipt = { width: image.width, height: image.height, sampledColors: image.colors, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
    if (artifact) { receipt.file = path.join(h.out, artifact + '.png'); fs.writeFileSync(receipt.file, png, { flag: 'wx' }); }
    return receipt;
  }

  async function dragCanvas(from, to) {
    const bounds = await read("(()=>{const r=document.querySelector('.shot-canvas').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()");
    return h.selectorAction('drag', '.shot-canvas', {
      relativeX: bounds.left + bounds.width * from[0], relativeY: bounds.top + bounds.height * from[1],
      toRelativeX: bounds.left + bounds.width * to[0], toRelativeY: bounds.top + bounds.height * to[1],
    });
  }

  async function selectRegion() {
    await dragCanvas([0.24, 0.28], [0.76, 0.68]);
    await shown('.shot-overlay.has-selection');
    return canvasReceipt();
  }

  async function annotate(tool, color, from, to) {
    await click('.shot-tool[data-tool=' + q(tool) + ']');
    assert.equal(await read(`document.querySelector('.shot-tool[data-tool=${q(tool)}]').getAttribute('aria-pressed')`), 'true');
    await click('.shot-color[data-color=' + q(color) + ']');
    assert.equal(await read(`document.querySelector('.shot-color[data-color=${q(color)}]').getAttribute('aria-pressed')`), 'true');
    const before = await canvasReceipt(); await dragCanvas(from, to);
    await h.until(() => read("!document.querySelector('.shot-actions button:nth-child(1)').disabled"), 'Actual annotation enables Undo');
    const after = await canvasReceipt(); assert.notEqual(after.sha256, before.sha256, tool + ' changes actual rendered canvas pixels');
    return { tool, color, before: before.sha256, after: after.sha256 };
  }

  await h.check('Media / actual screen picker cancellation preserves composer and attachments', async () => {
    await conversation(); const draft = await read("document.querySelector('#chatInput').value"), before = await attachments();
    const requests = h.report.providerRequests.length, picker = await openPicker();
    try {
      await h.withTarget('capture-picker.html', async () => {
        await shown('#cancel'); await h.screenshot('media-capture-picker-cancel'); await closePickerControl('#cancel');
      });
      await h.until(async () => !(await pickerPages()).some(row => row.id === picker.targetId), 'Cancelled actual capture picker disappeared');
      assert.equal(await visible('.shot-overlay'), false);
      assert.equal(await read("document.querySelector('#chatInput').value"), draft);
      assert.deepEqual(await attachments(), before);
      assert.equal(h.report.providerRequests.length, requests);
      return { picker, cancelled: true, draftPreserved: true, attachmentsPreserved: true, sentToModel: false };
    } finally { await recover(); }
  });

  await h.check('Media / real window capture selects, annotates, undoes, resets and cancels', async () => {
    await conversation(); const draft = await read("document.querySelector('#chatInput').value"), before = await attachments();
    const requests = h.report.providerRequests.length;
    try {
      const source = await pickOwnWindow(), frame = await canvasReceipt('media-captured-window');
      assert.ok(frame.width > 100 && frame.height > 100 && frame.sampledColors > 8, 'Real captured application frame has dimensions and varied image content');
      const selected = await selectRegion();
      const rectangle = await annotate('rect', '#ef4444', [0.31, 0.35], [0.55, 0.48]);
      await click('.shot-actions button:nth-child(1)');
      assert.equal((await canvasReceipt()).sha256, selected.sha256, 'Undo restores exact pre-annotation canvas pixels');
      assert.equal(await read("document.querySelector('.shot-actions button:nth-child(1)').disabled"), true);
      const arrow = await annotate('arrow', '#22c55e', [0.35, 0.4], [0.65, 0.55]);
      const pen = await annotate('pen', '#3b82f6', [0.3, 0.57], [0.66, 0.62]);
      await h.screenshot('media-annotation-tools');
      await click('.shot-actions button:nth-child(2)');
      assert.equal(await read("document.querySelector('.shot-overlay').classList.contains('has-selection')"), false);
      assert.equal((await canvasReceipt()).sha256, frame.sha256, 'Reset restores the exact frozen capture');
      await selectRegion(); await click('.shot-actions button:nth-child(3)'); await gone('.shot-overlay');
      assert.equal(await read("document.querySelector('#chatInput').value"), draft);
      assert.deepEqual(await attachments(), before); assert.equal(h.report.providerRequests.length, requests);
      return { source, capturedFrame: frame, rectangle, arrow, pen, undoPixelEquality: true, resetPixelEquality: true, cancelled: true, attachmentAdded: false, sentToModel: false };
    } finally { await recover(); }
  });

  await h.check('Media / confirming actual annotated window capture creates a decoded PNG attachment', async () => {
    await conversation(); const draft = await read("document.querySelector('#chatInput').value"), before = await attachments();
    const requests = h.report.providerRequests.length, marker = 'COMPONENT_REAL_SCREENSHOT_' + h.report.runId.slice(0, 8);
    let ownedId;
    try {
      await type('#chatInput', marker);
      const source = await pickOwnWindow(); await selectRegion();
      const rectangle = await annotate('rect', '#a855f7', [0.3, 0.36], [0.66, 0.57]);
      const annotated = await canvasReceipt('media-capture-before-confirm');
      await click('.shot-primary'); await gone('.shot-overlay');
      const item = await h.until(async () => {
        const added = (await attachments()).filter(row => !before.some(old => old.id === row.id));
        return added.length === 1 && added[0];
      }, 'Exactly one actual screenshot attachment created');
      ownedId = item.id; assert.match(item.name, /^截图 \d{6}\.png$/);
      const chip = '#attachPreview .attach-chip[data-id=' + q(item.id) + ']';
      await h.until(() => read(`(()=>{const i=document.querySelector(${q(chip + ' img')});return !!i&&i.complete&&i.naturalWidth>12&&i.naturalHeight>12})()`), 'Actual captured attachment image decoded');
      const output = await read(`(()=>{const i=document.querySelector(${q(chip + ' img')});return {width:i.naturalWidth,height:i.naturalHeight,src:i.src}})()`);
      assert.ok(output.src.startsWith('data:image/png;base64,'));
      const png = Buffer.from(output.src.slice('data:image/png;base64,'.length), 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), output.width); assert.equal(png.readUInt32BE(20), output.height);
      const file = path.join(h.out, 'media-actual-capture-attachment.png'); fs.writeFileSync(file, png, { flag: 'wx' });
      await click(chip); await shown('#imagePreviewOverlay');
      await h.until(() => read(`(()=>{const i=document.querySelector('#imagePreviewImage');return i.complete&&i.naturalWidth===${output.width}&&i.naturalHeight===${output.height}})()`), 'Full preview decodes the exact screenshot PNG');
      await h.screenshot('media-capture-attachment-preview'); await click('#imagePreviewClose');
      assert.equal(await read("document.querySelector('#chatInput').value"), marker);
      assert.equal(h.report.providerRequests.length, requests); await h.screenshot('media-capture-attachment-composer');
      return { source, rectangle, annotatedCanvas: annotated, attachment: { id: item.id, name: item.name, file, width: output.width, height: output.height, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }, fullPreviewDecoded: true, sentToModel: false, cleanup: 'Only this screenshot chip is removed after evidence capture; original draft and attachments restored' };
    } finally {
      await recover();
      if (ownedId && (await attachments()).some(row => row.id === ownedId)) await click('#attachPreview .attach-chip[data-id=' + q(ownedId) + '] .attach-chip-remove');
      await type('#chatInput', draft); assert.deepEqual(await attachments(), before);
    }
  });

  await h.check('Media / voice capability or actual denied microphone path stays local', async () => {
    await conversation();
    const capability = await read("({recognition:!!(window.SpeechRecognition||window.webkitSpeechRecognition),hidden:!!document.querySelector('#voiceBtn')?.hidden,title:document.querySelector('#voiceBtn')?.title})");
    if (!capability.recognition) {
      assert.equal(capability.hidden, true, 'Production hides voice input when the actual Chromium capability is absent');
      return { capability, path: 'Real unavailable browser capability', recordingVerified: false, voiceButtonClicked: false, submittedAudio: false };
    }
    // This product uses webkitSpeechRecognition without processLocally. Starting
    // it under a granted/prompt permission could send microphone audio remotely.
    // Exercise an actual denial only; absence of this prerequisite is a failure,
    // never a mocked success or a claim that local recording was verified.
    const permission = await read("navigator.permissions?.query({name:'microphone'}).then(p=>({state:p.state})).catch(e=>({state:'unknown',error:e.message}))||({state:'unknown'})");
    assert.equal(permission.state, 'denied', 'Voice acceptance requires a real denied microphone permission in this isolated Electron profile before clicking; online speech recognition is not started under prompt/granted permission');
    const draft = await read("document.querySelector('#chatInput').value"), before = await attachments(), requests = h.report.providerRequests.length;
    const deniedHint = await read("IexaI18n.t('voice.deniedHint')"), deniedTitle = await read("IexaI18n.t('voice.denied')");
    await h.nativeClickSelector('#voiceBtn');
    const error = await h.until(() => read(`(()=>{const b=document.querySelector('#voiceBtn'),s=document.querySelector('#statusText')?.textContent||'';return s===${q(deniedHint)}||b.title===${q(deniedTitle)}?{state:b.dataset.voiceState,title:b.title,status:s,pressed:b.getAttribute('aria-pressed')}:false})()`), 'Actual recognition permission error shown by product', 8000);
    await h.until(() => read("document.querySelector('#voiceBtn').getAttribute('aria-pressed')==='false'&&!document.querySelector('#chatInput').classList.contains('is-voice-live')"), 'Actual voice lifecycle settles after permission denial', 8000);
    assert.equal(await read("document.querySelector('#chatInput').value"), draft); assert.deepEqual(await attachments(), before);
    assert.equal(h.report.providerRequests.length, requests); await h.screenshot('media-voice-permission-denied');
    return { capability, permission, actualError: error, settled: true, draftPreserved: true, submittedAudio: false, recordingVerified: false, scope: 'Actual browser microphone denial and production voice error path; no recording or speech recognition success claim' };
  });
}

module.exports = { runMedia };
