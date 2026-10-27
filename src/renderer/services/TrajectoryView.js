/* Trajectory ledger: the second view beside the conversation.
 *
 * DeepSeek Harness builds this as a pure projection over the session window:
 * the ledger reads persisted turns/tool calls and never mutates the transcript.
 * The same rule applies here — records are derived from `messages[].transcript`
 * and `messages[].toolCalls`, and the inspector only reads them.
 */
(function () {
  'use strict';

  const WINDOW = 300;
  let view = 'conversation';
  let filter = 'all';
  let records = [];
  let shown = WINDOW;
  let selectedSeq = 0;
  let sessionId = '';
  let loadToken = 0;
  let ui = null;

  function t(key, fallback, params) {
    try {
      const value = window.IexaI18n ? window.IexaI18n.t(key, params) : key;
      return value === key ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function icon(name) {
    return typeof window.uiIcon === 'function' ? window.uiIcon(name) : '';
  }

  function short(text, max) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  }

  function clock(timestamp) {
    const value = Number(timestamp);
    if (!value) return '';
    const date = new Date(value);
    return String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0') + ':' +
      String(date.getSeconds()).padStart(2, '0');
  }

  function duration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1000) return Math.round(value) + 'ms';
    if (value < 60_000) return (value / 1000).toFixed(value < 10_000 ? 2 : 1) + 's';
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return minutes + 'm ' + seconds + 's';
  }

  function toolTitle(name) {
    if (typeof window.toolDisplayName === 'function') return window.toolDisplayName(name);
    return name;
  }

  function toolDetail(name, args) {
    if (typeof window.toolMeta === 'function') {
      try { return window.toolMeta(name, args || {}); } catch { /* fall through */ }
    }
    return '';
  }

  function failedResult(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.success === false) return true;
    return ['failed', 'denied', 'timed_out', 'cancelled', 'interrupted'].includes(result.executionStatus);
  }

  function toolRecord(call, timestamp, item) {
    const name = String(call && call.name || 'tool');
    const args = call && call.args || {};
    const result = call && call.result;
    return {
      kind: 'tool',
      at: Number(timestamp) || 0,
      callId: String(call && call.id || ''),
      title: toolTitle(name),
      detail: toolDetail(name, args),
      durationMs: Number(result && result.durationMs) || Number(item && item.durationMs) || 0,
      status: failedResult(result) ? 'error' : 'ok',
      icon: typeof window.toolIcon === 'function' ? window.toolIcon(name) : icon('box'),
      args,
      result,
      name,
    };
  }

  function build(messages) {
    const out = [];
    let seq = 0;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index] || {};
      const at = Number(message.timestamp) || 0;
      if (message.role === 'user') {
        out.push({
          kind: 'user', at, title: t('trajectory.you', 'You'),
          detail: short(message.content || t('trajectory.attachment', '[attachment]'), 140),
          icon: icon('user'), messageIndex: index,
        });
        continue;
      }
      if (message.role !== 'assistant') continue;

      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      const byId = new Map(calls.map((call) => [call.id, call]));
      const items = message.transcript && Array.isArray(message.transcript.items)
        ? message.transcript.items
        : [];

      if (items.length) {
        for (const item of items) {
          if (!item) continue;
          if (item.type === 'thinking') {
            out.push({
              kind: 'thinking', at: Number(item.timestamp) || at,
              title: t('trajectory.thinking', 'Thinking'),
              detail: short(String(message.thinking || '').slice(item.start || 0, item.end || 0), 140),
              durationMs: Number(item.durationMs) || 0,
              icon: icon('brain'), messageIndex: index,
            });
          } else if (item.type === 'tool') {
            const call = byId.get(item.id);
            if (call) out.push(Object.assign(toolRecord(call, Number(item.timestamp) || at, item), { messageIndex: index }));
          } else if (item.type === 'compaction') {
            out.push({
              kind: 'compaction', at: Number(item.timestamp) || at,
              title: t('trajectory.compaction', 'Context compacted'),
              detail: t('trajectory.compactionDetail', 'Earlier history folded into a summary'),
              icon: icon('compact'), messageIndex: index,
            });
          }
        }
      } else {
        if (message.thinking) {
          out.push({
            kind: 'thinking', at, title: t('trajectory.thinking', 'Thinking'),
            detail: short(message.thinking, 140), icon: icon('brain'), messageIndex: index,
          });
        }
        for (const call of calls) out.push(Object.assign(toolRecord(call, at, null), { messageIndex: index }));
      }

      if (String(message.content || '').trim()) {
        out.push({
          kind: 'assistant', at: at + (Number(message.durationMs) || 0),
          title: t('trajectory.answer', 'Reply'),
          detail: short(message.content, 140),
          durationMs: Number(message.durationMs) || 0,
          icon: icon('chat'), usage: message.usage, messageIndex: index,
        });
      }
    }
    out.forEach((record, index) => { record.seq = index + 1; });
    return out;
  }

  function ensure() {
    if (ui && ui.view.isConnected) return ui;
    const viewEl = document.getElementById('trajectoryView');
    if (!viewEl) return null;
    ui = {
      view: viewEl,
      list: document.getElementById('trajectoryList'),
      inspector: document.getElementById('trajectoryInspector'),
      count: document.getElementById('trajectoryCount'),
      tabs: [...document.querySelectorAll('[data-chat-view]')],
      filters: [...document.querySelectorAll('[data-trajectory-filter]')],
      messages: document.querySelector('.chat-messages-area'),
      refresh: document.getElementById('trajectoryRefresh'),
    };

    for (const tab of ui.tabs) {
      tab.addEventListener('click', () => setView(tab.dataset.chatView));
    }
    for (const button of ui.filters) {
      button.addEventListener('click', () => {
        filter = button.dataset.trajectoryFilter;
        for (const other of ui.filters) other.classList.toggle('is-active', other === button);
        render();
      });
    }
    ui.refresh.addEventListener('click', () => refresh(true));
    return ui;
  }

  function visibleRecords() {
    if (filter === 'all') return records;
    if (filter === 'error') return records.filter((record) => record.status === 'error' || record.kind === 'error');
    return records.filter((record) => record.kind === filter);
  }

  function render() {
    const el = ensure();
    if (!el) return;
    const list = visibleRecords();
    const start = Math.max(0, list.length - shown);
    el.count.textContent = list.length ? String(list.length) : '';
    el.list.replaceChildren();

    if (start > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'trajectory-load-more';
      more.textContent = t('trajectory.loadEarlier', 'Load earlier records');
      more.addEventListener('click', () => { shown += WINDOW; render(); });
      el.list.appendChild(more);
    }

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'trajectory-empty';
      empty.textContent = t('trajectory.empty', 'No records yet. Run a turn and the ledger fills in.');
      el.list.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = start; index < list.length; index += 1) {
      const record = list[index];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'trajectory-row' + (record.seq === selectedSeq ? ' is-selected' : '');
      row.dataset.kind = record.kind;
      row.dataset.status = record.status || '';
      row.dataset.seq = String(record.seq);
      if (record.callId) row.dataset.callId = record.callId;
      row.setAttribute('role', 'listitem');

      const seq = document.createElement('span');
      seq.className = 'trajectory-seq';
      seq.textContent = String(record.seq);

      const time = document.createElement('span');
      time.className = 'trajectory-time';
      time.textContent = clock(record.at);

      const glyph = document.createElement('span');
      glyph.className = 'trajectory-icon';
      glyph.innerHTML = record.icon || '';

      const main = document.createElement('span');
      main.className = 'trajectory-main';
      const title = document.createElement('span');
      title.className = 'trajectory-title';
      title.textContent = record.title;
      const detail = document.createElement('span');
      detail.className = 'trajectory-detail';
      detail.textContent = record.detail || '';
      main.append(title, detail);

      const took = document.createElement('span');
      took.className = 'trajectory-duration';
      took.textContent = duration(record.durationMs);

      row.append(seq, time, glyph, main, took);
      row.addEventListener('click', () => select(record.seq));
      fragment.appendChild(row);
    }
    el.list.appendChild(fragment);
  }

  function select(seq) {
    const el = ensure();
    if (!el) return;
    selectedSeq = seq;
    const record = records.find((item) => item.seq === seq);
    for (const row of el.list.querySelectorAll('.trajectory-row')) {
      row.classList.toggle('is-selected', row.dataset.seq === String(seq));
    }
    if (!record) return;
    el.inspector.hidden = false;
    el.inspector.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = record.title;
    el.inspector.appendChild(heading);

    const meta = document.createElement('div');
    meta.className = 'trajectory-inspector-meta';
    const addMeta = (label, value) => {
      if (!value) return;
      const key = document.createElement('span');
      key.textContent = label;
      const val = document.createElement('b');
      val.textContent = value;
      meta.append(key, val);
    };
    addMeta(t('trajectory.kind', 'Kind'), record.kind);
    addMeta(t('trajectory.time', 'Time'), clock(record.at));
    addMeta(t('trajectory.duration', 'Duration'), duration(record.durationMs));
    if (record.callId) addMeta(t('trajectory.callId', 'Call id'), record.callId);
    if (record.usage) addMeta(t('trajectory.usage', 'Tokens'), 'in ' + (record.usage.inputTokens || 0) + ' · out ' + (record.usage.outputTokens || 0));
    el.inspector.appendChild(meta);

    if (record.args && Object.keys(record.args).length) {
      const label = document.createElement('h4');
      label.textContent = t('trajectory.input', 'Input');
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(record.args, null, 2).slice(0, 20000);
      el.inspector.append(label, pre);
    }
    if (record.result) {
      const label = document.createElement('h4');
      label.textContent = t('trajectory.output', 'Output');
      const pre = document.createElement('pre');
      const raw = typeof record.result === 'string' ? record.result : JSON.stringify(record.result, null, 2);
      pre.textContent = String(raw || '').slice(0, 20000);
      el.inspector.append(label, pre);
    }
  }

  function setView(next) {
    const el = ensure();
    if (!el) return;
    view = next === 'trajectory' ? 'trajectory' : 'conversation';
    for (const tab of el.tabs) {
      const active = tab.dataset.chatView === view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    el.view.hidden = view !== 'trajectory';
    if (el.messages) el.messages.hidden = view === 'trajectory';
    if (view === 'trajectory') refresh(true);
  }

  function messagesFromRuntime() {
    if (typeof sessionRuntimes !== 'undefined' && sessionRuntimes && typeof sessionRuntimes.get === 'function') {
      const runtime = sessionRuntimes.get(sessionId);
      if (runtime && Array.isArray(runtime.historyMessages) && runtime.historyMessages.length) {
        return runtime.historyMessages;
      }
    }
    return null;
  }

  async function refresh(force) {
    const el = ensure();
    if (!el) return;
    const id = typeof currentSessionId === 'string' ? currentSessionId : '';
    if (!id) return;
    if (!force && view !== 'trajectory') return;
    sessionId = id;
    const token = ++loadToken;

    let messages = messagesFromRuntime();
    if (!messages) {
      try {
        const response = await fetch(`${typeof API_BASE === 'string' ? API_BASE : ''}/api/sessions/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        messages = Array.isArray(data.messages) ? data.messages : [];
      } catch {
        messages = [];
      }
    }
    if (token !== loadToken) return;
    records = build(messages || []);
    shown = WINDOW;
    render();
  }

  function focusCall(callId) {
    if (!callId) return;
    const run = () => {
      const target = records.find((record) => record.callId === callId);
      if (!target) return;
      const index = records.indexOf(target);
      if (index >= records.length - shown) shown = Math.max(WINDOW, records.length - index + 20);
      render();
      const row = [...document.querySelectorAll('.trajectory-row')]
        .find((candidate) => candidate.dataset.callId === callId);
      if (row) {
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
        select(target.seq);
      }
    };
    if (view !== 'trajectory') {
      setView('trajectory');
      window.setTimeout(run, 60);
    } else {
      run();
    }
  }

  function reset() {
    records = [];
    selectedSeq = 0;
    shown = WINDOW;
    if (ui) {
      ui.list.replaceChildren();
      ui.inspector.hidden = true;
    }
  }

  window.IexaTrajectory = { setView, refresh, focusCall, reset, getRecords: () => records };
})();
