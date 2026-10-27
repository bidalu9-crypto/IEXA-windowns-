// =============================================================================
// 上下文洞察 — Token 构成、耗时分布、活跃度与会话用量
//
// Structure mirrors the DeepSeek Harness insight page: a dense three-band grid
// (metrics + trend, token + time, activity + sessions) with a balance chip in
// the header. Classic script; no build step and no chart library.
// =============================================================================
const insightsState = {
  range: '7d',
  data: null,
  loading: false,
  error: '',
  search: '',
  model: 'all',
  sort: 'recent',
  balance: null,
};

const TOKEN_COLORS = {
  system: '#4c8dff',
  tools: '#f2a33c',
  user: '#37b98a',
  injected: '#a97bff',
  assistant: '#22b8cf',
  toolResults: '#e05a5a',
  output: '#8b5cf6',
};

const TIME_COLORS = {
  wait: '#4c8dff',
  think: '#a97bff',
  output: '#e05a5a',
  tool: '#37b98a',
  toolArgs: '#f2a33c',
  other: '#9aa0aa',
};

function insightsEl(id) {
  return document.getElementById(id);
}

function formatInsightTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1e9) return (number / 1e9).toFixed(1) + 'B';
  if (number >= 1e6) return (number / 1e6).toFixed(1) + 'M';
  if (number >= 1e3) return (number / 1e3).toFixed(1) + 'K';
  return String(Math.round(number));
}

function formatInsightDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + 'm' + (total % 60 ? String(total % 60).padStart(2, '0') + 's' : '');
  return Math.floor(minutes / 60) + 'h' + (minutes % 60 ? String(minutes % 60).padStart(2, '0') + 'm' : '');
}

function formatInsightCost(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number === 0) return '¥0.00';
  if (number < 0.01) return '¥' + number.toFixed(4);
  return '¥' + number.toFixed(2);
}

/**
 * Account balance is not always money: pool gateways meter in credits and some
 * relays answer in dollars. Format by the currency the probe reported instead of
 * stamping every number with the cost symbol.
 */
function formatInsightBalance(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (currency === 'credits') {
    return (Math.abs(number) >= 1000 ? (number / 1000).toFixed(1) + 'k' : number.toLocaleString(IexaI18n.getLocale(), { maximumFractionDigits: 0 })) + IexaI18n.t('insights.creditsSuffix');
  }
  if (currency === 'USD') return '$' + number.toFixed(2);
  if (currency === 'CNY') return '¥' + number.toFixed(2);
  return number.toLocaleString(IexaI18n.getLocale(), { maximumFractionDigits: 2 });
}

function formatInsightPercent(ratio) {
  const value = Math.max(0, Number(ratio) || 0) * 100;
  if (value > 0 && value < 0.1) return '<0.1%';
  return value.toFixed(1) + '%';
}

function insightColor(part, palette) {
  return palette[part.key] || '#9aa0aa';
}

/** Conic ring with a hole; the hole keeps the centre label readable. */
function renderInsightDonut(parts, centerValue, centerLabel, palette) {
  const visible = parts.filter((part) => part.ratio > 0);
  let cursor = 0;
  const stops = visible.map((part) => {
    const from = cursor;
    cursor += part.ratio * 100;
    return `${insightColor(part, palette)} ${from.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  const background = stops.length
    ? `conic-gradient(from -90deg, ${stops.join(', ')})`
    : 'conic-gradient(from -90deg, var(--border) 0 100%)';
  return `<div class="insights-donut" style="background:${background}">
    <div class="insights-donut-hole">
      <strong>${centerValue}</strong>
      <span>${centerLabel}</span>
    </div>
  </div>`;
}

function renderInsightLegend(parts, palette, formatter) {
  return `<ul class="insights-legend">${parts.map((part) => `
    <li>
      <i style="background:${insightColor(part, palette)}"></i>
      <span class="insights-legend-label">${escapeHtml(part.label)}</span>
      <span class="insights-legend-pct">${formatInsightPercent(part.ratio)}</span>
      <small>${formatter(part)}</small>
    </li>`).join('')}</ul>`;
}

function renderInsightMetric(label, value, hint) {
  return `<div class="insights-metric">
    <span class="insights-metric-label">${escapeHtml(label)}</span>
    <strong>${value}</strong>
    ${hint ? `<small>${escapeHtml(hint)}</small>` : ''}
  </div>`;
}

function renderInsightMetrics(data) {
  const t = data.totals;
  const total = t.inputTokens + t.outputTokens;
  const cost = data.costIncomplete && t.costUsd !== null ? formatInsightCost(t.costUsd) + '+' : formatInsightCost(t.costUsd);
  return [
    renderInsightMetric(IexaI18n.t('insights.activeSessions'), String(t.sessions), IexaI18n.t('insights.sessionsTotal', { count: t.sessions })),
    renderInsightMetric(IexaI18n.t('insights.totalUsage'), formatInsightTokens(total), IexaI18n.t('insights.turnsCount', { count: t.turns })),
    renderInsightMetric(IexaI18n.t('insights.cost'), cost, t.costUsd === null ? IexaI18n.t('insights.costHint') : IexaI18n.t('insights.pricedSessions', { priced: t.pricedSessions, total: t.sessions })),
    renderInsightMetric(IexaI18n.t('insights.cacheHit'), formatInsightPercent(t.cacheHitRate), IexaI18n.t('insights.includesSessions', { count: t.sessions })),
    renderInsightMetric(IexaI18n.t('insights.toolCalls'), formatInsightTokens(t.toolCalls), IexaI18n.t('insights.toolExecutions', { duration: formatInsightDuration(t.toolMs) })),
    renderInsightMetric(IexaI18n.t('insights.activeTime'), formatInsightDuration(t.activeMs), IexaI18n.t('insights.modelCalls', { count: formatInsightTokens(t.modelCalls) })),
  ].join('');
}

/** Token + cost columns; cost bars only appear when a price is configured. */
function renderInsightBars(data) {
  const daily = data.daily.slice(-14);
  const maxTokens = Math.max(1, ...daily.map((day) => day.inputTokens + day.outputTokens));
  const costs = daily.map((day) => day.costUsd).filter((value) => value !== null);
  const maxCost = costs.length ? Math.max(0.0001, ...costs) : 0;
  const bars = daily.map((day) => {
    const tokens = day.inputTokens + day.outputTokens;
    const tokenHeight = Math.max(2, Math.round((tokens / maxTokens) * 100));
    const costHeight = maxCost > 0 && day.costUsd !== null ? Math.max(2, Math.round((day.costUsd / maxCost) * 100)) : 0;
    const label = day.day.slice(5);
    return `<div class="insights-bar" title="${label} · ${formatInsightTokens(tokens)} Token${day.costUsd !== null ? ' · ' + formatInsightCost(day.costUsd) : ''}">
      <div class="insights-bar-track">
        <i class="insights-bar-token" style="height:${tokenHeight}%"></i>
        ${costHeight ? `<i class="insights-bar-cost" style="height:${costHeight}%"></i>` : ''}
      </div>
      <span>${label}</span>
    </div>`;
  }).join('');
  return `<div class="insights-bars">${bars}</div>
    <div class="insights-bars-legend">
      <span><i class="is-token"></i>Token</span>
      ${maxCost > 0 ? `<span><i class="is-cost"></i>${IexaI18n.t('insights.costLegend')}</span>` : ''}
    </div>`;
}

/** Week rows × day columns, Monday first, with month labels above. */
function renderInsightHeatmap(data) {
  const cells = data.activity;
  if (!cells.length) return `<div class="insights-empty-small">${IexaI18n.t('insights.noActivity')}</div>`;
  const max = Math.max(1, ...cells.map((cell) => cell.tokens));
  const byDay = new Map(cells.map((cell) => [cell.day, cell]));
  const first = new Date(cells[0].day + 'T00:00:00');
  const last = new Date(cells[cells.length - 1].day + 'T00:00:00');
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const weeks = [];
  for (let cursor = new Date(start); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
    const index = Math.floor((cursor - start) / 86400000 / 7);
    weeks[index] = weeks[index] || [];
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    const cell = byDay.get(key);
    const level = cell ? Math.min(4, Math.max(1, Math.ceil((cell.tokens / max) * 4))) : 0;
    weeks[index].push({ key, level, tokens: cell ? cell.tokens : 0, turns: cell ? cell.turns : 0 });
  }
  const months = [];
  weeks.forEach((week, index) => {
    const firstOfWeek = new Date(start.getTime() + index * 7 * 86400000);
    if (firstOfWeek.getDate() <= 7) months.push(`<span style="grid-column:${index + 1}">${IexaI18n.t('insights.monthLabel', { month: firstOfWeek.getMonth() + 1 })}</span>`);
  });
  const days = [1, 2, 3, 4, 5, 6, 7].map((n) => IexaI18n.t('insights.dow.' + n));
  const grid = weeks.map((week) => week.map((cell) => `<i class="is-level-${cell.level}" title="${cell.key} · ${formatInsightTokens(cell.tokens)} Token · ${IexaI18n.t('insights.turnsValue', { count: cell.turns })}"></i>`).join('')).join('');
  return `<div class="insights-heat">
    <div class="insights-heat-months" style="grid-template-columns:repeat(${weeks.length}, 14px)">${months.join('')}</div>
    <div class="insights-heat-body">
      <div class="insights-heat-days">${days.map((day) => `<span>${day}</span>`).join('')}</div>
      <div class="insights-heat-grid" style="grid-template-columns:repeat(${weeks.length}, 14px)">${grid}</div>
    </div>
    <div class="insights-heat-legend"><span>${IexaI18n.t('insights.less')}</span>${[0, 1, 2, 3, 4].map((level) => `<i class="is-level-${level}"></i>`).join('')}<span>${IexaI18n.t('insights.more')}</span></div>
  </div>`;
}

function insightSessionModels(data) {
  const models = [...new Set(data.sessions.map((session) => session.model).filter(Boolean))];
  return ['all', ...models];
}

function insightFilteredSessions(data) {
  const query = insightsState.search.trim().toLowerCase();
  let list = data.sessions.filter((session) => {
    if (insightsState.model !== 'all' && session.model !== insightsState.model) return false;
    if (!query) return true;
    return (session.title || '').toLowerCase().includes(query) || (session.lastMessage || '').toLowerCase().includes(query);
  });
  if (insightsState.sort === 'tokens') list = list.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  else if (insightsState.sort === 'cost') list = list.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  else list = list.sort((a, b) => b.updated - a.updated);
  return list;
}

function renderInsightSessions(data) {
  const list = insightFilteredSessions(data);
  const grand = Math.max(1, data.sessions.reduce((sum, session) => sum + session.inputTokens + session.outputTokens, 0));
  const chips = insightSessionModels(data).map((model) => {
    const label = model === 'all' ? IexaI18n.t('insights.all') : model;
    return `<button type="button" class="insights-chip${insightsState.model === model ? ' is-active' : ''}" data-insight-model="${escapeHtml(model)}">${escapeHtml(label)}</button>`;
  }).join('');
  const sorts = [['recent', IexaI18n.t('insights.sortRecent')], ['tokens', IexaI18n.t('insights.sortTokens')], ['cost', IexaI18n.t('insights.cost')]].map(([key, label]) =>
    `<button type="button" class="insights-sort${insightsState.sort === key ? ' is-active' : ''}" data-insight-sort="${key}">${label}</button>`).join('');
  const cards = list.map((session) => {
    const tokens = session.inputTokens + session.outputTokens;
    const share = tokens / grand;
    const percent = share < 0.01 ? '<1%' : (share * 100).toFixed(1) + '%';
    const when = session.updated ? new Date(session.updated) : null;
    const relative = when ? formatInsightRelative(when.getTime()) : '';
    const date = when ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}` : '';
    return `<article class="insights-session" data-session-id="${escapeHtml(session.id)}">
      <header>
        <strong>${escapeHtml(session.title || IexaI18n.t('insights.untitled'))}</strong>
        <span class="insights-session-when"><b>${escapeHtml(relative)}</b><small>${date}</small></span>
      </header>
      ${session.model ? `<span class="insights-session-tag">${escapeHtml(session.model)}</span>` : ''}
      <div class="insights-session-body">
        <div class="insights-session-ring" style="--share:${(share * 100).toFixed(1)}">
          <div><strong>${formatInsightTokens(tokens)}</strong><span>${percent}</span></div>
        </div>
        <dl>
          <div><dt>${IexaI18n.t('insights.turns')}</dt><dd>${IexaI18n.t('insights.turnsValue', { count: session.turns })}</dd></div>
          <div><dt>${IexaI18n.t('insights.totalTokens')}</dt><dd>${formatInsightTokens(tokens)}</dd></div>
          <div><dt>${IexaI18n.t('insights.cost')}</dt><dd>${formatInsightCost(session.costUsd)}</dd></div>
        </dl>
      </div>
      ${session.lastMessage ? `<p class="insights-session-last"><span>${IexaI18n.t('insights.lastMessage')}</span>${escapeHtml(session.lastMessage)}</p>` : ''}
    </article>`;
  }).join('');
  return `<div class="insights-sessions-tools">
      <input type="search" id="insightsSearch" class="insights-search" placeholder="${IexaI18n.t('insights.searchPlaceholder')}" value="${escapeHtml(insightsState.search)}" aria-label="${IexaI18n.t('insights.searchAria')}">
      <div class="insights-sorts">${sorts}</div>
    </div>
    <div class="insights-chips">${chips}</div>
    <div class="insights-session-grid">${cards || `<div class="insights-empty-small">${IexaI18n.t('insights.noMatch')}</div>`}</div>`;
}

function insightsRangeLabel(range) {
  if (range === '24h') return IexaI18n.t('insights.range24h');
  if (range === '7d') return IexaI18n.t('insights.range7d');
  if (range === '30d') return IexaI18n.t('insights.range30d');
  return IexaI18n.t('insights.all');
}

function formatInsightRelative(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return IexaI18n.t('insights.justNow');
  if (diff < 3_600_000) return IexaI18n.t('insights.minutesAgo', { count: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return IexaI18n.t('insights.hoursAgo', { count: Math.round(diff / 3_600_000) });
  return IexaI18n.t('insights.daysAgo', { count: Math.round(diff / 86_400_000) });
}

function renderUsageInsights() {
  const grid = insightsEl('insightsGrid');
  if (!grid) return;
  if (insightsState.loading && !insightsState.data) {
    grid.innerHTML = `<div class="insights-loading">${IexaI18n.t('insights.loading')}</div>`;
    return;
  }
  if (insightsState.error) {
    grid.innerHTML = `<div class="insights-error">${escapeHtml(insightsState.error)}</div>`;
    return;
  }
  const data = insightsState.data;
  if (!data) return;
  if (!data.totals.turns) {
    grid.innerHTML = `<div class="insights-empty">
      <strong>${IexaI18n.t('insights.emptyTitle')}</strong>
      <p>${IexaI18n.t('insights.emptyBody')}</p>
    </div>`;
    return;
  }
  const tokenTotal = data.tokenBreakdown.reduce((sum, part) => sum + part.tokens, 0);
  const timeTotal = data.timeBreakdown.reduce((sum, part) => sum + part.ms, 0);
  const outputMs = (data.timeBreakdown.find((part) => part.key === 'output') || {}).ms || 0;
  const rate = outputMs > 0 ? Math.round(data.totals.outputTokens / (outputMs / 1000)) : 0;

  grid.innerHTML = `
    <section class="insights-card insights-card-metrics">${renderInsightMetrics(data)}</section>
    <section class="insights-card insights-card-trend">
      <header class="insights-card-head"><h3>${IexaI18n.t('insights.rangeTitle', { range: insightsRangeLabel(data.range) })}</h3></header>
      ${renderInsightBars(data)}
    </section>
    <section class="insights-card insights-card-token">
      <header class="insights-card-head"><h3>${IexaI18n.t('insights.tokenTitle')}</h3>${data.tokenBreakdownEstimated ? `<span class="insights-badge" title="${IexaI18n.t('insights.estimatedHint')}">${IexaI18n.t('insights.estimated')}</span>` : ''}</header>
      <div class="insights-split">
        ${renderInsightDonut(data.tokenBreakdown, formatInsightTokens(tokenTotal), IexaI18n.t('insights.totalTokens'), TOKEN_COLORS)}
        ${renderInsightLegend(data.tokenBreakdown, TOKEN_COLORS, (part) => '≈' + formatInsightTokens(part.tokens))}
      </div>
    </section>
    <section class="insights-card insights-card-time">
      <header class="insights-card-head"><h3>${IexaI18n.t('insights.timeTitle')}</h3>${rate > 0 ? `<span class="insights-badge is-quiet">${rate} tok/s</span>` : ''}</header>
      <div class="insights-split">
        ${renderInsightDonut(data.timeBreakdown, formatInsightDuration(timeTotal), IexaI18n.t('insights.activeTime'), TIME_COLORS)}
        ${renderInsightLegend(data.timeBreakdown, TIME_COLORS, (part) => formatInsightDuration(part.ms))}
      </div>
    </section>
    <section class="insights-card insights-card-activity">
      <header class="insights-card-head"><h3>${IexaI18n.t('insights.activityTitle')}</h3><span class="insights-stamp">${IexaI18n.t('insights.perDay')}</span></header>
      ${renderInsightHeatmap(data)}
    </section>
    <section class="insights-card insights-card-sessions">
      <header class="insights-card-head"><h3>${IexaI18n.t('insights.sessionsTitle')} <span class="insights-count">${data.sessions.length}</span></h3></header>
      ${renderInsightSessions(data)}
    </section>`;
  bindInsightControls();
}

function bindInsightControls() {
  const search = insightsEl('insightsSearch');
  if (search) {
    search.addEventListener('input', () => {
      insightsState.search = search.value;
      const grid = insightsEl('insightsGrid');
      const data = insightsState.data;
      if (!grid || !data) return;
      // Repaint only the session list so the caret and scroll position survive.
      const host = grid.querySelector('.insights-card-sessions');
      if (host) host.innerHTML = `<header class="insights-card-head"><h3>${IexaI18n.t('insights.sessionsTitle')} <span class="insights-count">${data.sessions.length}</span></h3></header>${renderInsightSessions(data)}`;
      bindInsightControls();
      insightsEl('insightsSearch')?.focus();
      insightsEl('insightsSearch')?.setSelectionRange(insightsState.search.length, insightsState.search.length);
    });
  }
  document.querySelectorAll('[data-insight-model]').forEach((button) => {
    button.addEventListener('click', () => {
      insightsState.model = button.dataset.insightModel || 'all';
      renderUsageInsights();
    });
  });
  document.querySelectorAll('[data-insight-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      insightsState.sort = button.dataset.insightSort || 'recent';
      renderUsageInsights();
    });
  });
}

async function loadInsightsBalance() {
  const chip = insightsEl('insightsBalance');
  if (!chip) return;
  try {
    const profiles = await (await fetch(`${API_BASE}/api/profiles`)).json();
    const list = Array.isArray(profiles) ? profiles : (profiles.profiles || []);
    // The settings endpoint names the active profile `activeProfileId`; the
    // older `activeId` is still accepted so a cached response keeps working.
    const activeId = profiles.activeProfileId || profiles.activeId;
    const active = list.find((profile) => profile.id === activeId)
      || list.find((profile) => profile.active)
      || list[0];
    if (!active) { chip.hidden = true; return; }
    const response = await fetch(`${API_BASE}/api/profiles/${encodeURIComponent(active.id)}/balance`);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.status !== 'ok' || !Number.isFinite(Number(data.remaining))) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.textContent = `${active.model || active.provider || IexaI18n.t('insights.balance')} · ${formatInsightBalance(data.remaining, data.currency)}`;
    chip.title = data.source ? IexaI18n.t('insights.source', { source: data.source }) : IexaI18n.t('insights.accountBalance');
  } catch {
    chip.hidden = true;
  }
}

async function loadUsageInsights() {
  insightsState.loading = true;
  insightsState.error = '';
  renderUsageInsights();
  try {
    const response = await fetch(`${API_BASE}/api/usage/insights?range=${encodeURIComponent(insightsState.range)}`);
    if (!response.ok) throw new Error(IexaI18n.t('insights.summaryFailedDetail'));
    insightsState.data = await response.json();
  } catch (error) {
    insightsState.error = error.message || IexaI18n.t('insights.summaryFailed');
  } finally {
    insightsState.loading = false;
    renderUsageInsights();
  }
}

function setInsightsRange(range) {
  const allowed = ['24h', '7d', '30d', 'all'];
  insightsState.range = allowed.includes(range) ? range : '7d';
  document.querySelectorAll('.insights-ranges [data-range]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.range === insightsState.range));
  });
  void loadUsageInsights();
}

function initUsageInsights() {
  window.IexaInsights = { reload: loadUsageInsights, setRange: setInsightsRange };
  document.querySelectorAll('.insights-ranges [data-range]').forEach((button) => {
    button.addEventListener('click', () => setInsightsRange(button.dataset.range));
  });
  void loadUsageInsights();
  void loadInsightsBalance();
}
