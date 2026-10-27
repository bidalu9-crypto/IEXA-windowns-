/* Plugin market: search a configured index and install one entry.
 *
 * The index is user-supplied, exactly like DeepSeek Harness's Discover tab:
 * the host validates it, this panel only presents the result.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'iexa.pluginIndex';
  let busy = false;

  function el(id) { return document.getElementById(id); }

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

  function setHint(text, isError) {
    const hint = el('pluginMarketHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.dataset.error = isError ? 'true' : 'false';
  }

  function renderItems(items) {
    const list = el('pluginMarketList');
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
      setHint(t('market.empty', '没有匹配的插件'));
      return;
    }
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'market-card';
      const head = document.createElement('div');
      head.className = 'market-card-head';
      const title = document.createElement('strong');
      title.textContent = item.name || item.id;
      const version = document.createElement('span');
      version.className = 'market-version';
      version.textContent = 'v' + item.version;
      head.append(title, version);

      const meta = document.createElement('p');
      meta.className = 'market-meta';
      meta.textContent = [item.author, (item.tags || []).join(' · ')].filter(Boolean).join(' · ');

      const desc = document.createElement('p');
      desc.className = 'market-desc';
      desc.textContent = item.description || '';

      const install = document.createElement('button');
      install.type = 'button';
      install.className = 'btn-primary btn-sm';
      install.textContent = t('market.install', '安装');
      install.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        install.disabled = true;
        install.textContent = t('market.installing', '安装中…');
        try {
          const response = await fetch(API_BASE + '/api/plugins/market/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: el('pluginMarketIndex').value.trim(), id: item.id }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || '安装失败');
          install.textContent = t('market.installed', '已安装');
          setHint(t('market.installedHint', '已安装 {name}', { name: data.plugin?.name || item.name }));
          await window.loadPlugins?.();
        } catch (error) {
          install.disabled = false;
          install.textContent = t('market.install', '安装');
          setHint(error.message || String(error), true);
        } finally {
          busy = false;
        }
      });

      card.append(head, meta, desc, install);
      list.appendChild(card);
    }
  }

  async function search() {
    const index = el('pluginMarketIndex');
    const query = el('pluginMarketQuery');
    if (!index || !query) return;
    const url = index.value.trim();
    if (!url) { setHint(t('market.needIndex', '请先填写索引地址'), true); return; }
    try { localStorage.setItem(STORAGE_KEY, url); } catch { /* storage is optional */ }
    setHint(t('market.searching', '搜索中…'));
    const list = el('pluginMarketList');
    if (list) list.replaceChildren();
    try {
      const response = await fetch(API_BASE + '/api/plugins/market/search?url=' + encodeURIComponent(url) + '&q=' + encodeURIComponent(query.value.trim()));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '搜索失败');
      setHint(t('market.count', '{count} 个插件', { count: (data.items || []).length }));
      renderItems(data.items || []);
    } catch (error) {
      setHint(error.message || String(error), true);
    }
  }

  function init() {
    const toggle = el('pluginMarketToggle');
    const body = el('pluginMarketBody');
    const index = el('pluginMarketIndex');
    if (!toggle || !body || !index) return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) index.value = saved;
    } catch { /* storage is optional */ }
    toggle.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? t('market.collapse', '收起') : t('market.expand', '展开');
    });
    el('pluginMarketSearchBtn')?.addEventListener('click', search);
    el('pluginMarketQuery')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); search(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.IexaPluginMarket = { search, init };
})();
