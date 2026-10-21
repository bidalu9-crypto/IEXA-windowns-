// =============================================================================
// Context insights — the dashboard behind "上下文洞察".
//
// Reads /api/usage/insights and paints six metric tiles, a daily bar chart, two
// donuts (token origin and where the time went), an activity heatmap and the
// per-session list. Everything is inline CSS/SVG: the renderer still ships with
// no chart dependency.
// =============================================================================
const insightsState = { range: '7d', data: null, loading: false, error: '' };

const INSIGHT_COLORS = ['#4c8dff', '#f2a33c', '#37b98a', '#a97bff', '#e8698a', '#3bb7c8', '#8b93a7'];

// Colour by meaning, not by position: a legend that recolours itself whenever a
// zero-width slice drops out is unreadable. The largest slice (tool results)
// takes the primary blue so the ring reads as "mostly tool output".
const TOKEN_COLORS = {
  system: '#8b93a7',
  tools: '#f2a33c',
  user: '#37b98a',
  injected: '#a97bff',
  assistant: '#3bb7c8',
  toolResult: '#4c8dff',
  output: '#e8698a',
};
const TIME_COLORS = {
  wait: '#4c8dff',
  think: '#a97bff',
  output: '#37b98a',
  tool: '#f2a33c',
  other: '#8b93a7',
};

function insightColor(part, palette) {
  return palette[part.key] || INSIGHT_COLORS[0];
}

function insightsEl(id) {
  return document.getElementById(id);
}

function formatInsightTokens(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1e9) return (number / 1e9).toFixed(2) + 'B';
  if (number >= 1e6) return (number / 1e6).toFixed(1) + 'M';
  if (number >= 1e4) return (number / 1e3).toFixed(0) + 'K';
  if (number >= 1e3) return (number / 1e3).toFixed(1) + 'K';
  return String(Math.round(number));
}

function formatInsightDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + '秒';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + '分';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '小时' + String(minutes % 60).padStart(2, '0') + '分';
  return Math.floor(hours / 24) + '天' + String(hours % 24).padStart(2, '0') + '小时';
}

function formatInsightCost(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number === 0) return '¥0.00';
  if (number < 0.01) return '¥' + number.toFixed(4);
  return '¥' + number.toFixed(2);
}

function formatInsightPercent(ratio) {
  const value = Math.max(0, Number(ratio) || 0) * 100;
  if (value > 0 && value < 0.1) return '<0.1%';
  return value.toFixed(1) + '%';
}

function insightMetric(label, value, hint) {
  return `<div class="insights-metric">
    <span class="insights-metric-label">${escapeHtml(label)}</span>
    <strong class="insights-metric-value">${value}</strong>
    ${hint ? `<small class="insights-metric-hint">${escapeHtml(hint)}</small>` : ''}
  </div>`;
}

function renderInsightMetrics(data) {
  const totals = data.totals;
  const turns = totals.turns || 0;
  const perTurn = turns > 0 ? totals.inputTokens / turns : 0;
  return `
    ${insightMetric('活跃会话', String(totals.sessions), '共 ' + totals.sessions + ' 个')}
    ${insightMetric('累计消耗', formatInsightTokens(totals.inputTokens + totals.outputTokens), '轮次 ' + turns)}
    ${insightMetric('费用', formatInsightCost(totals.costUsd), totals.costUsd === null ? '在模型设置里填单价' : '按单价估算')}
    ${insightMetric('缓存命中', formatInsightPercent(totals.cacheHitRate), '缓存读取 ' + formatInsightTokens(totals.cacheReadTokens))}
    ${insightMetric('工具调用', formatInsightTokens(totals.toolCalls), '执行 ' + formatInsightDuration(totals.toolMs))}
    ${insightMetric('活跃时长', formatInsightDuration(totals.activeMs), '模型调用 ' + totals.modelCalls + ' 次')}
    <div class="insights-metric insights-metric-wide">
      <span class="insights-metric-label">每轮平均上下文</span>
      <strong class="insights-metric-value">${formatInsightTokens(perTurn)}</strong>
      <small class="insights-metric-hint">输入侧合计 ÷ 轮次</small>
    </div>`;
}

function renderInsightDonut(parts, centerValue, centerLabel, palette = TOKEN_COLORS) {
  const visible = parts.filter((part) => part.ratio > 0);
  if (!visible.length) return '<div class="insights-empty-inline">暂无数据</div>';
  let acc = 0;
  const stops = visible.map((part) => {
    const start = acc * 100;
    acc += part.ratio;
    return `${insightColor(part, palette)} ${start.toFixed(2)}% ${(acc * 100).toFixed(2)}%`;
  }).join(', ');
  const legend = visible.map((part) => `
    <li>
      <i style="background:${insightColor(part, palette)}"></i>
      <span class="insights-legend-label">${escapeHtml(part.label)}</span>
      <b>${formatInsightPercent(part.ratio)}</b>
      <small>${part.tokens !== undefined ? formatInsightTokens(part.tokens) : formatInsightDuration(part.ms)}</small>
    </li>`).join('');
  return `<div class="insights-donut-wrap">
    <div class="insights-donut-ring" style="background: conic-gradient(${stops})" role="img" aria-label="${escapeHtml(centerLabel)}">
      <span class="insights-donut-hole"><b>${centerValue}</b><small>${escapeHtml(centerLabel)}</small></span>
    </div>
    <ul class="insights-legend">${legend}</ul>
  </div>`;
}

function renderInsightBars(data) {
  const days = data.daily;
  if (!days.length) return '<div class="insights-empty-inline">这段时间还没有调用记录</div>';
  const peak = Math.max(1, ...days.map((day) => day.inputTokens + day.outputTokens));
  const hasCost = days.some((day) => day.costUsd !== null && day.costUsd > 0);
  const costPeak = hasCost ? Math.max(...days.map((day) => day.costUsd || 0), 0.0001) : 1;
  const bars = days.map((day) => {
    const tokens = day.inputTokens + day.outputTokens;
    const tokenHeight = Math.max(2, Math.round((tokens / peak) * 100));
    const costHeight = hasCost ? Math.max(1, Math.round(((day.costUsd || 0) / costPeak) * 100)) : 0;
    const label = day.day.slice(5);
    return `<div class="insights-bar" title="${escapeHtml(day.day)} · ${formatInsightTokens(tokens)} tokens${hasCost ? ' · ' + formatInsightCost(day.costUsd) : ''}">
      <div class="insights-bar-track">
        <i class="insights-bar-token" style="height:${tokenHeight}%"></i>
        ${hasCost ? `<i class="insights-bar-cost" style="height:${costHeight}%"></i>` : ''}
      </div>
      <span>${escapeHtml(label)}</span>
    </div>`;
  }).join('');
  return `<div class="insights-bars">${bars}</div>
    <div class="insights-bars-legend">
      <span><i class="insights-swatch-token"></i>Token</span>
      ${hasCost ? '<span><i class="insights-swatch-cost"></i>费用</span>' : '<span class="insights-muted">费用：未配置单价</span>'}
    </div>`;
}

/** Monday-first calendar grid: 7 rows, one column per week. */
function renderInsightHeatmap(data) {
  const cells = data.activity;
  if (!cells.length) return '<div class="insights-empty-inline">暂无活跃记录</div>';
  const byDay = new Map(cells.map((cell) => [cell.day, cell]));
  const first = new Date(cells[0].day + 'T00:00:00');
  const last = new Date(cells[cells.length - 1].day + 'T00:00:00');
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  // A three-day window would otherwise render two lonely columns; keep the
  // calendar wide enough to read as one, and widen it with the range.
  const MIN_WEEKS = data.range === '24h' ? 4 : data.range === '7d' ? 6 : data.range === '30d' ? 12 : 6;
  const totalDays = Math.round((last - start) / 86400000) + 1;
  const weeks = Math.max(MIN_WEEKS, Math.ceil(totalDays / 7));
  if (weeks > Math.ceil(totalDays / 7)) {
    start.setDate(start.getDate() - (weeks - Math.ceil(totalDays / 7)) * 7);
  }
  const peak = Math.max(1, ...cells.map((cell) => cell.tokens));
  const columns = [];
  for (let week = 0; week < weeks; week += 1) {
    const column = [];
    for (let row = 0; row < 7; row += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + row);
      const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
      const cell = byDay.get(key);
      const level = cell ? Math.min(4, Math.max(1, Math.ceil((cell.tokens / peak) * 4))) : 0;
      const title = cell ? `${key} · ${formatInsightTokens(cell.tokens)} tokens · ${cell.turns} 轮` : key;
      column.push(`<i class="insights-heat-cell" data-level="${level}" title="${escapeHtml(title)}"></i>`);
    }
    columns.push(`<div class="insights-heat-col">${column.join('')}</div>`);
  }
  const monthLabels = [];
  let lastMonth = '';
  for (let week = 0; week < weeks; week += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + week * 7);
    const label = (date.getMonth() + 1) + '月';
    monthLabels.push(label !== lastMonth ? `<span>${label}</span>` : '<span></span>');
    lastMonth = label;
  }
  return `<div class="insights-heat">
    <div class="insights-heat-body">
      <div class="insights-heat-days"><span>一</span><span>三</span><span>五</span><span>日</span></div>
      <div class="insights-heat-grid">${columns.join('')}</div>
    </div>
    <div class="insights-heat-months">${monthLabels.join('')}</div>
    <div class="insights-heat-scale"><span>少</span><i data-level="0"></i><i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i><span>多</span></div>
  </div>`;
}

function renderInsightSessions(data) {
  const sessions = data.sessions.slice(0, 24);
  if (!sessions.length) return '<div class="insights-empty-inline">这段时间还没有会话</div>';
  const peak = Math.max(1, ...sessions.map((session) => session.inputTokens + session.outputTokens));
  return sessions.map((session) => {
    const tokens = session.inputTokens + session.outputTokens;
    const share = Math.min(1, tokens / peak);
    const shareLabel = share > 0 && share < 0.01 ? '<1%' : Math.round(share * 100) + '%';
    const circumference = 2 * Math.PI * 15;
    const dash = (circumference * share).toFixed(1);
    const when = session.updated ? new Date(session.updated).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    return `<article class="insights-session">
      <header>
        <strong title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</strong>
        <time>${escapeHtml(when)}</time>
      </header>
      <div class="insights-session-body">
        <div class="insights-session-ring-wrap">
          <svg class="insights-session-ring" viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r="15" fill="none" style="stroke: var(--border)" stroke-width="3.4"></circle>
            <circle cx="18" cy="18" r="15" fill="none" style="stroke: var(--accent)" stroke-width="3.4" stroke-linecap="round"
              stroke-dasharray="${dash} ${circumference.toFixed(1)}" transform="rotate(-90 18 18)"></circle>
          </svg>
          <span>${shareLabel}</span>
        </div>
        <dl>
          <div><dt>轮次</dt><dd>${session.turns}</dd></div>
          <div><dt>总用量</dt><dd>${formatInsightTokens(tokens)}</dd></div>
          <div><dt>费用</dt><dd>${formatInsightCost(session.costUsd)}</dd></div>
        </dl>
      </div>
      <p class="insights-session-last">${escapeHtml(session.lastMessage || '—')}</p>
      <footer>${escapeHtml(session.model || '未记录')}</footer>
    </article>`;
  }).join('');
}

function renderUsageInsights() {
  const grid = insightsEl('insightsGrid');
  if (!grid) return;
  if (insightsState.loading && !insightsState.data) {
    grid.innerHTML = '<div class="insights-loading">正在汇总…</div>';
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
      <strong>这段时间还没有调用记录</strong>
      <p>发出第一条消息后，这里会出现 Token 构成、耗时分布和活跃度。</p>
    </div>`;
    return;
  }
  const tokenTotal = data.tokenBreakdown.reduce((sum, part) => sum + part.tokens, 0);
  const timeTotal = data.timeBreakdown.reduce((sum, part) => sum + part.ms, 0);
  grid.innerHTML = `
    <section class="insights-col insights-col-left">
      <div class="insights-card">
        <header class="insights-card-head"><h3>概览</h3><span class="insights-stamp">${data.range === 'all' ? '全部时间' : data.range === '24h' ? '近 24 小时' : data.range === '7d' ? '近 7 天' : '近 30 天'}</span></header>
        <div class="insights-metrics">${renderInsightMetrics(data)}</div>
      </div>
      <div class="insights-card">
        <header class="insights-card-head"><h3>Token 统计</h3>${data.tokenBreakdownEstimated ? '<span class="insights-badge" title="模型只返回输入总量，按消息内容估算来源">估算</span>' : ''}</header>
        ${renderInsightDonut(data.tokenBreakdown, formatInsightTokens(tokenTotal), '总 Token')}
      </div>
      <div class="insights-card">
        <header class="insights-card-head"><h3>活跃度</h3><span class="insights-stamp">按天</span></header>
        ${renderInsightHeatmap(data)}
      </div>
    </section>
    <section class="insights-col insights-col-right">
      <div class="insights-card">
        <header class="insights-card-head"><h3>用量趋势</h3><span class="insights-stamp">${data.daily.length} 天</span></header>
        ${renderInsightBars(data)}
      </div>
      <div class="insights-card">
        <header class="insights-card-head"><h3>耗时统计</h3><span class="insights-stamp">${formatInsightDuration(timeTotal)}</span></header>
        ${renderInsightDonut(data.timeBreakdown, formatInsightDuration(timeTotal), '总耗时', TIME_COLORS)}
      </div>
      <div class="insights-card">
        <header class="insights-card-head"><h3>会话</h3><span class="insights-stamp">${data.sessions.length} 个</span></header>
        <div class="insights-sessions">${renderInsightSessions(data)}</div>
      </div>
    </section>`;
}

async function loadUsageInsights(force) {
  if (insightsState.loading) return;
  insightsState.loading = true;
  insightsState.error = '';
  if (!insightsState.data || force) renderUsageInsights();
  try {
    const response = await fetch(`${API_BASE}/api/usage/insights?range=${encodeURIComponent(insightsState.range)}`);
    if (!response.ok) throw new Error('无法读取用量洞察');
    insightsState.data = await response.json();
  } catch (error) {
    insightsState.error = error.message || '无法读取用量洞察';
  } finally {
    insightsState.loading = false;
    renderUsageInsights();
  }
}

function setInsightsRange(range) {
  if (!['24h', '7d', '30d', 'all'].includes(range) || range === insightsState.range) return;
  insightsState.range = range;
  document.querySelectorAll('.insights-ranges [data-range]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.range === range));
  });
  insightsState.data = null;
  loadUsageInsights(true);
}

function initUsageInsights() {
  const tabs = document.querySelector('.insights-ranges');
  if (!tabs) return;
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-range]');
    if (button) setInsightsRange(button.dataset.range);
  });
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = Array.from(tabs.querySelectorAll('[data-range]'));
    const current = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
    const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
    setInsightsRange(buttons[next].dataset.range);
  });
}
