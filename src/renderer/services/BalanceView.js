// =============================================================================
// Account balance chip
//
// Lives at the right end of the composer's model bar. Shows the provider's
// account balance (DeepSeek, OpenRouter, or an OpenAI-compatible gateway's
// billing endpoint) and expands into a receipt with usage and refresh.
//
// Classic script: top-level declarations join the global scope; nothing runs at
// evaluation time.
// =============================================================================
const balanceView = {
  profileId: '',
  data: null,
  renderedData: null,
  loading: false,
  lastAt: 0,
  open: false,
};

const BALANCE_REFRESH_MS = 300_000;

function balanceElement(id) {
  return document.getElementById(id);
}

function formatBalanceMoney(value, currency, compact = true) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  // Pool gateways meter in credits, not money: no symbol, and the unit is the
  // word itself so "1,234 积分" reads correctly at any size.
  if (currency === 'credits') {
    const body = compact && Math.abs(number) >= 1000
      ? (number / 1000).toFixed(1) + 'k'
      : number.toLocaleString('zh-CN', { maximumFractionDigits: compact ? 0 : 2 });
    return body + ' 积分';
  }
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
  const absolute = Math.abs(number);
  const body = compact
    ? absolute >= 1000
      ? (number / 1000).toFixed(1) + 'k'
      : absolute >= 100
        ? number.toFixed(0)
        : number.toFixed(2)
    : number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? symbol + body : body + (currency ? ' ' + currency : '');
}

function balanceIsLow(data) {
  if (!data || data.status !== 'ok') return false;
  if (typeof data.remaining !== 'number') return false;
  if (data.remaining <= 0) return true;
  return typeof data.total === 'number' && data.total > 0 && data.remaining / data.total < 0.1;
}

function closeBalancePopover() {
  const popover = balanceElement('balancePopover');
  const chip = balanceElement('balanceChip');
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  chip?.setAttribute('aria-expanded', 'false');
  balanceView.open = false;
}

function renderBalancePopover(data) {
  const popover = balanceElement('balancePopover');
  if (!popover) return;
  popover.replaceChildren();
  if (!data || data.status !== 'ok') {
    // The chip is hidden in this state, so this is only a defensive path.
    const message = document.createElement('p');
    message.className = 'balance-empty';
    message.textContent = data?.message || '暂时无法读取余额。';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'balance-refresh';
    retry.textContent = '重试';
    retry.addEventListener('click', () => refreshBalance(true));
    popover.append(message, retry);
    return;
  }

  const head = document.createElement('div');
  head.className = 'balance-pop-head';
  const title = document.createElement('span');
  title.className = 'balance-pop-title';
  title.textContent = '账户余额';
  const source = document.createElement('span');
  source.className = 'balance-source';
  source.textContent = data.source || '服务商接口';
  head.append(title, source);

  const total = document.createElement('strong');
  total.className = 'balance-total';
  total.textContent = formatBalanceMoney(data.remaining, data.currency, false);

  const rows = document.createElement('dl');
  rows.className = 'balance-rows';
  const addRow = (label, value) => {
    if (value === undefined || value === null || !Number.isFinite(Number(value))) return;
    const row = document.createElement('div');
    const key = document.createElement('dt');
    key.textContent = label;
    const amount = document.createElement('dd');
    amount.textContent = formatBalanceMoney(value, data.currency, false);
    row.append(key, amount);
    rows.append(row);
  };
  addRow('已用', data.used);
  addRow('赠送', data.granted);
  addRow('充值', data.toppedUp);
  addRow('总额', data.total);

  const foot = document.createElement('div');
  foot.className = 'balance-foot';
  const stamp = document.createElement('span');
  const at = new Date(data.updatedAt || Date.now());
  stamp.textContent = '更新于 ' + at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'balance-refresh';
  refresh.textContent = balanceView.loading ? '刷新中…' : '刷新';
  refresh.disabled = balanceView.loading;
  refresh.addEventListener('click', () => refreshBalance(true));
  foot.append(stamp, refresh);

  popover.append(head, total);
  if (rows.children.length) popover.append(rows);
  popover.append(foot);
}

function syncBalanceRefreshButton() {
  const button = document.querySelector('#balancePopover .balance-refresh');
  if (!button) return;
  button.textContent = balanceView.loading ? '刷新中…' : '刷新';
  button.disabled = balanceView.loading;
}

function renderBalanceChip() {
  const wrap = balanceElement('balanceWrap');
  const chip = balanceElement('balanceChip');
  const value = balanceElement('balanceValue');
  if (!wrap || !chip || !value) return;
  // The composer hint mirrors the chip, so re-seed it whenever the chip repaints.
  window.IexaComposerHint?.refresh?.();
  const data = balanceView.data;
  const hasValue = Boolean(data) && data.status === 'ok' && Number.isFinite(Number(data.remaining));

  // No number, no chip. A provider without a balance route, a failed probe or a
  // payload that never yielded an amount used to leave a lone dash sitting in
  // the model bar, which reads as a broken control rather than "no balance here".
  if (!balanceView.profileId || !hasValue) {
    // Clear the stale number: a hidden node that still carries the last value
    // would flash it back the moment anything unhides it.
    value.textContent = '';
    delete chip.dataset.state;
    wrap.hidden = true;
    closeBalancePopover();
    return;
  }

  wrap.hidden = false;
  const text = formatBalanceMoney(data.remaining, data.currency);
  const low = balanceIsLow(data);
  value.textContent = text;
  chip.dataset.state = low ? 'low' : 'ok';
  const title = `账户余额 ${text}${low ? ' · 余额偏低' : ''}，点击查看明细`;
  chip.title = title;
  chip.setAttribute('aria-label', title);
  chip.setAttribute('aria-busy', String(balanceView.loading));

  if (!balanceView.open) return;
  // Repaint only when the payload changed; a refresh keeps the button the user
  // just pressed alive, so focus and the click path survive the request.
  if (data !== balanceView.renderedData) {
    balanceView.renderedData = data;
    renderBalancePopover(data);
  } else {
    syncBalanceRefreshButton();
  }
}

async function refreshBalance(force = false) {
  if (!balanceView.profileId) return;
  const profileId = balanceView.profileId;
  balanceView.loading = true;
  renderBalanceChip();
  try {
    const query = force ? '?refresh=1' : '';
    const response = await fetch(`${API_BASE}/api/profiles/${encodeURIComponent(profileId)}/balance${query}`);
    const data = await response.json().catch(() => null);
    if (balanceView.profileId !== profileId) return;
    balanceView.data = response.ok && data ? data : { status: 'error', message: data?.error || '余额读取失败', updatedAt: Date.now() };
  } catch (error) {
    if (balanceView.profileId !== profileId) return;
    balanceView.data = { status: 'error', message: error.message || '网络错误', updatedAt: Date.now() };
  } finally {
    if (balanceView.profileId === profileId) {
      balanceView.loading = false;
      balanceView.lastAt = Date.now();
      renderBalanceChip();
    }
  }
}

function setBalanceProfile(profileId) {
  const next = String(profileId || '');
  if (next === balanceView.profileId) return;
  balanceView.profileId = next;
  balanceView.data = null;
  balanceView.renderedData = null;
  balanceView.loading = false;
  closeBalancePopover();
  renderBalanceChip();
  if (next) refreshBalance();
}

function scheduleBalanceRefresh() {
  if (!balanceView.profileId) return;
  if (Date.now() - balanceView.lastAt < BALANCE_REFRESH_MS) return;
  refreshBalance();
}

function initBalanceView() {
  const chip = balanceElement('balanceChip');
  chip?.addEventListener('click', (event) => {
    event.stopPropagation();
    const popover = balanceElement('balancePopover');
    if (!popover) return;
    balanceView.open = popover.hidden;
    popover.hidden = !balanceView.open;
    chip.setAttribute('aria-expanded', String(balanceView.open));
    if (balanceView.open) {
      balanceView.renderedData = balanceView.data;
      renderBalancePopover(balanceView.data);
      if (!balanceView.data && !balanceView.loading) refreshBalance(true);
    }
  });
  document.addEventListener('click', (event) => {
    if (!balanceView.open) return;
    // composedPath survives a repaint that detaches the clicked node; closest()
    // would walk a detached tree and wrongly close the popover.
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.some((node) => node && node.id === 'balanceWrap')) return;
    if (event.target.closest?.('#balanceWrap')) return;
    closeBalancePopover();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && balanceView.open) {
      closeBalancePopover();
      chip?.focus();
    }
  });
  document.addEventListener('iexa:active-profile', (event) => setBalanceProfile(event.detail?.id));
  document.addEventListener('iexa:turn-finished', scheduleBalanceRefresh);
  // Idle sessions still drift as usage accrues elsewhere; refresh on a slow
  // background cadence, never while the window is hidden.
  window.setInterval(() => {
    if (!document.hidden) scheduleBalanceRefresh();
  }, 60_000);
  window.IexaBalance = Object.freeze({ refresh: refreshBalance, setProfile: setBalanceProfile });
}
