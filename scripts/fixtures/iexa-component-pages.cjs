'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { prepareData } = require('./iexa-component-pages-data.cjs');
const fixtures = new WeakMap();
const q = JSON.stringify;
const cssPath = `e=>{const p=n=>n.id?'#'+CSS.escape(n.id):n===document.body?'body':p(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return p(e)}`;

async function prepareFixtures(h) {
  if (!fixtures.has(h)) fixtures.set(h, await prepareData(h));
  return { pluginSource: fixtures.get(h).source, pluginId: fixtures.get(h).plugin.id, ...h.report.fixture };
}
async function cleanupFixtures(h) {
  const data = fixtures.get(h); if (!data) return;
  h.report.fixture.componentServiceRequests = data.requests;
  await data.close(); fixtures.delete(h); h.save();
}
function helpers(h) {
  const read = e => h.read(e);
  const get = route => read(`fetch(${q(route)},{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||('HTTP '+r.status));return d})`);
  const value = selector => read(`document.querySelector(${q(selector)})?.value`);
  const text = selector => read(`document.querySelector(${q(selector)})?.textContent?.trim()||''`);
  const exists = selector => read(`!!document.querySelector(${q(selector)})`);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none'})()`);
  const wait = (fn, label, timeout) => h.until(fn, label, timeout);
  const click = selector => h.clickSelector(selector);
  const type = (selector, string) => h.typeSelector(selector, string);
  const select = (selector, string) => h.selectSelector(selector, string);
  async function match(selector, needle, exact = true) {
    const result = await read(`(()=>{const es=Array.from(document.querySelectorAll(${q(selector)})).filter(e=>{const r=e.getBoundingClientRect();return r.width>1&&r.height>1&&${exact ? 'e.textContent.trim()===' + q(needle) : 'e.textContent.includes(' + q(needle) + ')'}});if(es.length!==1)throw Error('Expected one visible text match; found '+es.length);return (${cssPath})(es[0])})()`);
    return result;
  }
  async function confirm(accept = true) {
    await wait(() => visible('dialog.iexa-app-dialog[open]'), 'Application confirmation displayed');
    await click(accept ? 'dialog.iexa-app-dialog[open] .btn-primary' : 'dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)');
    await wait(async () => !await exists('dialog.iexa-app-dialog[open]'), 'Application confirmation closed');
  }
  async function prompt(answer, accept = true) {
    await wait(() => visible('dialog.iexa-app-dialog[open] input'), 'Application prompt displayed');
    if (accept) await type('dialog.iexa-app-dialog[open] input', answer);
    await confirm(accept);
  }
  async function recover() {
    // Recover only visible dialogs left by a failed check, through their real
    // cancellation controls. A check is already recorded failed before here.
    if (await visible('dialog.iexa-app-dialog[open]')) await confirm(false);
    for (const selector of ['dialog.bots-dialog[open] .bots-form-actions button:not([type=submit])', '.plugin-workspace-dialog[open] .plugin-workspace-header button:last-child', '#profileEditorOverlay [data-ui-action=hideProfileEditor]', '#skillEditorCancel', '#scheduledCancel', '#docPicker .doc-picker-head button']) {
      if (await visible(selector)) await click(selector);
    }
  }
  async function nav(view) { await recover(); await h.nav(view); await h.inventory(view); }
  async function saved(route, choose, label) { return wait(async () => choose(await get(route)), label); }
  return { read, get, value, text, exists, visible, wait, click, type, select, match, confirm, prompt, recover, nav, saved };
}

async function runPages(h) {
  await prepareFixtures(h);
  const f = fixtures.get(h), s = helpers(h), token = h.report.runId.slice(0, 8);
  const { read, get, value, text, exists, visible, wait, click, type, select, match, confirm, prompt, nav, saved } = s;

  await h.check('page-chat-send-and-trajectory', async () => {
    await nav('chat');
    await type('#chatInput', 'COMPONENT_CHAT_' + token);
    await click('#sendBtn');
    await wait(() => read(`document.querySelector('#view-chat')?.textContent.includes('COMPONENT_REPLY_OK') && !document.querySelector('#stopBtn')?.getBoundingClientRect().width`), 'Actual provider reply rendered', 25000);
    const tabs = await read(`Array.from(document.querySelectorAll('.chat-view-tab')).map(e=>({text:e.textContent.trim(),selector:(${cssPath})(e)}))`);
    assert.ok(tabs.length >= 2, 'Conversation and trajectory tabs exist');
    await click(tabs[1].selector);
    await wait(() => visible('#trajectoryRefresh'), 'Trajectory controls rendered');
    await click('#trajectoryRefresh');
    await click(tabs[0].selector);
    assert.ok(h.report.providerRequests.some(r => r.prompt.includes('COMPONENT_CHAT_' + token)), 'Production chat reached isolated provider');
    return { prompt: 'COMPONENT_CHAT_' + token, actualProviderRequest: true, trajectoryOpenedAndRefreshed: true };
  });

  await h.check('page-settings-model-crud', async () => {
    await nav('settings');
    const baseURL = await read(`fetch('/api/profiles').then(r=>r.json()).then(d=>d.profiles.find(p=>p.id==='component-local')?.baseURL)`);
    assert.match(baseURL, /^http:\/\/127\.0\.0\.1:/);
    const name = 'Component model ' + token;
    await click('[data-ui-action=showProfileEditor]');
    await type('#profileEditorName', 'Cancelled component model');
    await click('#profileEditorOverlay .profile-editor-actions [data-ui-action=hideProfileEditor]');
    assert.equal((await get('/api/profiles')).profiles.some(p => p.name === 'Cancelled component model'), false);
    await click('[data-ui-action=showProfileEditor]');
    await type('#profileEditorName', name);
    await select('#profileEditorProvider', 'custom');
    await type('#profileEditorApiKey', 'LOCAL_FIXTURE_ONLY');
    await type('#profileEditorBaseURL', baseURL);
    await type('#profileEditorModel', 'component-model');
    await click('#fetchModelsBtn');
    await wait(() => read(`Array.from(document.querySelector('#profileEditorModelSelect')?.options||[]).some(o=>o.value==='component-model')`), 'Actual local provider model listing');
    await select('#profileEditorModelSelect', 'component-model');
    await click('[data-ui-action=saveProfile]');
    let profile = await saved('/api/profiles', d => d.profiles.find(p => p.name === name), 'Created model persisted');
    await click(`[data-ui-action=editProfile][data-ui-arg="${profile.id}"]`);
    await type('#profileEditorName', name + ' edited');
    await type('#profileEditorApiKey', '');
    await click('[data-ui-action=saveProfile]');
    profile = await saved('/api/profiles', d => d.profiles.find(p => p.id === profile.id && p.name === name + ' edited'), 'Edited model persisted');
    await click(`[data-ui-action=deleteProfile][data-ui-arg="${profile.id}"]`);
    await confirm(false);
    assert.ok((await get('/api/profiles')).profiles.some(p => p.id === profile.id));
    await click(`[data-ui-action=deleteProfile][data-ui-arg="${profile.id}"]`);
    await confirm();
    await saved('/api/profiles', d => !d.profiles.some(p => p.id === profile.id), 'Deleted model removed');
    return { createdEditedDeleted: profile.id, cancelledCreateAndDelete: true, actualModelList: ['component-model'], secretValueNotRecorded: true };
  });

  await h.check('page-bots-crud', async () => {
    await nav('bots');
    await wait(() => exists('.bots-header-actions .bots-primary'), 'Bot page loaded');
    const name = 'Component Bot ' + token;
    await click('.bots-header-actions .bots-primary');
    await type('#bots-editor-name', name);
    await type('#bots-editor-description', 'COMPONENT_BOT_DESCRIPTION');
    await type('#bots-editor-persona', 'Reply with the local fixture receipt.');
    await type('#bots-editor-memory', 'COMPONENT_BOT_MEMORY');
    await select('#bots-editor-profileId', 'component-local');
    await click('dialog.bots-dialog[open] button[type=submit]');
    let bot = await saved('/api/bots', d => d.bots.find(b => b.name === name), 'Bot creation persisted');
    const card = await match('.bots-card', name, false);
    await click(card + ' .bots-card-actions button:nth-child(2)');
    await type('#bots-editor-description', 'COMPONENT_BOT_EDITED');
    await click('dialog.bots-dialog[open] button[type=submit]');
    bot = await saved('/api/bots', d => d.bots.find(b => b.id === bot.id && b.description === 'COMPONENT_BOT_EDITED'), 'Bot update persisted');
    await click((await match('.bots-card', name, false)) + ' .bots-card-actions button:last-child');
    await confirm(false);
    assert.ok((await get('/api/bots')).bots.some(b => b.id === bot.id));
    await click((await match('.bots-card', name, false)) + ' .bots-card-actions button:last-child');
    await confirm();
    await saved('/api/bots', d => !d.bots.some(b => b.id === bot.id), 'Bot deletion persisted');
    return { id: bot.id, profileId: bot.profileId, allowedTools: bot.allowedTools, createdEditedDeleted: true, cancelledDelete: true };
  });

  await h.check('page-skills-crud-filters', async () => {
    await nav('skills');
    const name = 'component-skill-' + token;
    const content = `---\nname: ${name}\ndescription: Component desktop acceptance fixture\n---\n# Component fixture\nCOMPONENT_SKILL_ORIGINAL\n`;
    await click('#skillAddBtn'); await click('#skillImportBtn');
    await type('#skillEditorContent', content); await click('#skillEditorSave');
    let skill = await saved('/api/skills', d => d.skills.find(x => x.name === name), 'Skill import persisted');
    const card = `.skill-card[data-id="${skill.id}"]`;
    await wait(() => exists(card), 'Skill card rendered');
    await click(card + ' [data-act=toggle]');
    await saved('/api/skills', d => d.skills.some(x => x.id === skill.id && x.enabled === false), 'Skill disabled');
    await click('[data-skill-filter=disabled]');
    assert.equal(await visible(card), true);
    await click('[data-skill-filter=enabled]');
    assert.equal(await exists(card), false);
    await click('[data-skill-filter=all]');
    await click(card + ' [data-act=toggle]');
    await saved('/api/skills', d => d.skills.some(x => x.id === skill.id && x.enabled !== false), 'Skill enabled');
    await click(card + ' [data-act=sysprompt]');
    await saved('/api/skills', d => d.skills.some(x => x.id === skill.id && x.systemPrompt === true), 'Skill system prompt toggled');
    await click(card + ' [data-act=view]');
    await type('#skillEditorContent', content.replace('ORIGINAL', 'EDITED')); await click('#skillEditorSave');
    await saved('/api/skills/' + encodeURIComponent(skill.id), d => d.content?.includes('COMPONENT_SKILL_EDITED'), 'Skill content update persisted');
    await click(card + ' [data-act=delete]'); await confirm();
    await saved('/api/skills', d => !d.skills.some(x => x.id === skill.id), 'Skill deletion persisted');
    return { id: skill.id, createEditDelete: true, enabledDisabledFilters: true, systemPromptToggle: true };
  });

  await h.check('page-scheduled-crud-run', async () => {
    await nav('scheduled'); await click('#scheduledNewBtn');
    await click('#scheduledSave');
    assert.ok(await text('#scheduledError'), 'Empty prompt produces visible validation');
    const title = 'Component schedule ' + token;
    await type('#scheduledTitle', title); await type('#scheduledPrompt', 'COMPONENT_SCHEDULE_' + token);
    await select('#scheduledModel', 'component-local');
    await click('#scheduledFrequency [data-freq=monthly]');
    await select('#scheduledDay', '28');
    await click('#scheduledSave');
    let task = await saved('/api/scheduled-tasks', d => d.tasks.find(t => t.title === title), 'Scheduled task created');
    const card = `.scheduled-card[data-id="${task.id}"]`;
    await wait(async () => !await visible('#scheduledEditor'), 'Scheduled editor closed');
    await click(card + ' [data-action=toggle]');
    await saved('/api/scheduled-tasks', d => d.tasks.some(t => t.id === task.id && !t.enabled), 'Scheduled task paused');
    await click(card + ' [data-action=edit]');
    await type('#scheduledTitle', title + ' edited'); await click('#scheduledSave');
    task = await saved('/api/scheduled-tasks', d => d.tasks.find(t => t.id === task.id && t.title === title + ' edited'), 'Scheduled task edited');
    await wait(async () => !await visible('#scheduledEditor'), 'Scheduled edit closed');
    await click(card + ' [data-action=run]');
    task = await saved('/api/scheduled-tasks', d => d.tasks.find(t => t.id === task.id && t.lastSessionId), 'Scheduled run created actual session');
    await wait(() => read(`document.querySelector('#view-chat')?.textContent.includes('COMPONENT_REPLY_OK')`), 'Scheduled reply rendered', 25000);
    assert.ok(h.report.providerRequests.some(r => r.prompt.includes('COMPONENT_SCHEDULE_' + token)), 'Scheduler reached local model');
    await nav('scheduled'); await click(card + ' [data-action=delete]'); await confirm();
    await saved('/api/scheduled-tasks', d => !d.tasks.some(t => t.id === task.id), 'Scheduled deletion persisted');
    return { taskId: task.id, runSessionId: task.lastSessionId, validationPauseEditRunDelete: true };
  });

  await h.check('page-appearance-rendered-settings', async () => {
    await nav('appearance');
    const original = await read(`({theme:document.documentElement.dataset.theme,motion:document.documentElement.dataset.motion,font:document.querySelector('#uiFontScale').value,icon:document.querySelector('#uiIconScale').value,collapse:document.querySelector('#collapseToolsToggle').checked,preset:document.querySelector('.skin-tile.is-active')?.dataset.skinId})`);
    const alternateTheme = original.theme === 'dark' ? 'light' : 'dark';
    await click(`[data-theme-set="${alternateTheme}"]`);
    assert.equal(await read('document.documentElement.dataset.theme'), alternateTheme);
    await click('[data-motion-set=reduced]');
    assert.equal(await read('document.documentElement.dataset.motion'), 'reduced');
    await h.keySelector('#uiFontScale', 'HOME'); await h.keySelector('#uiFontScale', 'ARROWRIGHT');
    assert.equal(await read('document.documentElement.dataset.fontScale'), '110');
    await h.keySelector('#uiIconScale', 'HOME'); await h.keySelector('#uiIconScale', 'ARROWRIGHT');
    assert.equal(await read('document.documentElement.dataset.iconScale'), '110');
    await click('#uiScaleReset');
    assert.equal(await read('document.documentElement.dataset.fontScale'), '100');
    await click('label[for="collapseToolsToggle"]');
    assert.equal(await read(`document.querySelector('#collapseToolsToggle').checked`), !original.collapse);
    await click('label[for="collapseToolsToggle"]');
    const alternative = await read(`Array.from(document.querySelectorAll('.skin-tile')).find(e=>e.dataset.skinId!=='default'&&e.dataset.skinId!==${q(original.preset)})?.dataset.skinId`);
    assert.ok(alternative, 'A nondefault skin is available'); await click(`[data-skin-id="${alternative}"]`);
    assert.equal(await read(`document.querySelector('.skin-tile.is-active')?.dataset.skinId`), alternative);
    assert.ok(await text('#contrastReport'), 'Contrast reflects rendered theme');
    await click(`[data-skin-id="${original.preset || 'default'}"]`);
    await click(`[data-theme-set="${original.theme}"]`); await click(`[data-motion-set="${original.motion || 'system'}"]`);
    return { actualThemeChange: alternateTheme, reducedMotion: true, fontAndIcon110ThenReset: true, skin: alternative, restoredThemeAndSkin: true };
  });

  await h.check('page-document-search-save-preview', async () => {
    // The scheduler creates another session; restore the project-bound fixture
    // using the actual session list before document persistence checks.
    await nav('chat');
    const sessionSelector = `.session-item[data-id="${h.report.fixture.sid}"] [data-ui-action=switchSession]`;
    await wait(() => exists(sessionSelector), 'Project-bound fixture remains in actual session list');
    await click(sessionSelector);
    await wait(() => read(`currentSessionId===${q(h.report.fixture.sid)}`), 'Project-bound fixture session selected');
    await nav('doc'); await wait(() => exists('#docEditor'), 'Document editor mounted');
    await click('#docNewBtn');
    const content = '# Component document\n\nCOMPONENT_DOC_RECEIPT twice: COMPONENT_DOC_RECEIPT\n';
    await type('#docEditor', content);
    await type('#docSearchInput', 'COMPONENT_DOC_RECEIPT');
    assert.equal(await text('#docSearchCount'), '1/2');
    await type('#docSearchInput', '');
    await click('#docSaveBtn'); await prompt('', false);
    assert.equal(await value('#docEditor'), content, 'Cancelled save preserves buffer');
    const target = path.join(h.report.fixture.project, 'component-document-' + token + '.md');
    await click('#docSaveBtn'); await prompt(target);
    await wait(() => fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content, 'Actual document bytes written');
    // The document workspace initially shows both panes. Exercise the visible
    // transition without assuming that the first click opens the preview.
    if (await visible('#docPreview')) {
      await click('#docPreviewBtn');
      await wait(async () => !await visible('#docPreview') && await visible('#docEditor'), 'Preview hidden while editor stays visible');
    }
    await click('#docPreviewBtn');
    await wait(() => visible('#docPreview'), 'Rendered markdown preview visible');
    assert.match(await text('#docPreview'), /COMPONENT_DOC_RECEIPT/);
    await click('#docPreviewBtn');
    await wait(async () => !await visible('#docPreview') && await visible('#docEditor'), 'Preview closed and editable document restored');
    const copy = path.join(h.report.fixture.project, 'component-document-copy-' + token + '.md');
    await click('#docSaveAsBtn'); await prompt(copy);
    await wait(() => fs.existsSync(copy) && fs.readFileSync(copy, 'utf8') === content, 'Save As creates second actual file');
    return { savedFile: target, savedAsFile: copy, bytes: Buffer.byteLength(content), search: '1/2', renderedPreview: true, cancelledSavePreservedBuffer: true };
  });

  await h.check('page-soul-and-project-scope', async () => {
    await nav('soul');
    await type('#soulName', 'Component Soul ' + token); await select('#soulLanguage', 'zh');
    await type('#soulStyle', 'Direct fixture responses'); await type('#soulBody', 'COMPONENT_SOUL_RECEIPT');
    await click('#soulSaveBtn');
    const soul = await saved('/api/soul', d => d.metadata?.name === 'Component Soul ' + token && d.body.includes('COMPONENT_SOUL_RECEIPT') && d, 'Soul data persisted');
    if (!await read(`document.querySelector('#view-soul details:has(#scopeTargets)')?.open`)) await click('#view-soul details:has(#scopeTargets) > summary');
    await wait(() => read(`!document.querySelector('#scopeSaveBtn').disabled`), 'Project scope bound to project');
    await type('#scopeTargets', 'http://127.0.0.1/component-fixture');
    await type('#scopeOperations', 'Read isolated component project');
    await type('#scopeNotes', 'COMPONENT_SCOPE_RECEIPT'); await click('#scopeSaveBtn');
    const scope = await saved('/api/project/scope', d => d.scope?.notes === 'COMPONENT_SCOPE_RECEIPT' && d, 'Project scope persisted');
    await wait(() => read(`!document.querySelector('#scopeSaveBtn').disabled&&!!document.querySelector('#scopeFeedback').textContent.trim()`), 'Project scope save feedback and controls settled');
    await click('#scopeReloadBtn');
    await wait(() => read(`!document.querySelector('#scopeSaveBtn').disabled&&document.querySelector('#scopeNotes').value==='COMPONENT_SCOPE_RECEIPT'`), 'Saved project scope reloads');
    await click('#soulRestoreBtn'); await confirm(false);
    assert.equal((await get('/api/soul')).metadata.name, 'Component Soul ' + token);
    await click('#soulRestoreBtn'); await confirm();
    await saved('/api/soul', d => d.metadata.name !== 'Component Soul ' + token, 'Default soul restored');
    return { soulPath: soul.path, scopeProject: scope.projectRoot, savedReloaded: true, restoreCancelAndConfirm: true };
  });

  await h.check('page-insights-range-and-filter', async () => {
    await nav('token-calculator');
    await click('.insights-ranges [data-range=all]');
    await wait(async () => !await exists('#insightsGrid .insights-loading'), 'Usage insights loaded');
    const data = await get('/api/usage/insights?range=all');
    assert.equal(await read(`document.querySelector('.insights-ranges [data-range=all]').getAttribute('aria-selected')`), 'true');
    assert.equal(await exists('#insightsGrid .insights-error'), false);
    if (data.totals.turns > 0) {
      await wait(() => exists('#insightsSearch'), 'Usage search rendered for actual recorded turns');
      await type('#insightsSearch', 'NO_COMPONENT_SESSION_MATCH_' + token);
      await wait(() => read(`document.querySelectorAll('.insights-session').length===0`), 'Usage session filter excludes mismatches');
      await type('#insightsSearch', '');
      await wait(() => read(`document.querySelectorAll('.insights-session').length>0`), 'Usage filter reset restores actual sessions');
      return { range: 'all', actualRecordedTurns: data.totals.turns, searchExcludedAndRestored: true };
    }
    assert.equal(await exists('#insightsGrid .insights-empty'), true, 'Zero usage accurately shows empty state');
    return { range: 'all', actualRecordedTurns: 0, verifiedBranch: 'accurate empty state', searchNotExercised: 'No recorded usage turns' };
  });

  await h.check('page-mcp-http-full-lifecycle', async () => {
    await nav('mcp'); const name = 'Component MCP ' + token;
    await type('#mcpName', name); await select('#mcpTransport', 'http');
    await type('#mcpUrl', h.report.fixture.componentMcpUrl); await click('#mcpAddForm button[type=submit]');
    let server = await saved('/api/mcp/servers', d => d.servers.find(x => x.name === name), 'MCP registration persisted');
    const card = `.mcp-server-card[data-mcp-server="${server.id}"]`;
    await wait(() => exists(card), 'MCP card rendered'); await click(card + ' [data-mcp-action=connect]');
    server = await saved('/api/mcp/servers', d => d.servers.find(x => x.id === server.id && x.status === 'connected'), 'MCP initialize and discovery completed');
    await wait(() => exists(card + ' [data-mcp-call=component_echo]'), 'Discovered MCP tool rendered');
    await click(card + ' [data-mcp-call=component_echo]'); await prompt(JSON.stringify({ text: token }));
    await wait(async () => (await text('#mcpOutput')).includes('MCP_COMPONENT_RECEIPT ' + token), 'MCP tool result rendered');
    await click(card + ' [data-mcp-resource="fixture://component"]');
    await wait(async () => (await text('#mcpOutput')).includes('MCP_RESOURCE_COMPONENT_RECEIPT'), 'MCP resource content rendered');
    await click(card + ' [data-mcp-action=disconnect]');
    await saved('/api/mcp/servers', d => d.servers.some(x => x.id === server.id && x.status !== 'connected'), 'MCP disconnected');
    await click(card + ' [data-mcp-action=remove]');
    await confirm();
    await saved('/api/mcp/servers', d => !d.servers.some(x => x.id === server.id), 'MCP removed');
    await wait(async () => !await exists(card), 'Removed MCP card disappears');
    const methods = f.requests.filter(x => x.path === '/mcp').map(x => x.rpc);
    for (const method of ['initialize', 'tools/list', 'resources/list', 'tools/call', 'resources/read']) assert.ok(methods.includes(method), 'Actual MCP request ' + method);
    return { serverId: server.id, actualRpcMethods: methods, connectedCalledReadDisconnectedRemoved: true };
  });

  await h.check('page-plugins-market-search', async () => {
    await nav('plugins');
    if (!await visible('#pluginMarketIndex')) await click('#pluginMarketToggle');
    await type('#pluginMarketIndex', h.report.fixture.componentMarketUrl);
    await type('#pluginMarketQuery', 'component-fixture'); await click('#pluginMarketSearchBtn');
    await wait(() => exists('#pluginMarketList .market-card'), 'Actual local market search result rendered');
    assert.match(await text('#pluginMarketList'), /Component Pages Fixture/);
    await type('#pluginMarketQuery', 'unmatched-' + token); await click('#pluginMarketSearchBtn');
    await wait(() => read(`document.querySelectorAll('#pluginMarketList .market-card').length===0 && document.querySelector('#pluginMarketHint').textContent.trim().length>0`), 'Market no-match result rendered');
    assert.ok(f.requests.some(r => r.path === '/market.json'), 'Production market requested local index');
    return { localIndexRequested: true, matchAndNoMatch: true, nativeInstallation: 'Separate runPluginChecks after root installs fixture through actual directory picker', marketInstallationNotExercised: true };
  });

  await h.check('page-sync-bridge-and-webdav-error', async () => {
    await nav('sync');
    let bridge = await get('/api/mobile-bridge/status');
    const originallyEnabled = !!bridge.enabled;
    if (!bridge.enabled) await click('#mobileBridgeEnabled');
    bridge = await saved('/api/mobile-bridge/status', d => d.enabled && d, 'Bridge enabled through UI');
    await select('#mobileBridgeCapability', 'chat');
    await saved('/api/mobile-bridge/status', d => d.defaultCapability === 'chat', 'Bridge default capability saved');
    const hasAddress = bridge.addresses?.length > 0;
    if (hasAddress) {
      await click('#mobileBridgePairBtn');
      await wait(() => read(`document.querySelector('#mobileBridgeQr').src.startsWith('data:image/')&&document.querySelector('#mobileBridgeUrl').textContent.includes('http')`), 'Actual pairing QR and URL produced');
    } else assert.ok(await text('#mobileBridgeAddress'), 'No LAN address explicitly represented');
    if (!originallyEnabled) { await click('#mobileBridgeEnabled'); await saved('/api/mobile-bridge/status', d => !d.enabled, 'Bridge restored disabled'); }
    await type('#webdavUrl', h.report.fixture.componentWebdavUrl); await type('#webdavUser', 'component-user'); await type('#webdavPass', 'LOCAL_FIXTURE_ONLY');
    if (await read(`document.querySelector('#webdavAutoSync').checked`)) await click('#webdavAutoSync');
    await click('[data-ui-action=saveWebDAVConfig]');
    await wait(async () => (await text('#syncResult')).length > 0, 'WebDAV configuration save result');
    await click('[data-ui-action=testWebDAV]');
    await wait(() => f.requests.some(r => r.path.startsWith('/webdav')), 'Actual WebDAV request reached controlled unavailable service');
    await wait(() => read(`document.querySelector('#syncResult').classList.contains('sync-error')`), 'WebDAV failure rendered as error');
    return { bridgeEnabledAndRestored: true, pairingQrGenerated: hasAddress, webdavVerifiedBranch: 'Actual HTTP 503 connection failure', webdavSuccessNotExercised: true, webdavRequests: f.requests.filter(r => r.path.startsWith('/webdav')) };
  });

  await h.check('page-pet-empty-state-and-behavior', async () => {
    await nav('pet'); const before = await get('/api/pet');
    assert.equal(before.hasSprite, false, 'Fixture has no imported sprite');
    assert.equal(await read(`document.querySelector('#petSummon').disabled&&document.querySelector('#petClear').disabled`), true);
    await click('#pet-wander');
    await saved('/api/pet', d => d.config.wander !== before.config.wander, 'Pet behavior setting persisted');
    await click('#pet-wander');
    await saved('/api/pet', d => d.config.wander === before.config.wander, 'Pet behavior restored');
    await h.keySelector('#petScale', 'HOME'); await h.keySelector('#petScale', 'ARROWRIGHT');
    await h.keySelector('#petScale', 'TAB');
    await saved('/api/pet', d => Math.abs(d.config.scale - 0.55) < 0.001, 'Pet actual range change persisted');
    await h.keySelector('#petScale', 'HOME');
    for (let i = 0; i < Math.round((before.config.scale * 100 - 50) / 5); i++) await h.keySelector('#petScale', 'ARROWRIGHT');
    await h.keySelector('#petScale', 'TAB');
    await saved('/api/pet', d => Math.abs(d.config.scale - before.config.scale) < 0.001, 'Pet scale restored');
    return { verifiedBranch: 'No sprite, disabled summon/delete; persisted behavior and scale', imageImportNotExercised: 'Root native picker scenarios', restoredScale: before.config.scale };
  });

  await h.check('page-about-diagnostics-artifact', async () => {
    await nav('about'); await click('#view-about [data-ui-action=exportDiagnostics]');
    const artifact = await wait(async () => {
      const result = await text('#diagnosticsResult');
      const candidates = result.match(/[A-Za-z]:[\\/][^\r\n]+?\.(?:json\.gz|zip|json|txt)/g) || [];
      const file = candidates.find(p => fs.existsSync(p)); return file && { file, result };
    }, 'Actual diagnostics file path rendered and file exists', 20000);
    const bytes = fs.readFileSync(artifact.file); assert.ok(bytes.length > 0, 'Diagnostic artifact has real content');
    if (/\.zip$/i.test(artifact.file)) assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'Diagnostics is valid ZIP header');
    else if (/\.json\.gz$/i.test(artifact.file)) {
      assert.equal(bytes.subarray(0, 2).toString('hex'), '1f8b', 'Diagnostics has a gzip header');
      const document = JSON.parse(gunzipSync(bytes).toString('utf8'));
      assert.ok(document && typeof document === 'object' && !Array.isArray(document), 'Compressed diagnostics contains a JSON object');
    }
    else if (/\.json$/i.test(artifact.file)) JSON.parse(bytes.toString('utf8'));
    const links = await read(`Array.from(document.querySelectorAll('#view-about a[href]')).map(a=>({text:a.textContent.trim(),href:a.getAttribute('href')}))`);
    assert.ok(links.length > 0 && links.every(x => /^https?:\/\//.test(x.href)), 'About external links have actual HTTP destinations');
    return { diagnosticsFile: artifact.file, diagnosticsBytes: bytes.length, externalDestinationsChecked: links, externalBrowsersNotOpened: true };
  });
  h.report.fixture.componentServiceRequests = f.requests; h.save();
}

// The caller installs prepareFixtures(h).pluginSource using the real native
// directory picker before this function. Missing installation is a failed
// prerequisite, never a silently skipped success.
async function runPluginChecks(h) {
  await prepareFixtures(h); const f = fixtures.get(h), s = helpers(h);
  const { get, nav, wait, click, exists, visible, confirm } = s;
  await h.check('plugins-installed-native-lifecycle', async () => {
    await nav('plugins');
    let plugin = (await get('/api/plugins')).plugins.find(p => p.id === f.plugin.id);
    assert.ok(plugin, 'Root must first install prepared fixture through actual IEXA directory picker');
    assert.equal(plugin.error, undefined, 'Installed fixture manifest is valid');
    const card = `.plugin-card[data-plugin-id="${plugin.id}"]`;
    await wait(() => exists(card), 'Installed plugin card rendered');
    if (!plugin.enabled) await click(card + ' [data-plugin-enable]');
    await wait(async () => (await get('/api/plugins')).plugins.some(p => p.id === plugin.id && p.enabled), 'Plugin enabled through UI');
    await click(card + ' [data-plugin-open]');
    await wait(() => visible('.plugin-workspace-dialog[open] .plugin-workspace-frame'), 'Installed plugin iframe opened');
    const frame = await h.read(`(()=>{const e=document.querySelector('.plugin-workspace-frame');return {src:e.getAttribute('src'),sandbox:e.getAttribute('sandbox'),loading:!document.querySelector('.plugin-frame-status').hidden}})()`);
    await wait(() => h.read(`!!document.querySelector('.plugin-workspace-frame')?.getAttribute('src')&&document.querySelector('.plugin-frame-status').hidden`), 'Actual installed plugin HTML loaded');
    assert.equal(frame.sandbox, 'allow-scripts', 'Plugin panel retains opaque sandbox');
    const html = await h.read(`fetch(document.querySelector('.plugin-workspace-frame').src).then(r=>{if(!r.ok)throw Error('Plugin HTML '+r.status);return r.text()})`);
    assert.match(html, /PLUGIN_COMPONENT_RECEIPT/);
    await click('.plugin-workspace-dialog[open] .plugin-workspace-header button:first-of-type');
    await wait(() => h.read(`document.querySelector('.plugin-frame-status')?.hidden===true`), 'Plugin panel reload completed');
    await click('.plugin-workspace-dialog[open] .plugin-workspace-header button:last-child');
    await click(card + ' [data-plugin-action=reload]');
    await wait(async () => (await get('/api/plugins')).plugins.some(p => p.id === plugin.id && !p.error), 'Plugin reload retains valid manifest');
    await click(card + ' [data-plugin-enable]');
    await wait(async () => (await get('/api/plugins')).plugins.some(p => p.id === plugin.id && !p.enabled), 'Plugin disabled through UI');
    assert.equal(await h.read(`document.querySelector(${q(card + ' [data-plugin-open]')}).disabled`), true);
    await click(card + ' [data-plugin-action=remove]'); await confirm(false);
    assert.ok((await get('/api/plugins')).plugins.some(p => p.id === plugin.id), 'Cancelled uninstall preserves installed plugin');
    await click(card + ' [data-plugin-action=remove]'); await confirm();
    await wait(async () => !(await get('/api/plugins')).plugins.some(p => p.id === plugin.id), 'Plugin uninstalled through UI');
    return { id: plugin.id, nativeInstallationPrerequisiteConfirmed: true, enabledPanelLoadedReloadedDisabledUninstalled: true, panelReceipt: 'PLUGIN_COMPONENT_RECEIPT', cancelledUninstall: true };
  });
}
module.exports = { prepareFixtures, runPages, runPluginChecks, cleanupFixtures };
