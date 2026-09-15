/* Active-only agent dock and independent conversation inspector. Markdown uses the shared sanitized renderer. */
(() => {
  'use strict';
  const labels = { idle: '待命', queued: '排队中', running: '运行中', awaiting_approval: '等待批准', cancelling: '正在停止', completed: '已完成', failed: '失败', cancelled: '已停止', denied: '已拒绝', timed_out: '已超时', interrupted: '已中断', closed: '已关闭' };
  const active = new Set(['queued', 'running', 'awaiting_approval', 'cancelling']);
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text !== undefined) n.textContent = text; return n; };
  let viewSequence = 0;
  function create(host, options) {
    let sessionId = '', epoch = 0, selected = '', detailRevision = -1, detailRequest = 0, refreshRequest = 0, timer, pendingRefresh, detailPending = false;
    const records = new Map(), rows = new Map(), permissionsShown = new Set();
    let composing = false, invoker = null;
    const viewId = `subagent-inspector-${++viewSequence}`;
    host.classList.add('subagent-panel'); host.hidden = true;
    const toggle = node('button', 'subagent-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
    const heading = node('span', 'subagent-heading', '子代理'), count = node('span', 'subagent-count');
    const chevron = node('span', 'subagent-chevron', '›'); chevron.setAttribute('aria-hidden', 'true'); toggle.append(chevron, heading, count);
    const body = node('dialog', 'subagent-body subagent-dialog'); body.hidden = true; body.id = viewId; body.setAttribute('aria-labelledby', `${viewId}-title`); toggle.setAttribute('aria-controls', body.id); toggle.setAttribute('aria-haspopup', 'dialog');
    const list = node('div', 'subagent-list'); list.setAttribute('aria-label', '子代理列表');
    const detail = node('section', 'subagent-detail'); detail.hidden = true;
    const title = node('h3', 'subagent-detail-title'), meta = node('p', 'subagent-meta'), history = node('div', 'subagent-history');
    title.id = `${viewId}-title`;
    const head = node('header', 'subagent-dialog-header'), identity = node('div', 'subagent-identity');
    const dismissButton = node('button', 'subagent-dismiss', '×'); dismissButton.type = 'button'; dismissButton.setAttribute('aria-label', '关闭代理详情');
    identity.append(title, meta); head.append(identity, dismissButton);
    const info = node('details', 'subagent-info'), infoText = node('p'); info.append(node('summary', '', '任务信息'), infoText);
    const continueButton = node('button', 'subagent-continue', '继续任务'); continueButton.type = 'button';
    const actions = node('div', 'subagent-actions'), close = node('button', 'subagent-close-agent', '关闭代理'), resume = node('button', 'subagent-resume-agent', '恢复代理'); close.type = resume.type = 'button';
    const form = node('form', 'subagent-input'), input = node('textarea'); input.rows = 2; input.maxLength = 64000; input.placeholder = '给这个子代理补充任务…'; input.setAttribute('aria-label', '子代理补充任务');
    const interruptLabel = node('label', 'subagent-interrupt'), interrupt = node('input'); interrupt.type = 'checkbox'; interruptLabel.append(interrupt, document.createTextNode('中断当前任务'));
    const send = node('button', '', '发送'); send.type = 'submit';
    const feedback = node('p', 'subagent-feedback'); feedback.setAttribute('role', 'status');
    actions.append(continueButton, close, resume); form.append(input, interruptLabel, send); detail.append(history, info, actions, form); body.append(head, list, detail, feedback); host.append(toggle); document.body.append(body);
    const url = (suffix = '') => `${options.base || ''}/api/subagents${suffix}?sessionId=${encodeURIComponent(sessionId)}`;
    async function request(path, init) { const response = await options.fetch(path, init); const data = await response.json(); if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`); return data; }
    function render() {
      const running = [...records.values()].filter(r => active.has(r.status)).length;
      host.hidden = running === 0;
      count.textContent = `${running} 个进行中`; toggle.dataset.active = String(running > 0);
      for (const record of records.values()) {
        let row = rows.get(record.id);
        if (!row) {
          row = node('button', 'subagent-row'); row.type = 'button'; row.dataset.agentId = record.id;
          row.append(node('span', 'subagent-dot'), node('span', 'subagent-name'), node('span', 'subagent-status'));
          row.addEventListener('click', () => void api.open(record.id));
          rows.set(record.id, row); list.appendChild(row);
        }
        row.dataset.status = record.status; row.style.setProperty('--agent-depth', String(Math.max(0, Math.min(3, record.depth - 1))));
        row.setAttribute('aria-pressed', String(selected === record.id)); row.querySelector('.subagent-name').textContent = record.nickname;
        row.querySelector('.subagent-status').textContent = labels[record.status] || record.status;
        row.title = record.prompt;
      }
      list.hidden = records.size < 2;
      const record = records.get(selected); detail.hidden = !record;
      if (record) {
        title.textContent = record.nickname; meta.textContent = `${labels[record.status] || record.status} · ${record.model}${record.pendingCount ? ` · ${record.pendingCount} 条待处理` : ''}`;
        infoText.textContent = `${record.prompt || ''}\n共享项目目录（非 worktree）${record.workspaceDir ? '\n' + record.workspaceDir : ''}`;
        close.hidden = record.status === 'closed'; resume.hidden = !['closed', 'interrupted'].includes(record.status);
        input.disabled = send.disabled = ['closed', 'interrupted', 'cancelling'].includes(record.status);
        form.hidden = input.disabled || (!composing && !active.has(record.status) && record.status !== 'idle');
        continueButton.hidden = !form.hidden || ['closed', 'interrupted', 'cancelling'].includes(record.status);
        interruptLabel.hidden = !active.has(record.status);
        close.disabled = record.status === 'cancelling';
      }
    }
    function upsert(record) {
      if (!record || record.rootSessionId !== sessionId) return;
      const old = records.get(record.id); if (old && old.revision > record.revision) return;
      records.set(record.id, record); render();
      if (selected === record.id && !body.hidden) scheduleRefresh();
    }
    function markdown(text, user = false) {
      const element = node('div', 'subagent-text message-content');
      if (user) element.textContent = text;
      else if (options.renderMarkdown) options.renderMarkdown(element, text);
      else if (window.SafeMarkdown) element.innerHTML = window.SafeMarkdown.renderSafeMarkdown(text);
      else element.textContent = text;
      return element;
    }
    function thought(text, item = {}, live = false) {
      const block = node('details', `subagent-thought thinking-block${live ? '' : ' is-complete'}`);
      const summary = node('summary'), label = node('span', 'thinking-title', '思考');
      summary.append(label, node('span', 'thinking-chevron'));
      const content = markdown(text); content.classList.add('thinking-content');
      block.append(summary, content); window.IexaChatActivity?.prepareThinking(block);
      if (Number.isFinite(item.durationMs) && item.durationMs >= 0) {
        const elapsed = block.querySelector('.thinking-elapsed');
        if (elapsed) elapsed.textContent = item.durationMs < 1000 ? '· 不到 1 秒' : `· 持续了 ${Math.round(item.durationMs / 1000)} 秒`;
      }
      return block;
    }
    function tool(call, record) {
      const block = node('div', 'subagent-tool tool-block'); block.dataset.toolId = call.id;
      const header = node('div', 'tool-header'), heading = node('span', 'tool-heading');
      heading.append(node('span', 'tool-name', call.name), node('span', 'tool-meta'));
      const recordedStatus = call.result?.executionStatus || call.executionStatus;
      const status = call.result ? recordedStatus || (call.result.success ? 'completed' : 'failed')
        : !active.has(record.status) ? 'interrupted' : recordedStatus || 'queued';
      block.dataset.executionStatus = status;
      header.append(heading, node('span', 'tool-status', labels[status]), node('span', 'tool-chevron'));
      const content = node('div', 'tool-body'), args = node('pre', 'tool-args', JSON.stringify(call.args || {}, null, 2)), output = node('pre', 'tool-result', call.result?.output || '');
      output._fullText = call.result?.output || ''; content.append(args, output); block.append(header, content);
      window.IexaChatActivity?.updateTool(block, call.name, call.args || {}, call.result || (status === 'interrupted' ? { success: false } : undefined));
      return block;
    }
    function renderHistory(record) {
      const scroll = history.scrollTop, follow = history.scrollHeight - scroll - history.clientHeight < 40;
      const expanded = new Set([...history.querySelectorAll('details[open], .subagent-tool.is-expanded')].map(d => d.dataset.key));
      const focus = document.activeElement, focusKey = focus?.closest('[data-key]')?.dataset.key;
      const fragment = document.createDocumentFragment();
      record.messages.forEach((message, index) => {
        const user = message.role === 'user';
        const article = node('article', `subagent-message ${user ? 'is-user' : 'is-assistant'}`);
        const items = window.IexaTranscriptView?.validate(message); article.dataset.transcriptState = items ? 'ordered' : 'legacy';
        const liveThinking = index === record.messages.length - 1 && record.status === 'running' && message.transcript?.status === 'running' && items?.at(-1)?.type === 'thinking';
        const append = (child, key) => { child.dataset.key = `${index}:${key}`; article.append(child); };
        if (items) for (const item of items) {
          const child = item.type === 'text' ? markdown(message.content.slice(item.start, item.end), user)
            : item.type === 'thinking' ? thought(message.thinking.slice(item.start, item.end), item, liveThinking && item === items.at(-1))
            : tool(message.toolCalls.find(c => c.id === item.callId), record);
          append(child, item.id);
        } else {
          if (message.thinking) append(thought(message.thinking), 'thinking');
          if (message.content) append(markdown(message.content, user), 'text');
          for (const call of message.toolCalls || []) append(tool(call, record), `tool:${call.id}`);
        }
        fragment.append(article);
      });
      if (record.error) fragment.append(node('p', 'subagent-error', record.error));
      if (!fragment.childNodes.length) fragment.append(node('p', 'subagent-empty', active.has(record.status) ? '正在等待代理输出…' : '暂无消息记录'));
      history.replaceChildren(fragment);
      for (const child of history.querySelectorAll('[data-key]')) {
        if (expanded.has(child.dataset.key)) {
          if (child.tagName === 'DETAILS') child.open = true;
          else if (child.matches('.subagent-tool')) child.querySelector('.tool-header')?.click();
        }
        if (focusKey && child.dataset.key === focusKey) child.querySelector(focus?.tagName === 'SUMMARY' ? 'summary' : '.tool-header')?.focus({ preventScroll: true });
      }
      history.scrollTop = follow ? history.scrollHeight : scroll;
    }
    function dismiss(restoreFocus = true) {
      if (body.open && typeof body.close === 'function') body.close(); else body.removeAttribute('open');
      body.hidden = true; toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        const target = invoker?.isConnected && !invoker.closest('[hidden]') ? invoker : document.getElementById('chatInput');
        target?.focus({ preventScroll: true });
      }
    }
    function showDetails() {
      if (!body.open) {
        invoker = document.activeElement; body.hidden = false;
        if (typeof body.showModal === 'function') body.showModal(); else body.setAttribute('open', '');
      }
      toggle.setAttribute('aria-expanded', 'true'); dismissButton.focus({ preventScroll: true });
    }
    dismissButton.addEventListener('click', () => dismiss());
    body.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    body.addEventListener('close', () => { if (!body.open) { body.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } });
    body.addEventListener('click', event => { if (event.target !== body) return; const rect = body.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss(); });
    async function loadDetail() {
      if (!selected || body.hidden || detailPending) return;
      const record = records.get(selected); if (record && record.revision === detailRevision) return;
      const token = ++detailRequest, view = epoch, id = selected; detailPending = true;
      try {
        const data = await request(url('/' + encodeURIComponent(id)));
        if (view !== epoch || selected !== id || token !== detailRequest) return;
        if (data.agent.revision < (records.get(id)?.revision ?? 0)) return;
        detailRevision = data.agent.revision; renderHistory(data.agent);
      } catch (error) { if (view === epoch && selected === id) feedback.textContent = error.message; }
      finally { if (token === detailRequest) detailPending = false; }
    }
    async function refresh() {
      if (!sessionId) return;
      const view = epoch, token = ++refreshRequest;
      try {
        const data = await request(url()); if (view !== epoch || token !== refreshRequest) return;
        for (const record of data.agents) upsert(record);
        render(); await loadDetail();
        if ((permissionsShown.size || data.agents.some(r => r.status === 'awaiting_approval')) && options.onPermission) {
          const permissions = await request(`${options.base || ''}/api/permissions?sessionId=${encodeURIComponent(sessionId)}`);
          if (view === epoch) {
            const current = new Set((permissions.permissions || []).map(permission => permission.id));
            for (const id of permissionsShown) if (!current.has(id)) { options.onPermissionClose?.(id); permissionsShown.delete(id); }
            for (const permission of permissions.permissions || []) { if (!permissionsShown.has(permission.id) && body.open) dismiss(false); options.onPermission(permission); permissionsShown.add(permission.id); }
          }
        }
      } catch (error) { if (view === epoch) feedback.textContent = error.message; }
    }
    function scheduleRefresh() { if (!pendingRefresh) pendingRefresh = setTimeout(() => { pendingRefresh = undefined; void loadDetail(); }, 200); }
    async function action(name, payload) {
      if (!selected) return;
      const view = epoch, id = selected; feedback.textContent = ''; actions.inert = form.inert = true;
      try {
        await request(url(`/${encodeURIComponent(id)}/${name}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
        if (view !== epoch || selected !== id) return;
        if (name === 'send') { input.value = ''; interrupt.checked = false; }
        composing = name === 'resume' || name === 'send';
        detailRevision = -1; await refresh();
      } catch (error) { if (view === epoch && selected === id) feedback.textContent = error.message; }
      finally { if (view === epoch && selected === id) actions.inert = form.inert = false; }
    }
    toggle.addEventListener('click', () => { if (body.open) dismiss(); else { const id = [...records.values()].find(record => active.has(record.status))?.id; if (id) void api.open(id); } });
    continueButton.addEventListener('click', () => { composing = true; render(); input.focus(); });
    close.addEventListener('click', () => void action('close')); resume.addEventListener('click', () => void action('resume'));
    form.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) void action('send', { message: input.value.trim(), interrupt: interrupt.checked }); });
    const api = {
      session(id) {
        if (sessionId === id) return; dismiss(false); composing = false; actions.inert = form.inert = false; epoch++; sessionId = id || ''; selected = ''; detailRevision = -1; detailRequest++; detailPending = false;
        for (const id of permissionsShown) options.onPermissionClose?.(id); permissionsShown.clear();
        records.clear(); rows.clear(); list.replaceChildren(); history.replaceChildren(); input.value = ''; feedback.textContent = ''; interrupt.checked = false; render();
        clearInterval(timer); if (sessionId) { void refresh(); timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 2500); }
      },
      async open(id) {
        const view = epoch; if (!records.has(id)) await refresh();
        if (view !== epoch || !records.has(id)) return;
        if (selected !== id) { input.value = ''; interrupt.checked = false; composing = false; history.replaceChildren(); info.open = false; }
        selected = id; detailRevision = -1; detailRequest++; detailPending = false; actions.inert = form.inert = false;
        showDetails(); render(); await loadDetail();
      },
      dismiss: () => dismiss(false),
      event(payload) { if (payload?.sessionId === sessionId) upsert(payload.agent); }, refresh,
      dispose() { dismiss(false); body.remove(); epoch++; for (const id of permissionsShown) options.onPermissionClose?.(id); clearInterval(timer); clearTimeout(pendingRefresh); host.replaceChildren(); },
    };
    return api;
  }
  window.IexaSubAgentView = Object.freeze({ create });
})();
