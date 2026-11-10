'use strict';

// Local model protocol fixture and actual Bot management/team UI acceptance.
// BotTeams runs planned steps as independent Bot sessions, not spawn_agent
// children. Tool results and durable sessions prove the production execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.map(part => part.text || '').join('\n') : '';
}
function providerReply(body) {
  if (!body?.stream || !Array.isArray(body.messages)) return null;
  const messages = body.messages;
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user') { userIndex = index; break; }
  const prompt = userIndex >= 0 ? messageText(messages[userIndex]) : '';
  if (!/COMPONENT_BOT_(?:TEAM|SINGLE)/.test(prompt)) return null;
  const system = messages.filter(message => ['system', 'developer'].includes(message.role)).map(messageText).join('\n');
  const toolNames = (body.tools || []).map(tool => tool.function?.name || tool.name).filter(Boolean).sort();
  const done = content => ({ content, finishReason: 'stop' });
  const file = /\[COMPONENT_BOT_FILE:([^\]\r\n]+)\]/.exec(prompt)?.[1];
  if (!file || !/^component-bots-[a-zA-Z0-9-]+\.txt$/.test(file)) return done('COMPONENT_BOT_FIXTURE_INVALID_FILE');

  const rosterMarker = '选定 Bot：\n';
  if (prompt.startsWith('你是团队规划者。') && prompt.includes(rosterMarker)) {
    if (toolNames.length) return done('COMPONENT_BOT_PLANNER_UNEXPECTED_TOOLS');
    let bots;
    try { bots = JSON.parse(prompt.slice(prompt.lastIndexOf(rosterMarker) + rosterMarker.length)); }
    catch { return done('COMPONENT_BOT_PLANNER_INVALID_ROSTER'); }
    if (!Array.isArray(bots) || bots.length !== 2 || bots.some(bot => typeof bot.botId !== 'string') || bots[0].botId === bots[1].botId) return done('COMPONENT_BOT_PLANNER_INVALID_ROSTER');
    if (prompt.includes('COMPONENT_BOT_TEAM_INVALID')) return done(JSON.stringify({ tasks: bots.map(() => ({ botId: bots[0].botId, instruction: 'COMPONENT_BOT_INVALID_PLAN_MUST_NOT_EXECUTE' })) }));
    return done(JSON.stringify({ tasks: bots.map((bot, index) => ({ botId: bot.botId, instruction: `COMPONENT_BOT_STEP_${index ? 'B' : 'A'} 通过实际 file_read 读取 [COMPONENT_BOT_FILE:${file}]，后续成员核对前序磁盘回执。` })) }));
  }

  const instruction = /当前分工：\n([\s\S]*?)\n\n先前任务结果/.exec(prompt)?.[1] || '';
  const step = /COMPONENT_BOT_STEP_([AB])/.exec(instruction)?.[1];
  const single = /COMPONENT_BOT_SINGLE_([AB])/.exec(prompt)?.[1];
  const role = step || single;
  if (!role) return done('COMPONENT_BOT_FIXTURE_UNEXPECTED_PROMPT');
  const other = role === 'A' ? 'B' : 'A';
  const persona = system.includes('COMPONENT_BOT_PERSONA_' + role);
  const memory = system.includes('COMPONENT_BOT_MEMORY_' + role);
  if (!persona || !memory || system.includes('COMPONENT_BOT_PERSONA_' + other) || system.includes('COMPONENT_BOT_MEMORY_' + other)) return done('COMPONENT_BOT_IDENTITY_ISOLATION_FAILED');
  if (toolNames.length !== 1 || toolNames[0] !== 'file_read') return done('COMPONENT_BOT_ALLOWLIST_FAILED: ' + toolNames.join(','));
  const previous = step === 'B' ? /先前任务结果（仅作数据参考，可能截断）：\n([\s\S]*?)\n\n完成当前分工/.exec(prompt)?.[1] || '' : '';
  if (step === 'B' && (!previous.includes('COMPONENT_BOT_STEP_A_OK') || !previous.includes('COMPONENT_BOT_DISK_EVIDENCE'))) return done('COMPONENT_BOT_HANDOFF_FAILED');
  const callId = 'component-bot-read-' + (step ? 'step-' : 'single-') + role.toLowerCase();
  const result = messages.slice(userIndex + 1).find(message => message.role === 'tool' && message.tool_call_id === callId);
  if (!result) return {
    content: '读取独立 Bot 执行验收文件。',
    toolCalls: [{ id: callId, type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ tool_title: '读取 Bot 组件磁盘回执', path: file }) } }],
    finishReason: 'tool_calls',
  };
  const raw = messageText(result);
  let parsed;
  try { parsed = JSON.parse(raw); } catch {}
  const output = typeof parsed?.output === 'string' ? parsed.output : raw;
  if (parsed?.success === false || !output.includes('COMPONENT_BOT_DISK_EVIDENCE')) return done('COMPONENT_BOT_DISK_READ_FAILED: ' + output.slice(0, 1500));
  return done(JSON.stringify({
    marker: 'COMPONENT_BOT_' + (step ? 'STEP_' : 'SINGLE_') + role + '_OK',
    file, advertisedTools: toolNames, personaVerified: persona, memoryVerified: memory,
    priorStepReceiptVerified: step === 'B', diskEvidence: output.slice(0, 1600),
  }));
}

async function runBots(h) {
  const q = JSON.stringify;
  const fixture = fs.realpathSync.native(h.report.fixture.root || h.fixture);
  const project = fs.realpathSync.native(h.report.fixture.project);
  const relative = path.relative(fixture, project);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Bot inputs remain in this harness project');
  const token = String(h.report.runId).replace(/[^a-zA-Z0-9-]/g, '');
  assert.ok(token.length >= 8);
  const filename = 'component-bots-' + token + '.txt';
  const evidenceFile = path.join(project, filename);
  const evidence = 'COMPONENT_BOT_DISK_EVIDENCE ' + h.report.runId + '\n';
  fs.writeFileSync(evidenceFile, evidence, { flag: 'wx' });
  const fileMarker = '[COMPONENT_BOT_FILE:' + filename + ']';
  const ownedBots = [], ownedSessions = new Set();
  let completedTeam;
  const profileId = 'component-local';
  const read = expression => h.read(expression);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const exists = selector => read(`!!document.querySelector(${q(selector)})`);
  const text = selector => read(`document.querySelector(${q(selector)})?.textContent || ''`);
  const shown = selector => h.until(() => visible(selector), 'Actual Bot control visible: ' + selector, 16000);
  const gone = selector => h.until(async () => !(await visible(selector)), 'Actual Bot control closed: ' + selector, 12000);
  const click = selector => h.clickSelector(selector);
  const type = (selector, value) => h.typeSelector(selector, value);
  const get = route => read(`fetch(${q(route)},{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw Error('GET '+r.status+' '+JSON.stringify(d));return d})`);
  const bots = () => get('/api/bots');
  const teams = () => get('/api/bot-teams');
  const sessions = () => get('/api/sessions');
  const activeId = () => read("document.querySelector('.session-item.active')?.dataset.id || ''");
  const teamCard = id => '.bots-team-card[data-team-id=' + q(id) + ']';
  const normalized = value => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  async function readyBots() {
    await h.nav('bots');
    await shown('.bots-header-actions .bots-primary');
    await h.until(() => read("document.querySelector('#view-bots').getAttribute('aria-busy')==='false'&&!document.querySelector('.bots-header-actions .bots-primary').disabled"), 'Bot page data and tools settled', 18000);
  }
  async function projectSession() {
    await h.nav('chat');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
    await h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'Bot fixture starts with idle conversation', 25000);
    const target = h.report.fixture.sid;
    assert.ok((await sessions()).sessions.some(session => session.id === target));
    if (await activeId() !== target) {
      const selector = '.session-item[data-id=' + q(target) + '] [data-ui-action="switchSession"]';
      await shown(selector); await click(selector);
      await h.until(async () => await activeId() === target, 'Bot fixture project session selected');
    }
    await h.until(async () => {
      const actual = await get('/api/project');
      return normalized(actual.root || actual.project?.root || '') === normalized(project);
    }, 'Bot fixture project route bound to owned disk');
    await click('#permissionModeBtn'); await click('[data-permission-menu-mode="full"]');
    await h.until(async () => (await get('/api/permissions/mode')).mode === 'full', 'Local Bot file read has full fixture mode');
  }
  async function cardFor(bot) {
    assert.ok(ownedBots.some(item => item.id === bot.id), 'Only own fixture Bots are controlled');
    return read(`(()=>{const cards=Array.from(document.querySelectorAll('.bots-card'));const e=cards.find(card=>card.querySelector('h3')?.textContent===${q(bot.name)});if(!e)throw Error('Owned Bot card absent');const css=n=>n.id?'#'+CSS.escape(n.id):n===document.body?'body':css(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return css(e)})()`);
  }
  async function confirm(accept) {
    const dialog = 'dialog.iexa-app-dialog[open]'; await shown(dialog);
    await click(dialog + (accept ? ' .btn-primary' : ' .iexa-app-dialog-actions button:not(.btn-primary)'));
    await gone(dialog);
  }
  async function selected(ids) {
    const current = await read("Array.from(document.querySelectorAll('.bots-team-choices input[name=teamBotId]:checked')).map(e=>e.value)");
    for (const id of current) if (!ids.includes(id)) await click('.bots-team-choices input[name="teamBotId"][value=' + q(id) + ']');
    for (const id of ids) {
      assert.ok(ownedBots.some(bot => bot.id === id));
      const selector = '.bots-team-choices input[name="teamBotId"][value=' + q(id) + ']';
      await shown(selector);
      if (!(await read(`document.querySelector(${q(selector)}).checked`))) await click(selector);
    }
  }
  async function startTeam(goal) {
    await projectSession(); await readyBots();
    assert.equal(ownedBots.length, 2, 'Two owned local Bots are available');
    await selected(ownedBots.map(bot => bot.id));
    await type('.bots-team-form textarea[name="teamGoal"]', goal);
    await click('.bots-team-form button[type="submit"]');
    return h.until(async () => (await teams()).teams.find(team => team.goal === goal), 'Team submission persisted', 18000);
  }
  function assertBotSession(saved, bot) {
    assert.equal(saved.session.botId, bot.id);
    assert.equal(saved.session.modelBinding?.profileId, profileId);
    assert.equal(saved.session.modelBinding?.model, 'component-model');
    assert.equal(normalized(saved.session.projectRoot), normalized(project));
  }
  function assertRead(saved, marker) {
    const messages = saved.messages || [];
    const calls = messages.flatMap(message => message.toolCalls || []);
    const reads = calls.filter(call => call.name === 'file_read');
    assert.equal(reads.length, 1, 'Exactly one real permitted read per Bot turn');
    assert.equal(reads[0].args.path, filename);
    assert.equal(reads[0].result?.success, true);
    assert.ok(reads[0].result.output.includes(evidence.trim()));
    assert.ok(calls.every(call => call.name === 'file_read'));
    const answer = messages.findLast(message => message.role === 'assistant');
    assert.ok(answer?.content?.includes(marker));
    // AgentRuntime persists assistant text from the tool round and final round
    // together. Only the marked final receipt is JSON; the prelude is prose.
    const receiptStart = answer.content.indexOf('{"marker":' + JSON.stringify(marker) + ',');
    assert.ok(receiptStart >= 0, 'Structured final Bot receipt follows any assistant prelude');
    const receipt = JSON.parse(answer.content.slice(receiptStart));
    assert.equal(receipt.marker, marker); assert.deepEqual(receipt.advertisedTools, ['file_read']);
    assert.equal(receipt.personaVerified, true); assert.equal(receipt.memoryVerified, true);
    assert.ok(receipt.diskEvidence.includes(evidence.trim()));
    return { marker, toolCallId: reads[0].id, success: reads[0].result.success, receipt };
  }
  async function recovery(name) {
    try {
      if (await visible('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)')) await confirm(false);
      else if (await visible('dialog.iexa-app-dialog[open] .btn-primary')) await confirm(true);
      if (await visible('dialog.bots-dialog[open] .bots-form-actions button:not([type="submit"])')) await click('dialog.bots-dialog[open] .bots-form-actions button:not([type="submit"])');
      if (await visible('#stopBtn')) { await click('#stopBtn'); await h.until(async () => !(await visible('#stopBtn')), 'Bot recovery chat stopped', 25000); }
      const activeTeams = (await teams()).teams.filter(team => team.goal.includes(token) && ['planning', 'running', 'cancelling'].includes(team.status));
      if (activeTeams.length) {
        await readyBots();
        for (const team of activeTeams) {
          const cancel = teamCard(team.id) + ' > .bots-danger'; await shown(cancel); await click(cancel);
          await h.until(async () => (await teams()).teams.some(item => item.id === team.id && ['cancelled', 'failed', 'completed'].includes(item.status)), 'Owned team reaches real terminal state after cancellation', 30000);
        }
      }
    } catch (error) { (h.report.botRecoveryErrors ||= []).push({ after: name, error: error.message }); h.save(); }
  }
  async function check(name, fn) { await h.check('Bots / ' + name, fn); await recovery(name); }

  h.report.botsCoverage = {
    evidenceFile, evidenceSha256: createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex'),
    scope: 'Real UI-created Bots, file_read allowlist, actual JSON planner and sequential Bot sessions, disk tool results and standalone Bot chats.',
    boundaries: ['Team steps are independent Bot sessions, not SubAgentManager children.', 'Provider is a deterministic loopback fixture; no online model quality claim.', 'Team cancellation during a long runner, import/export/catalog and process restart remain uncovered.'],
  }; h.save();

  await check('create two local Bots with explicit identities memories and file_read permission', async () => {
    await projectSession(); await readyBots();
    assert.ok((await get('/api/bots/tools')).tools.some(tool => tool.name === 'file_read'));
    for (const role of ['A', 'B']) {
      const name = 'Component Bot ' + role + ' ' + token;
      await shown('.bots-header-actions .bots-primary'); await click('.bots-header-actions .bots-primary');
      await shown('#bots-editor-name'); await type('#bots-editor-name', name);
      await type('#bots-editor-description', 'COMPONENT_BOT_READER_' + role);
      await type('#bots-editor-persona', 'COMPONENT_BOT_PERSONA_' + role + ' 读取独立本地验收文件并报告真实结果。');
      await type('#bots-editor-memory', 'COMPONENT_BOT_MEMORY_' + role + ' ' + token);
      await h.selectSelector('#bots-editor-profileId', profileId);
      const permission = 'dialog.bots-dialog[open] input[name="allowedTools"][value="file_read"]';
      await shown(permission); await click(permission);
      await click('dialog.bots-dialog[open] button[type="submit"]');
      await gone('dialog.bots-dialog[open]');
      const bot = await h.until(async () => (await bots()).bots.find(item => item.name === name), 'UI-created Bot persisted');
      assert.equal(bot.profileId, profileId); assert.deepEqual(bot.allowedTools, ['file_read']);
      assert.ok(bot.persona.includes('COMPONENT_BOT_PERSONA_' + role)); assert.ok(bot.memory.includes('COMPONENT_BOT_MEMORY_' + role));
      ownedBots.push(bot); await readyBots();
      await shown('.bots-team-choices input[value=' + q(bot.id) + ']');
    }
    await h.screenshot('bots-created-two-readers');
    return { bots: ownedBots.map(bot => ({ id: bot.id, name: bot.name, profileId: bot.profileId, allowedTools: bot.allowedTools })), createdThroughUI: true };
  });

  await check('actual Bot package export import template preview and invalid file validation', async () => {
    await readyBots(); assert.equal(ownedBots.length, 2);
    const bot = ownedBots[0], card = await cardFor(bot);
    const buttonNamed = (parent, name) => read(`(()=>{const e=[...document.querySelectorAll(${q(parent + ' button')})].find(e=>e.textContent.trim()===${q(name)});if(!e)throw Error('Named Bot button absent');const css=n=>n.id?'#'+CSS.escape(n.id):n===document.body?'body':css(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return css(e)})()`);
    await click(await buttonNamed(card, '导出 Bot 包'));
    const filename = await h.until(() => fs.readdirSync(h.report.fixture.downloads).find(name=>name.endsWith('.iexa-bot.json')), 'Actual Bot JSON download');
    const file = path.join(h.report.fixture.downloads, filename), pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(pkg.format, 'iexa-bot'); assert.equal(pkg.version, 1);
    assert.equal(pkg.bot.name, bot.name); assert.equal(pkg.bot.persona, bot.persona);
    assert.deepEqual(pkg.bot.allowedTools, ['file_read']); assert.equal(pkg.bot.memory, undefined);
    assert.equal(pkg.bot.profileId, undefined); assert.equal(pkg.bot.apiKey, undefined);
    const artifact = path.join(h.out, 'actual-export.iexa-bot.json'); fs.copyFileSync(file, artifact);
    await readyBots();
    const importButton = await buttonNamed('.bots-header-actions', '导入 JSON');
    const before = new Set((await bots()).bots.map(item=>item.id));
    await h.chooseNativePath(() => h.nativeClickSelector(importButton), file);
    const dialog = 'dialog.bots-dialog[open]'; await shown(dialog + ' .bots-package-preview');
    assert.ok((await text(dialog + ' .bots-package-preview')).includes(bot.persona));
    await click(dialog + ' .bots-form-actions .bots-primary');
    assert.ok((await text(dialog + ' .bots-form-error')).includes('请选择本机模型'));
    await h.selectSelector(dialog + ' select[name="importProfileId"]', profileId);
    await click(dialog + ' .bots-form-actions .bots-primary'); await gone(dialog);
    const imported = await h.until(async () => (await bots()).bots.find(item=>!before.has(item.id)), 'Imported Bot saved');
    assert.equal(imported.name, bot.name); assert.equal(imported.persona, bot.persona);
    assert.equal(imported.profileId, profileId); assert.deepEqual(imported.allowedTools, ['file_read']); assert.equal(imported.memory || '', '');
    // Delete only the newly imported fixture copy through its actual card.
    await readyBots();
    const importedCard = await read(`(()=>{const c=[...document.querySelectorAll('.bots-card')].filter(e=>e.querySelector('h3')?.textContent===${q(bot.name)});const e=c.find(e=>!e.textContent.includes('COMPONENT_BOT_MEMORY_A'));if(!e)throw Error('Imported card absent');const css=n=>n.id?'#'+CSS.escape(n.id):n===document.body?'body':css(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return css(e)})()`);
    await click(importedCard + ' .bots-card-actions .bots-danger'); await confirm(true);
    await h.until(async () => !(await bots()).bots.some(item=>item.id===imported.id), 'Imported fixture copy removed');
    await readyBots(); await click(await buttonNamed('.bots-header-actions', '内置模板'));
    await shown(dialog + ' .bots-catalog-item button'); await click(dialog + ' .bots-catalog-item button');
    await shown(dialog + ' .bots-package-preview');
    const template = await text(dialog + ' .bots-package-preview'); assert.ok(template.length > 15);
    await click(dialog + ' .bots-form-actions button:not(.bots-primary)'); await gone(dialog);
    assert.deepEqual(new Set((await bots()).bots.map(item=>item.id)), before, 'Template cancellation creates no Bot');
    const invalid = path.join(project, 'invalid-bot-package.json'); fs.writeFileSync(invalid, '{"format":"not-iexa"}');
    await readyBots(); await h.chooseNativePath(() => h.nativeClickSelector(importButton), invalid);
    await h.until(async () => (await text('#view-bots')).includes('导入失败'), 'Invalid Bot package shows real error');
    assert.deepEqual(new Set((await bots()).bots.map(item=>item.id)), before);
    return { artifact, exportedWithoutMemoryOrCredentials: true, importedBotId: imported.id, profileId, identicalPersona: true, modelRequiredValidation: true, templatePreview: template, templateCancelCreatesNothing: true, invalidFileRejected: true };
  });

  await check('team form rejects one selected Bot without creating a backend team', async () => {
    assert.equal(ownedBots.length, 2); await readyBots();
    const before = (await teams()).teams.map(team => team.id).sort();
    await selected([ownedBots[0].id]);
    await type('.bots-team-form textarea[name="teamGoal"]', 'COMPONENT_BOT_TEAM_VALIDATION ' + token + ' ' + fileMarker);
    await click('.bots-team-form button[type="submit"]');
    await h.until(async () => (await text('.bots-teams > .bots-status')).includes('请选择 2–4 位 Bot'), 'Actual form validation explains minimum team size');
    assert.deepEqual((await teams()).teams.map(team => team.id).sort(), before);
    return { selectedCount: 1, backendTeamCountUnchanged: true, validation: await text('.bots-teams > .bots-status') };
  });

  await check('real model-planned team executes both disk reads and hands prior result to second Bot', async () => {
    const goal = 'COMPONENT_BOT_TEAM ' + token + ' ' + fileMarker;
    const started = await startTeam(goal);
    completedTeam = await h.until(async () => {
      const team = (await teams()).teams.find(item => item.id === started.id);
      if (team && ['failed', 'cancelled', 'interrupted'].includes(team.status)) throw Error('Actual team failed: ' + JSON.stringify(team));
      return team?.status === 'completed' && team;
    }, 'Both production Bot sessions completed', 60000);
    assert.deepEqual(completedTeam.botIds, ownedBots.map(bot => bot.id));
    assert.equal(completedTeam.tasks.length, 2); assert.equal(completedTeam.plan.tasks.length, 2);
    const details = [];
    for (const [index, task] of completedTeam.tasks.entries()) {
      assert.equal(task.status, 'completed'); assert.equal(task.botId, ownedBots[index].id); assert.ok(task.sessionId);
      ownedSessions.add(task.sessionId);
      const saved = await get('/api/sessions/' + encodeURIComponent(task.sessionId)); assertBotSession(saved, ownedBots[index]);
      const checked = assertRead(saved, 'COMPONENT_BOT_STEP_' + (index ? 'B' : 'A') + '_OK');
      assert.equal(checked.receipt.priorStepReceiptVerified, index === 1);
      if (index) assert.ok(saved.messages.find(message => message.role === 'user').content.includes('COMPONENT_BOT_STEP_A_OK'));
      assert.equal(task.result, saved.messages.findLast(message => message.role === 'assistant').content);
      details.push({ botId: task.botId, sessionId: task.sessionId, status: task.status, ...checked });
    }
    await h.until(async () => (await text(teamCard(completedTeam.id) + ' > .bots-team-state')).includes('已完成'), 'Actual team card shows backend terminal state', 16000);
    await shown(teamCard(completedTeam.id) + ' > details > summary'); await click(teamCard(completedTeam.id) + ' > details > summary');
    assert.ok((await text(teamCard(completedTeam.id) + ' > details')).includes('COMPONENT_BOT_STEP_A'));
    await h.screenshot('bots-team-completed');
    return { id: completedTeam.id, status: completedTeam.status, plan: completedTeam.plan, steps: details, sequentialHandoffVerified: true, mechanism: 'BotTeams sequential independent sessions' };
  });

  await check('each team step opens its real persisted Bot conversation through the card', async () => {
    assert.ok(completedTeam?.tasks?.length === 2, 'Actual completed team is available');
    const opened = [];
    for (const [index, task] of completedTeam.tasks.entries()) {
      await readyBots();
      const selector = teamCard(completedTeam.id) + ' > .bots-team-task:nth-of-type(' + (index + 1) + ') button';
      await shown(selector); await click(selector);
      await h.until(async () => await activeId() === task.sessionId && await visible('#chatInput'), 'Actual step conversation activated', 18000);
      await h.until(async () => (await text('#chatMessages')).includes('COMPONENT_BOT_STEP_' + (index ? 'B' : 'A') + '_OK'), 'Saved step answer rendered');
      const saved = await get('/api/sessions/' + encodeURIComponent(task.sessionId)); assertBotSession(saved, ownedBots[index]);
      opened.push({ sessionId: task.sessionId, botId: saved.session.botId });
    }
    await h.screenshot('bots-team-opened-step'); return { opened };
  });

  await check('Start chat binds each Bot identity memory model and permitted real file read', async () => {
    assert.equal(ownedBots.length, 2); const chats = [];
    for (const [index, bot] of ownedBots.entries()) {
      await projectSession(); await readyBots();
      const before = new Set((await sessions()).sessions.map(session => session.id));
      const card = await cardFor(bot); await shown(card + ' .bots-card-actions .bots-primary'); await click(card + ' .bots-card-actions .bots-primary');
      const id = await h.until(async () => { const current = await activeId(); return current && !before.has(current) && await visible('#chatInput') && current; }, 'Start chat creates and activates actual Bot session', 18000);
      ownedSessions.add(id); const role = index ? 'B' : 'A';
      assertBotSession(await get('/api/sessions/' + encodeURIComponent(id)), bot);
      await type('#chatInput', 'COMPONENT_BOT_SINGLE_' + role + ' ' + token + ' ' + fileMarker); await click('#sendBtn');
      await h.until(async () => (await text('#chatMessages')).includes('COMPONENT_BOT_SINGLE_' + role + '_OK') && !(await visible('#stopBtn')), 'Standalone Bot actually reads disk and finishes', 30000);
      const saved = await get('/api/sessions/' + encodeURIComponent(id)); assertBotSession(saved, bot);
      const checked = assertRead(saved, 'COMPONENT_BOT_SINGLE_' + role + '_OK');
      chats.push({ sessionId: id, botId: bot.id, ...checked });
    }
    await h.screenshot('bots-standalone-chat'); return { chats, isolatedPersonasAndMemories: true, advertisedToolsExactly: ['file_read'] };
  });

  await check('invalid model plan fails explicitly without creating worker steps', async () => {
    const goal = 'COMPONENT_BOT_TEAM_INVALID ' + token + ' ' + fileMarker;
    const before = new Set((await sessions()).sessions.map(session => session.id));
    const started = await startTeam(goal);
    const failed = await h.until(async () => {
      const team = (await teams()).teams.find(item => item.id === started.id);
      if (team && ['completed', 'cancelled'].includes(team.status)) throw Error('Invalid plan unexpectedly reached ' + team.status);
      return team?.status === 'failed' && team;
    }, 'Production planner validation rejects duplicate Bot ID', 30000);
    assert.equal(failed.tasks.length, 0); assert.match(failed.error, /未知或重复 Bot/);
    const created = (await sessions()).sessions.filter(session => !before.has(session.id));
    assert.equal(created.length, 1, 'Invalid plan creates only the planner session, no worker sessions');
    const planner = await get('/api/sessions/' + encodeURIComponent(created[0].id));
    assert.ok(planner.messages.find(message => message.role === 'user')?.content.startsWith('你是团队规划者。'));
    assert.equal(planner.messages.flatMap(message => message.toolCalls || []).length, 0, 'Planning runs with tools disabled');
    await h.until(async () => (await text(teamCard(failed.id))).includes('失败') && (await text(teamCard(failed.id))).includes('未知或重复 Bot'), 'Actual failed team and cause rendered', 16000);
    await h.screenshot('bots-invalid-plan-rejected');
    return { teamId: failed.id, status: failed.status, error: failed.error, tasks: failed.tasks, createdPlannerSession: created[0].id, workerSessionsCreated: 0 };
  });

  await check('remove owned fixture Bots retains completed execution histories', async () => {
    assert.equal(ownedBots.length, 2); assert.ok(ownedSessions.size > 0, 'Executed histories exist before deletion');
    await readyBots();
    const retained = [];
    for (const bot of ownedBots) {
      const card = await cardFor(bot); await shown(card + ' .bots-card-actions .bots-danger'); await click(card + ' .bots-card-actions .bots-danger'); await confirm(true);
      await h.until(async () => !(await bots()).bots.some(item => item.id === bot.id), 'Own Bot deleted through actual UI', 16000);
      await h.until(async () => !(await exists('.bots-team-choices input[value=' + q(bot.id) + ']')), 'Deleted Bot removed from team choices');
      await readyBots();
    }
    for (const id of ownedSessions) {
      const saved = await get('/api/sessions/' + encodeURIComponent(id));
      assert.ok(saved.messages.some(message => message.role === 'assistant' && /COMPONENT_BOT_(?:STEP|SINGLE)_[AB]_OK/.test(message.content)));
      retained.push({ sessionId: id, messages: saved.messages.length, botId: saved.session.botId });
    }
    assert.equal((await teams()).teams.find(team => team.id === completedTeam.id).status, 'completed');
    await projectSession();
    return { removedBots: ownedBots.map(bot => bot.id), retainedHistories: retained, retainedCompletedTeam: completedTeam.id };
  });

  const checks = h.report.checks.filter(check => check.name.startsWith('Bots / '));
  Object.assign(h.report.botsCoverage, { ownedBotIds: ownedBots.map(bot => bot.id), ownedSessionIds: [...ownedSessions], completedTeamId: completedTeam?.id || null, recordedChecks: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length });
  h.save(); return h.report.botsCoverage;
}

module.exports = { providerReply, runBots };
