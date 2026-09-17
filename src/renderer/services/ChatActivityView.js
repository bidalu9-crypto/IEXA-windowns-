/* Compact transcript activity. Presentation only: execution state comes from ToolLifecycleView. */
(() => {
  'use strict';
  let bodySequence = 0;
  const operations = { file_read: '读取', file_write: '写入', file_edit: '编辑', shell_execute: '运行', browser_fetch: '浏览', project_instructions: '读取指令', todo_write: '计划', memory_get: '检索记忆', memory_write: '记录记忆', display_file: '查看' };
  const make = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  function bindTool(block) {
    if (block.dataset.activityBound) return;
    const oldHeader = block.querySelector('.tool-header');
    const body = block.querySelector('.tool-body');
    if (!oldHeader || !body) return;
    const header = make('button', 'tool-header');
    header.type = 'button';
    while (oldHeader.firstChild) header.appendChild(oldHeader.firstChild);
    // Unique DOM IDs are separate from model tool-call IDs (which may recur in history).
    body.id = `activity-body-${++bodySequence}`;
    header.setAttribute('aria-controls', body.id);
    header.setAttribute('aria-expanded', 'false');
    body.style.display = 'none';
    header.addEventListener('click', () => {
      const open = header.getAttribute('aria-expanded') !== 'true';
      header.setAttribute('aria-expanded', String(open));
      body.style.display = open ? 'block' : 'none';
      block.classList.toggle('is-expanded', open);
    });
    oldHeader.replaceWith(header);
    header.insertBefore(make('span', 'activity-operation'), header.querySelector('.tool-heading'));
    const stats = make('span', 'activity-diff');
    header.insertBefore(stats, header.querySelector('.tool-status'));
    block.dataset.activityBound = 'true';
    block.classList.add('activity-row');
  }
  function refreshDetail(block) {
    const panel = block?.querySelector('.tool-detail-panel');
    if (!panel) return;
    const viewport = panel.querySelector('.tool-console-viewport');
    const output = panel.querySelector('.tool-result');
    const text = typeof output?._fullText === 'string' ? output._fullText : output?.textContent || '';
    const placeholder = panel.querySelector('.tool-output-placeholder');
    placeholder.hidden = text.length > 0;
    placeholder.textContent = block._activityHasResult ? '无文本输出' : '等待输出…';
    panel.querySelector('.tool-copy-result').disabled = text.length === 0;
    const overflow = viewport.scrollHeight > viewport.clientHeight + 2;
    viewport.dataset.overflow = String(overflow);
    viewport.dataset.atBottom = String(!overflow || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 3);
  }
  function prepareDetail(block, name, input) {
    const body = block.querySelector('.tool-body');
    let panel = body.querySelector('.tool-detail-panel');
    if (!panel) {
      panel = make('section', 'tool-detail-panel');
      const bar = make('div', 'tool-detail-bar');
      const title = make('span', 'tool-detail-title');
      const actions = make('div', 'tool-detail-actions');
      const params = make('button', 'tool-toggle-params', '参数'); params.type = 'button';
      const copy = make('button', 'tool-copy-result', '复制输出'); copy.type = 'button';
      const feedback = make('span', 'tool-detail-feedback'); feedback.setAttribute('role', 'status');
      const raw = make('div', 'tool-raw-input'); raw.hidden = true; raw.id = `${body.id}-params`;
      params.setAttribute('aria-controls', raw.id); params.setAttribute('aria-expanded', 'false');
      params.addEventListener('click', () => { raw.hidden = !raw.hidden; params.setAttribute('aria-expanded', String(!raw.hidden)); });
      const viewport = make('div', 'tool-console-viewport'); viewport.tabIndex = 0;
      const command = make('pre', 'tool-command');
      let output = body.querySelector('.tool-result');
      const outputPager = output?.nextElementSibling?.classList.contains('text-pager') ? output.nextElementSibling : null;
      if (!output) output = make('pre', 'tool-result');
      const args = body.querySelector('.tool-args');
      const argsPager = args?.nextElementSibling?.classList.contains('text-pager') ? args.nextElementSibling : null;
      if (args) raw.appendChild(args);
      if (argsPager) raw.appendChild(argsPager);
      const placeholder = make('span', 'tool-output-placeholder');
      viewport.append(command, output, placeholder);
      if (outputPager) viewport.appendChild(outputPager);
      viewport.addEventListener('scroll', () => refreshDetail(block), { passive: true });
      copy.addEventListener('click', async () => {
        const text = typeof output._fullText === 'string' ? output._fullText : output.textContent || '';
        copy.disabled = true;
        try {
          if (typeof window.writeClipboardText === 'function') await window.writeClipboardText(text);
          else await navigator.clipboard.writeText(text);
          feedback.textContent = '已复制';
        } catch { feedback.textContent = '复制未完成，请选择文本复制'; }
        finally { refreshDetail(block); }
      });
      actions.append(feedback, params, copy); bar.append(title, actions); panel.append(bar, viewport, raw); body.prepend(panel);
      // A shared observer avoids keeping a detached session DOM alive through one
      // observer closure per tool. Unobserve nodes after their block is detached.
      if (detailObserver) { detailObserver.observe(viewport); detailObserver.observe(output); }
      block.querySelector('.tool-header').addEventListener('click', () => {
        if (detailObserver) { detailObserver.observe(viewport); detailObserver.observe(output); }
        refreshDetail(block);
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => refreshDetail(block));
      });
    }
    const isShell = name === 'shell_execute' || name.startsWith('terminal_');
    const title = isShell ? 'Shell' : name.startsWith('file_') ? 'File' : name === 'browser_fetch' ? 'Web' : 'Tool';
    panel.querySelector('.tool-detail-title').textContent = title;
    panel.querySelector('.tool-console-viewport').setAttribute('aria-label', `${title} 命令与输出`);
    const command = panel.querySelector('.tool-command');
    const preview = isShell ? input.command : input.path || input.url;
    command.textContent = typeof preview === 'string' && preview ? `${isShell ? '$ ' : ''}${preview}` : '';
    command.hidden = !command.textContent;
    refreshDetail(block);
  }
  const detailObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (!target.isConnected) { detailObserver.unobserve(target); continue; }
      refreshDetail(target.closest('.tool-block'));
    }
  }) : null;
  if (detailObserver && typeof MutationObserver === 'function' && document.body) {
    // Session switches detach cached DOM. Release observer targets immediately;
    // clicking a remounted row registers it again.
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || node.isConnected) continue;
        if (node.matches('.tool-console-viewport, .tool-result')) detailObserver.unobserve(node);
        node.querySelectorAll('.tool-console-viewport, .tool-result').forEach(target => {
          if (!target.isConnected) detailObserver.unobserve(target);
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  const agentOperations = { spawn_agent: '创建子代理', send_input: '发送任务', wait_agent: '等待子代理', close_agent: '关闭子代理', resume_agent: '恢复子代理' };
  function updateTool(block, name, args, result) {
    if (!block) return;
    name = typeof name === 'string' && name ? name : block.dataset.toolName || 'tool';
    bindTool(block);
    if (!block.dataset.activityBound) return;
    if (args && typeof args === 'object' && !Array.isArray(args)) block._activityArgs = { ...args };
    const input = block._activityArgs || {};
    if (result !== undefined) block._activityHasResult = true;
    prepareDetail(block, name, input);
    const header = block.querySelector('.tool-header');
    if (Object.hasOwn(agentOperations, name)) {
      // Shared by live messages, restored history and the child inspector.
      let icon = header.querySelector('.tool-icon');
      if (!icon) { icon = make('span', 'tool-icon'); header.prepend(icon); }
      if (icon.querySelector('use')?.getAttribute('href') !== '#ui-robot') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'ui-icon'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#ui-robot');
        svg.appendChild(use); icon.replaceChildren(svg);
      }
    }
    header.querySelector('.activity-operation').textContent = agentOperations[name] || operations[name] || '调用';
    const title = header.querySelector('.tool-name'), meta = header.querySelector('.tool-meta');
    const file = typeof input.path === 'string' ? input.path : typeof result?.fileChange?.path === 'string' ? result.fileChange.path : '';
    if (file) {
      const normalized = file.replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      title.textContent = normalized.slice(slash + 1) || normalized;
      meta.textContent = slash >= 0 ? normalized.slice(0, slash + 1) : '';
      header.title = `${operations[name] || name} ${file} · 点击查看详情`;
      block.dataset.fileType = normalized.split('.').at(-1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    } else {
      const preview = name === 'shell_execute' ? input.command : name === 'browser_fetch' ? input.url : input.tool_title;
      title.textContent = typeof preview === 'string' && preview.trim() ? preview.trim().replace(/\s+/g, ' ') : name;
      meta.textContent = '';
      header.title = title.textContent;
      if (agentOperations[name]) {
        title.textContent = String(input.nickname || input.message || (Array.isArray(input.ids) ? `${input.ids.length} 个代理` : input.id || '')).replace(/\s+/g, ' ').slice(0, 100);
        header.title = `${agentOperations[name]} ${title.textContent}`;
      }
      if (name === 'shell_execute' || name.startsWith('terminal_')) {
        header.querySelector('.activity-operation').textContent = '';
        title.textContent = result?.success === true ? '已运行命令' : '运行命令';
      }
    }
    if (agentOperations[name] && result !== undefined) {
      const actions = block.querySelector('.tool-detail-actions');
      actions.querySelectorAll('.tool-agent-link').forEach(button => button.remove());
      if (result.success === true && typeof result.output === 'string') {
        try {
          const data = JSON.parse(result.output);
          const agents = Array.isArray(data.agents) ? data.agents : data.id ? [data] : [];
          for (const agent of agents.slice(0, 6)) {
            if (typeof agent.id !== 'string' || !agent.id) continue;
            const link = make('button', 'tool-toggle-params tool-agent-link', agent.nickname ? `查看 ${agent.nickname}` : '查看代理');
            link.type = 'button'; link.addEventListener('click', () => window.dispatchEvent(new CustomEvent('iexa:open-subagent', { detail: { id: agent.id } })));
            actions.prepend(link);
          }
        } catch { /* A truncated/legacy result stays readable without a guessed agent link. */ }
      }
    }
    window.IexaPluginCards?.updateTool(block, result);
    // Only show recorded change counts; pending/failed writes never get invented green numbers.
    if (result !== undefined) {
      const stats = header.querySelector('.activity-diff'); stats.replaceChildren(); stats.removeAttribute('aria-label');
      const change = result.success === true ? result.fileChange : null;
      if (change) {
        for (const [key, prefix, cls] of [['added', '+', 'diff-add'], ['removed', '−', 'diff-del']]) {
          if (Number.isSafeInteger(change[key]) && change[key] > 0) stats.appendChild(make('span', cls, `${prefix}${change[key]}`));
        }
        if (stats.textContent) stats.setAttribute('aria-label', `新增 ${change.added || 0} 行，删除 ${change.removed || 0} 行`);
      }
    }
  }
  function prepareThinking(block) {
    if (!block || block.dataset.activityBound) return;
    const summary = block.querySelector('summary');
    if (!summary) return;
    const metadata = make('div', 'thinking-details-meta');
    for (const selector of ['.thinking-effort', '.thinking-token-count']) {
      const el = summary.querySelector(selector); if (el) metadata.appendChild(el);
    }
    summary.after(metadata);
    const elapsed = make('span', 'thinking-elapsed');
    summary.insertBefore(elapsed, summary.querySelector('.thinking-chevron'));
    block.dataset.activityBound = 'true';
    block.open = false;
  }
  function finishThinking(block, now = Date.now()) {
    prepareThinking(block);
    const start = Number(block?.dataset.startedAt);
    if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(now)) return;
    const duration = Math.max(0, now - start) + Math.max(0, Number(block.dataset.priorDurationMs) || 0);
    block.dataset.durationMs = String(duration);
    const label = block.querySelector('.thinking-elapsed');
    label.textContent = duration < 1000 ? '· 不到 1 秒' : `· 持续了 ${Math.round(duration / 1000)} 秒`;
  }
  function createWaiting() {
    const indicator = make('div', 'waiting-indicator');
    indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite');
    indicator.appendChild(make('span', 'waiting-indicator__label', 'IEXA正在处理...'));
    return indicator;
  }
  window.IexaChatActivity = Object.freeze({ updateTool, prepareThinking, finishThinking, createWaiting, refreshDetail });
})();
