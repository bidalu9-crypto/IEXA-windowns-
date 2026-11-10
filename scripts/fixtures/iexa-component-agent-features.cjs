'use strict';

// Deterministic model protocol fixture plus actual product UI scenarios.
// The fixture chooses tool calls. AgentRuntime, permissions, question broker,
// sub-agent manager, persistence and DesktopAgent perform all application work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.map(part => part.text || '').join('\n') : '';
}
function toolResult(message) {
  const raw = messageText(message);
  try { const parsed = JSON.parse(raw); return { raw, parsed, output: typeof parsed.output === 'string' ? parsed.output : raw }; }
  catch { return { raw, parsed: null, output: raw }; }
}
function providerReply(body, context = {}) {
  if (!body?.stream || !Array.isArray(body.tools) || !body.tools.length) return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user') { userIndex = index; break; }
  const prompt = userIndex >= 0 ? messageText(messages[userIndex]) : '';
  const tools = messages.slice(userIndex + 1).filter(message => message.role === 'tool');
  const names = new Set(body.tools.map(tool => tool.function?.name || tool.name));
  const done = content => ({ content, finishReason: 'stop' });
  const resultFor = id => tools.find(message => message.tool_call_id === id);
  const calls = (content, items) => {
    const missing = items.map(item => item.name).filter(name => !names.has(name));
    if (missing.length) return done('COMPONENT_FIXTURE_TOOL_UNAVAILABLE: ' + missing.join(', '));
    return { content, toolCalls: items.map(item => ({ id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })), finishReason: 'tool_calls' };
  };
  const call = (id, name, args) => calls('执行独立本地组件夹具。', [{ id, name, args }]);
  const system = messages.filter(message => message.role === 'system').map(messageText).join('\n');
  const child = /You are sub-agent/.test(system);
  if (child && /COMPONENT_AGENT_CHILD/.test(prompt)) {
    if (!resultFor('component-child-read')) return call('component-child-read', 'file_read', { tool_title: '读取子代理独立验收文件', path: 'component-agent-note.txt' });
    const result = toolResult(resultFor('component-child-read'));
    return done(result.output.includes('COMPONENT_AGENT_DISK_EVIDENCE')
      ? 'COMPONENT_CHILD_READ_OK：' + result.output.slice(0, 1000)
      : 'COMPONENT_CHILD_READ_FAILED：' + result.raw.slice(0, 1000));
  }
  if (/COMPONENT_AGENTS_SPAWN/.test(prompt)) {
    const spawns = ['component-spawn-a', 'component-spawn-b'];
    if (!spawns.some(resultFor)) return calls('分别委派两个真实子代理读取测试文件。', spawns.map((id, index) => ({ id, name: 'spawn_agent', args: { message: 'COMPONENT_AGENT_CHILD 读取 component-agent-note.txt 并返回真实文件内容。', nickname: 'Component Reader ' + (index ? 'B' : 'A') } })));
    const waiting = [];
    for (let index = 0; index < spawns.length; index++) {
      const result = resultFor(spawns[index]);
      if (!result) return done('COMPONENT_AGENTS_SPAWN_FAILED: missing spawn result');
      const parsed = toolResult(result);
      let record = parsed.parsed;
      if (!record?.id) { try { record = JSON.parse(parsed.output); } catch {} }
      if (!record?.id) return done('COMPONENT_AGENTS_SPAWN_FAILED: ' + parsed.raw.slice(0, 1000));
      const waitId = 'component-wait-' + index;
      if (!resultFor(waitId)) waiting.push({ id: waitId, name: 'wait_agent', args: { ids: [record.id], timeout_ms: 30000 } });
    }
    if (waiting.length) return calls('等待两个真实子代理完成。', waiting);
    const results = tools.filter(message => String(message.tool_call_id).startsWith('component-wait-')).map(toolResult);
    return done(results.length === 2 && results.every(result => /COMPONENT_CHILD_READ_OK/.test(result.raw))
      ? 'COMPONENT_AGENTS_OK：两个子代理均读取了独立磁盘文件。'
      : 'COMPONENT_AGENTS_WAIT_RESULT: ' + results.map(result => result.raw.slice(0, 1500)).join('\n'));
  }
  if (/COMPONENT_ASK_CHOICE/.test(prompt)) {
    const id = 'component-question-choice';
    if (!resultFor(id)) return call(id, 'ask_user', {
      tool_title: '组件交互提问卡', title: 'COMPONENT_QUESTION_CARD', questions: [
        { id: 'choice', header: '选择', question: '请选择本地验收结果。', options: [{ label: 'COMPONENT_CHOICE_A', description: '选择后继续输入回执。' }, { label: 'COMPONENT_CHOICE_B', description: '备用测试选项。' }], allow_free_text: false },
        { id: 'receipt', header: '回执', question: '请输入组件文本回执。', allow_free_text: true, placeholder: 'COMPONENT_ANSWER_TEXT' },
      ],
    });
    const result = toolResult(resultFor(id));
    return done(result.raw.includes('COMPONENT_CHOICE_A') && result.raw.includes('COMPONENT_ANSWER_TEXT')
      ? 'COMPONENT_QUESTION_ANSWER_OK：' + result.output.slice(0, 1200)
      : 'COMPONENT_QUESTION_ANSWER_FAILED：' + result.raw.slice(0, 1200));
  }
  if (/COMPONENT_ASK_CANCEL/.test(prompt)) {
    const id = 'component-question-cancel';
    if (!resultFor(id)) return call(id, 'ask_user', { tool_title: '取消交互提问验收', title: 'COMPONENT_QUESTION_CANCEL', confirm: '这是独立测试提问，请通过关闭按钮取消。' });
    const result = toolResult(resultFor(id));
    return done(/cancel|取消|结束|closed|未回答/i.test(result.raw) ? 'COMPONENT_QUESTION_CANCEL_OK：' + result.output.slice(0, 800) : 'COMPONENT_QUESTION_CANCEL_FAILED：' + result.raw.slice(0, 800));
  }
  if (/COMPONENT_PERMISSION_(ALLOW|DENY)/.test(prompt)) {
    const allow = /COMPONENT_PERMISSION_ALLOW/.test(prompt);
    const id = allow ? 'component-permission-allow' : 'component-permission-deny';
    const name = allow ? 'component-permission-allowed.txt' : 'component-permission-denied.txt';
    if (!resultFor(id)) return call(id, 'file_write', { tool_title: allow ? '允许测试文件写入' : '拒绝测试文件写入', path: name, content: allow ? 'COMPONENT_PERMISSION_ALLOWED_RECEIPT\n' : 'COMPONENT_PERMISSION_DENIED_UNEXPECTED\n' });
    const result = toolResult(resultFor(id));
    const denied = /PERMISSION_DENIED|permission.{0,20}denied|拒绝|denied/i.test(result.raw);
    return done(allow ? (denied || result.parsed?.success === false ? 'COMPONENT_PERMISSION_ALLOW_FAILED：' : 'COMPONENT_PERMISSION_ALLOW_OK：') + result.output.slice(0, 1000)
      : (denied ? 'COMPONENT_PERMISSION_DENY_OK：' : 'COMPONENT_PERMISSION_DENY_FAILED：') + result.output.slice(0, 1000));
  }
  if (/COMPONENT_PLAN_GOAL/.test(prompt)) {
    if (!resultFor('component-plan')) return call('component-plan', 'todo_write', { todos: [
      { content: 'COMPONENT_PLAN_DONE 已读取测试需求', status: 'completed' },
      { content: 'COMPONENT_PLAN_ACTIVE 核查真实组件', status: 'in_progress' },
      { content: 'COMPONENT_PLAN_PENDING 保存验收报告', status: 'pending' },
    ] });
    if (!resultFor('component-goal')) return call('component-goal', 'goal', { tool_title: '记录组件验收目标', action: 'set', objective: 'COMPONENT_GOAL_OBJECTIVE 核实动态组件真实业务行为', done_when: '独立组件断言与磁盘回执一致' });
    return done('COMPONENT_PLAN_GOAL_OK：计划与持久目标已通过实际工具更新。');
  }
  if (/COMPONENT_QUEUE_HOLD/.test(prompt)) {
    if (!resultFor('component-queue-hold')) return call('component-queue-hold', 'shell_execute', { tool_title: '为真实队列验收保持短任务', command: 'node component-feature-hold.cjs', shell: 'cmd', timeout: 90 });
    return done('COMPONENT_QUEUE_HOLD_DONE');
  }
  if (/COMPONENT_QUEUED_MESSAGE/.test(prompt)) return done('COMPONENT_QUEUE_DRAIN_OK：' + prompt);
  return null;
}

async function runAgentFeatures(h) {
  const q = JSON.stringify, project = h.report.fixture.project;
  const fixtureRoot = path.resolve(h.report.fixture.root || h.fixture);
  const relative = path.relative(fixtureRoot, path.resolve(project));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Agent fixture project is owned');
  fs.writeFileSync(path.join(project, 'component-agent-note.txt'), 'COMPONENT_AGENT_DISK_EVIDENCE ' + h.report.runId + '\n');
  fs.writeFileSync(path.join(project, 'component-feature-hold.cjs'), "const fs=require('fs');fs.writeFileSync('component-hold-started.txt',String(process.pid));console.log('COMPONENT_QUEUE_SHELL_STARTED');setTimeout(()=>{console.log('COMPONENT_QUEUE_SHELL_FINISHED')},60000);\n");
  const visible = selector => h.read(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return !e.hidden&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const text = selector => h.read(`document.querySelector(${q(selector)})?.textContent || ''`);
  const show = selector => h.until(() => visible(selector), 'Visible ' + selector, 16000);
  const click = selector => h.clickSelector(selector), type = (selector, contents) => h.typeSelector(selector, contents);
  const sid = () => h.read("document.querySelector('.session-item.active')?.dataset.id || ''");
  const get = route => h.read(`fetch(${q(route)},{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('GET '+r.status);return r.json()})`);
  const waitText = (selector, marker, timeout = 25000) => h.until(async () => (await text(selector)).includes(marker), 'Actual text ' + marker, timeout);
  const settled = () => h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'Actual turn settled', 30000);
  async function mode(selected) {
    await h.nav('chat'); await click('#permissionModeBtn'); await click(`[data-permission-menu-mode="${selected}"]`);
    await h.until(async () => (await get('/api/permissions/mode')).mode === selected, 'Permission ' + selected);
  }
  async function fresh() {
    await h.nav('chat');
    if (await visible('.subagent-dialog[open] .subagent-dismiss')) await click('.subagent-dialog[open] .subagent-dismiss');
    await settled(); const previous = await sid(); await click('#newSessionBtn'); await show('#chatInput');
    await h.until(async () => { const current = await sid(); return current && current !== previous; }, 'New agent fixture session selected');
    const id = await sid(); assert.ok(id); return id;
  }
  async function send(prompt) { await type('#chatInput', prompt); await click('#sendBtn'); }
  async function cancelAwaitingQuestions() {
    const pending = '.question-card[data-state="awaiting"]';
    for (let count = 0; count < 8 && await visible(pending); count++) {
      await click(pending + ' .question-card-close');
      await show('dialog.iexa-app-dialog[open] .btn-primary');
      await click('dialog.iexa-app-dialog[open] .btn-primary');
      await h.until(async () => !(await visible('dialog.iexa-app-dialog[open]')), 'Question cancellation confirmation closed');
    }
    assert.equal(await visible(pending), false, 'Recovery resolves visible pending questions before Stop');
  }
  async function check(name, fn) {
    await h.check('Agent features / ' + name, fn);
    try {
      if (await visible('.subagent-dialog[open] .subagent-dismiss')) await click('.subagent-dialog[open] .subagent-dismiss');
      if (await visible('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)')) await click('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)');
      else if (await visible('dialog.iexa-app-dialog[open] .btn-primary')) await click('dialog.iexa-app-dialog[open] .btn-primary');
      await cancelAwaitingQuestions();
      if (await visible('.permission-dialog-overlay .permission-action-danger')) await click('.permission-dialog-overlay .permission-action-danger');
      if (await visible('#stopBtn')) { await click('#stopBtn'); await settled(); }
    } catch (error) { (h.report.agentFeatureRecoveryErrors ||= []).push({ after: name, error: error.message }); h.save(); }
  }
  let agentSession = '', childId = '';
  await check('real spawn, file read and wait persist two completed children', async () => {
    await mode('full'); agentSession = await fresh();
    await send('COMPONENT_AGENTS_SPAWN 通过两个独立子代理读取测试文件。');
    await waitText('#chatMessages', 'COMPONENT_AGENTS_OK', 45000); await settled();
    const agents = (await get('/api/subagents?sessionId=' + encodeURIComponent(agentSession))).agents;
    assert.equal(agents.length, 2); assert.ok(agents.every(agent => agent.status === 'completed'));
    const details = [];
    for (const agent of agents) {
      const detail = (await get(`/api/subagents/${encodeURIComponent(agent.id)}?sessionId=${encodeURIComponent(agentSession)}`)).agent;
      assert.ok(detail.messages.some(message => (message.toolCalls || []).some(call => call.name === 'file_read' && call.result?.success === true && call.result.output.includes('COMPONENT_AGENT_DISK_EVIDENCE'))));
      details.push({ id: agent.id, nickname: agent.nickname, status: agent.status, messages: detail.messages.length });
    }
    childId = agents[0].id;
    await h.screenshot('agent-features-two-children'); return { sessionId: agentSession, children: details };
  });
  await check('actual child detail, follow-up, close and resume retain real history', async () => {
    assert.ok(agentSession && childId, 'Real completed child from previous check');
    await h.nav('chat');
    const block = '#chatMessages .tool-block[data-tool-id="component-spawn-a"]';
    const message = await h.read(`(()=>{const e=document.querySelector(${q(block)})?.closest('.message');if(!e)throw Error('Persisted component-spawn-a tool block absent');const css=n=>n.id?'#'+CSS.escape(n.id):css(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return css(e)})()`);
    const turnSummary = message + ' .turn-summary[aria-expanded="false"]';
    if (await visible(turnSummary)) await click(turnSummary);
    const taskSummary = message + ' .task-summary[aria-expanded="false"]';
    if (await visible(taskSummary)) await click(taskSummary);
    const header = block + ' .tool-header'; await show(header);
    if (await h.read(`document.querySelector(${q(header)}).getAttribute('aria-expanded')==='false'`)) await click(header);
    const outputTab = block + ' [data-tool-tab="output"]'; await show(outputTab); await click(outputTab);
    await h.until(() => h.read(`document.querySelector(${q(block + ' [data-pane="output"]')})?.hidden===false`), 'Actual child result output pane selected');
    await show(block + ' .tool-agent-link'); await click(block + ' .tool-agent-link');
    await show('.subagent-dialog[open]');
    await waitText('.subagent-history', 'COMPONENT_CHILD_READ_OK');
    const selected = await h.read("document.querySelector('.subagent-dialog[open] .subagent-row[aria-pressed=\"true\"]')?.dataset.agentId || ''");
    assert.ok(selected, 'Opened real child is identified by its pressed row'); childId = selected;
    await click('.subagent-dialog[open] .subagent-continue');
    await type('.subagent-dialog[open] .subagent-input textarea', 'COMPONENT_AGENT_CHILD 再次读取文件作为补充任务。');
    await click('.subagent-dialog[open] .subagent-input button[type="submit"]');
    await h.until(async () => { const agent = (await get(`/api/subagents/${encodeURIComponent(childId)}?sessionId=${encodeURIComponent(agentSession)}`)).agent; return agent.status === 'completed' && agent.messages.length >= 4; }, 'Child follow-up completed', 30000);
    await click('.subagent-dialog[open] .subagent-close-agent');
    await h.until(async () => (await get(`/api/subagents/${encodeURIComponent(childId)}?sessionId=${encodeURIComponent(agentSession)}`)).agent.status === 'closed', 'Child closed');
    await show('.subagent-dialog[open] .subagent-resume-agent'); await click('.subagent-dialog[open] .subagent-resume-agent');
    await h.until(async () => (await get(`/api/subagents/${encodeURIComponent(childId)}?sessionId=${encodeURIComponent(agentSession)}`)).agent.status === 'idle', 'Child resumed idle');
    await click('.subagent-dialog[open] .subagent-dismiss');
    const detail = (await get(`/api/subagents/${encodeURIComponent(childId)}?sessionId=${encodeURIComponent(agentSession)}`)).agent;
    assert.ok(detail.messages.length >= 4); return { id: childId, status: detail.status, messages: detail.messages.length };
  });
  await check('multi-question card collects real option and free text answers', async () => {
    await mode('full'); const id = await fresh(); await send('COMPONENT_ASK_CHOICE 请显示真实提问卡。');
    const card = '.question-card[data-state="awaiting"]'; await show(card);
    assert.equal((await get('/api/questions?sessionId=' + encodeURIComponent(id))).questions.length, 1);
    await click(card + ' .question-option[data-value="COMPONENT_CHOICE_A"]');
    await click(card + ' .question-next'); await show(card + ' .question-free-input');
    await type(card + ' .question-free-input', 'COMPONENT_ANSWER_TEXT'); await click(card + ' .question-next');
    await waitText('#chatMessages', 'COMPONENT_QUESTION_ANSWER_OK'); await settled();
    assert.equal((await get('/api/questions?sessionId=' + encodeURIComponent(id))).questions.length, 0);
    const saved = await get('/api/sessions/' + encodeURIComponent(id));
    const answer = (saved.messages || []).flatMap(message => message.toolCalls || []).find(call => call.name === 'ask_user');
    assert.ok(answer?.result?.output.includes('COMPONENT_CHOICE_A')); assert.ok(answer.result.output.includes('COMPONENT_ANSWER_TEXT'));
    await h.screenshot('agent-features-question-answered'); return { sessionId: id, output: answer.result.output };
  });
  await check('question close confirmation cancels actual pending broker request', async () => {
    await mode('full'); const id = await fresh(); await send('COMPONENT_ASK_CANCEL 请显示待取消的提问卡。');
    await show('.question-card[data-state="awaiting"]');
    assert.equal((await get('/api/questions?sessionId=' + encodeURIComponent(id))).questions.length, 1);
    await click('.question-card[data-state="awaiting"] .question-card-close');
    await show('dialog.iexa-app-dialog[open]'); await click('dialog.iexa-app-dialog[open] .btn-primary');
    await waitText('#chatMessages', 'COMPONENT_QUESTION_CANCEL_OK'); await settled();
    assert.equal(await visible('.question-card[data-state="awaiting"]'), false);
    assert.equal((await get('/api/questions?sessionId=' + encodeURIComponent(id))).questions.length, 0);
    return { sessionId: id, cardText: await text('.question-card') };
  });
  await check('permission Allow once executes exact file write after user action', async () => {
    await mode('ask'); const id = await fresh();
    const filename = path.join(project, 'component-permission-allowed.txt'); if (fs.existsSync(filename)) fs.unlinkSync(filename);
    await send('COMPONENT_PERMISSION_ALLOW 写入独立的允许测试回执。');
    await show('.permission-dialog-overlay'); assert.equal(fs.existsSync(filename), false);
    const pending = await get('/api/permissions?sessionId=' + encodeURIComponent(id)); assert.ok(pending.permissions.length > 0);
    await click('.permission-dialog-overlay .permission-action-secondary');
    await waitText('#chatMessages', 'COMPONENT_PERMISSION_ALLOW_OK'); await settled();
    assert.equal(fs.readFileSync(filename, 'utf8'), 'COMPONENT_PERMISSION_ALLOWED_RECEIPT\n');
    assert.equal((await get('/api/permissions?sessionId=' + encodeURIComponent(id))).permissions.length, 0);
    return { sessionId: id, receipt: filename, contents: fs.readFileSync(filename, 'utf8') };
  });
  await check('permission Deny leaves disk unchanged and records denied tool', async () => {
    await mode('ask'); const id = await fresh();
    const filename = path.join(project, 'component-permission-denied.txt'); if (fs.existsSync(filename)) fs.unlinkSync(filename);
    await send('COMPONENT_PERMISSION_DENY 拒绝写入独立测试文件。'); await show('.permission-dialog-overlay');
    assert.equal(fs.existsSync(filename), false); await click('.permission-dialog-overlay .permission-action-danger');
    await waitText('#chatMessages', 'COMPONENT_PERMISSION_DENY_OK'); await settled(); assert.equal(fs.existsSync(filename), false);
    const saved = await get('/api/sessions/' + encodeURIComponent(id));
    const denied = (saved.messages || []).flatMap(message => message.toolCalls || []).find(call => call.name === 'file_write');
    assert.equal(denied?.result?.success, false); assert.equal(denied.result.executionStatus, 'denied');
    return { sessionId: id, fileExists: false, result: denied.result };
  });
  await check('todo plan expands, dismisses and durable goal clears via actual banner', async () => {
    await mode('full'); const id = await fresh(); await send('COMPONENT_PLAN_GOAL 请建立组件验收计划和目标。');
    await waitText('#chatMessages', 'COMPONENT_PLAN_GOAL_OK'); await settled(); await show('#planDock');
    await click('#planDock .dock-toggle'); await show('#planDock .dock-list');
    const plan = await text('#planDock');
    for (const marker of ['COMPONENT_PLAN_DONE', 'COMPONENT_PLAN_ACTIVE', 'COMPONENT_PLAN_PENDING']) assert.ok(plan.includes(marker));
    await show('#goalBar'); await waitText('#goalBarText', 'COMPONENT_GOAL_OBJECTIVE');
    const goal = (await get('/api/goal?sessionId=' + encodeURIComponent(id))).goal; assert.ok(goal.objective.includes('COMPONENT_GOAL_OBJECTIVE'));
    await click('#planDock .dock-dismiss'); await h.until(async () => !(await visible('#planDock')), 'Plan dismissed');
    await click('#goalBarClear'); await h.until(async () => !(await visible('#goalBar')), 'Goal banner cleared');
    assert.equal((await get('/api/goal?sessionId=' + encodeURIComponent(id))).goal, null);
    return { sessionId: id, plan, previousGoal: goal, goalCleared: true };
  });
  await check('busy prompt Queue edits and removes actual queued message before Stop', async () => {
    await mode('full'); await h.nav('settings');
    const previous = await h.read("document.getElementById('followUpModeSelect').value");
    try {
      await h.selectSelector('#followUpModeSelect', 'queue'); await h.nav('chat'); const id = await fresh();
      const marker = path.join(project, 'component-hold-started.txt'); if (fs.existsSync(marker)) fs.unlinkSync(marker);
      await send('COMPONENT_QUEUE_HOLD 为队列操作保持实际短任务。');
      await h.until(() => fs.existsSync(marker), 'Real shell fixture started', 20000);
      const queued = 'COMPONENT_QUEUED_MESSAGE 编辑和移除验收';
      await type('#chatInput', queued); await h.keySelector('#chatInput', 'ENTER'); await show('#queueDock .dock-queue-chip');
      await waitText('#queueDock', 'COMPONENT_QUEUED_MESSAGE');
      await click('#queueDock .dock-queue-chip button:nth-of-type(1)');
      await h.until(() => h.read(`document.getElementById('chatInput').value===${q(queued)}`), 'Queue edit restores exact composer draft');
      assert.equal(await visible('#queueDock .dock-queue-chip'), false);
      await h.keySelector('#chatInput', 'ENTER'); await show('#queueDock .dock-queue-chip');
      await click('#queueDock .dock-queue-chip button:nth-of-type(2)');
      await h.until(async () => !(await visible('#queueDock')), 'Queue removed');
      await click('#stopBtn'); await settled();
      const saved = await get('/api/sessions/' + encodeURIComponent(id));
      assert.ok(!(saved.messages || []).some(message => message.role === 'user' && message.content?.includes('COMPONENT_QUEUED_MESSAGE')));
      assert.ok(!(saved.messages || []).some(message => message.role === 'assistant' && message.content?.includes('COMPONENT_QUEUE_DRAIN_OK')));
      return { sessionId: id, shellPidReceipt: fs.readFileSync(marker, 'utf8'), queuedRemoved: true, modeRestored: previous };
    } finally {
      await h.nav('chat');
      if (await visible('#stopBtn')) { await click('#stopBtn'); await settled(); }
      await h.nav('settings'); await h.selectSelector('#followUpModeSelect', previous); await h.nav('chat');
    }
  });
  await mode('full');
  return { checks: h.report.checks.filter(check => check.name.startsWith('Agent features / ')).length, childSession: agentSession, childId };
}

module.exports = { providerReply, runAgentFeatures };
