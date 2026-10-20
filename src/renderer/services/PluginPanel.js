// =============================================================================
// Plugin panel
//
// Plugin list, install/enable actions, tool forms and the sandboxed plugin
// iframe host.
//
// Classic script, split out of services/FilesPanel.js. Top-level declarations
// stay in the global lexical scope; index.html fixes the load order and this
// file runs nothing when it is evaluated.
// =============================================================================
let pluginState = { plugins: [], pluginsDir: '' };

function setPluginOutput(value) {
  const output = document.getElementById('pluginOutput');
  if (!output) return;
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  document.getElementById('pluginConsole')?.removeAttribute('hidden');
}

let pluginWorkspaceHost;
function getPluginWorkspace() {
  return pluginWorkspaceHost ||= window.IexaPluginWorkspace.createHost({ apiBase: API_BASE, context: () => ({ sessionId: currentSessionId || null }) });
}

// Opened from the plugin list; kept as a named installer so nothing runs while
// this script is being evaluated.
function installPluginWorkspaceBridge() {
  window.addEventListener('iexa:open-plugin', event => { if (event.detail?.id) getPluginWorkspace().open(event.detail.id, event.detail.tool); });
}

function pluginToolEditor(plugin, tool) {
  const params = Object.keys(tool.parameters || {}).length;
  const required = Array.isArray(tool.required) ? tool.required.length : 0;
  const disabled = !plugin.enabled || plugin.error;
  return `<button type="button" class="plugin-tool-row" data-plugin-tool-open="${escapeHtml(tool.name)}" ${disabled ? 'disabled' : ''}>
    <span class="plugin-tool-mark">${uiIcon('terminal')}</span>
    <span class="plugin-tool-text"><b>${escapeHtml(tool.name)}</b><small>${escapeHtml(tool.description || '没有描述')}</small></span>
    <span class="plugin-tool-schema" title="${required ? required + ' 个必填参数' : '全部参数可选'}">${params ? params + ' 参数' : '无参数'}</span>
    <span class="plugin-tool-arrow">${uiIcon('chevron-right')}</span>
  </button>`;
}

function pluginPanelChips(plugin) {
  const panels = Array.isArray(plugin.contributions?.panels) && plugin.contributions.panels.length
    ? plugin.contributions.panels
    : [{ id: 'main', title: '主面板' }];
  return panels.slice(0, 6).map((panel) => `<span class="plugin-panel-chip">${uiIcon('panel-left')}${escapeHtml(panel.title || panel.id || '面板')}</span>`).join('');
}

function pluginEmptyState(message) {
  return `<div class="plugin-empty">
    <span class="plugin-empty-icon">${uiIcon('puzzle')}</span>
    <strong>${escapeHtml(message || '还没有安装拓展')}</strong>
    <span>插件可以提供工具、可视化面板，并把结果渲染成聊天卡片。</span>
    <button type="button" class="btn-secondary btn-sm" data-plugin-install>${uiIcon('upload')}<span>添加插件</span></button>
  </div>`;
}

function pluginLoadingSkeleton() {
  return `<div class="plugin-skeleton" aria-hidden="true"><span class="plugin-skeleton-mark"></span><span class="plugin-skeleton-lines"><i></i><i></i></span></div>`.repeat(3);
}

let pluginFocusAfterRender = null;

function renderPlugins(plugins) {
  const list = document.getElementById('pluginList');
  if (!list) return;
  // Entrance motion belongs to the first paint only; a toggle must not replay it.
  const fresh = list.dataset.rendered !== '1';
  list.dataset.rendered = '1';
  list.classList.toggle('is-fresh', fresh);
  const panelCount = plugins.reduce((sum, plugin) => sum + (plugin.contributions?.panels?.length || (plugin.hasUI ? 1 : 0)), 0);
  document.getElementById('pluginCount').textContent = String(plugins.length);
  document.getElementById('pluginEnabledCount').textContent = String(plugins.filter((plugin) => plugin.enabled).length);
  document.getElementById('pluginToolCount').textContent = String(plugins.reduce((sum, plugin) => sum + (plugin.tools || []).length, 0));
  const panelStats = document.getElementById('pluginPanelCount');
  if (panelStats) panelStats.textContent = String(panelCount);
  if (!plugins.length) {
    list.innerHTML = pluginEmptyState();
    pluginFocusAfterRender = null;
    return;
  }
  list.innerHTML = plugins.map((plugin) => {
    const tools = plugin.tools || [];
    const compat = plugin.error
      ? '<span class="plugin-compat is-broken" title="插件清单无法读取">清单异常</span>'
      : `<span class="plugin-compat" title="插件清单 API 版本">清单 ${plugin.apiVersion === 2 ? 'v2' : 'v1'}</span>`;
    const version = plugin.version && plugin.version !== 'unknown' ? `<span class="plugin-version">v${escapeHtml(plugin.version)}</span>` : '';
    const slug = [plugin.name === plugin.id ? '' : plugin.id, plugin.author || ''].filter(Boolean).join(' · ');
    const description = plugin.error && !plugin.description ? '' : `<p class="plugin-description">${escapeHtml(plugin.description || '没有插件描述。')}</p>`;
    const capabilities = plugin.error ? '' : `<div class="plugin-capabilities">
        <span class="plugin-cap">${uiIcon('bolt')}${tools.length} 个工具</span>
        <span class="plugin-cap">${uiIcon('panel-left')}${plugin.hasUI ? (plugin.contributions?.panels?.length || 1) + ' 个面板' : '无面板'}</span>
        <span class="plugin-cap is-quiet">${uiIcon('box')}独立数据目录</span>
      </div>`;
    return `<article class="plugin-card ${plugin.enabled ? 'is-enabled' : ''} ${plugin.error ? 'has-error' : ''}" data-plugin-id="${escapeHtml(plugin.id)}">
      <header class="plugin-card-head">
        <span class="plugin-mark">${uiIcon('puzzle')}</span>
        <span class="plugin-identity">
          <span class="plugin-title-line">
            <strong>${escapeHtml(plugin.name)}</strong>
            ${version}
            ${compat}
          </span>
          ${slug ? `<small class="plugin-slug">${escapeHtml(slug)}</small>` : ''}
        </span>
        <label class="plugin-toggle" title="${plugin.enabled ? '停用插件' : '启用插件'}"><input type="checkbox" data-plugin-enable ${plugin.enabled ? 'checked' : ''} ${plugin.error ? 'disabled' : ''} aria-label="${escapeHtml(plugin.enabled ? '停用 ' : '启用 ') + escapeHtml(plugin.name)}"><span></span></label>
      </header>
      ${description}
      ${capabilities}
      ${plugin.error ? `<div class="plugin-error">${uiIcon('alert')}<span>${escapeHtml(plugin.error)}</span></div>` : ''}
      ${tools.length ? `<div class="plugin-tool-list">${tools.map((tool) => pluginToolEditor(plugin, tool)).join('')}</div>` : ''}
      ${plugin.hasUI ? `<div class="plugin-visual">
        <div class="plugin-visual-text"><span class="plugin-visual-label">可视化面板</span><div class="plugin-panel-chips">${pluginPanelChips(plugin)}</div></div>
        <button type="button" class="plugin-open-btn" data-plugin-open ${!plugin.enabled || plugin.error ? 'disabled' : ''}>${uiIcon('external')}<span>打开工作台</span></button>
      </div>` : ''}
      <footer class="plugin-card-foot">
        <span class="plugin-foot-note">${plugin.error ? '清单无法读取，插件未加载。' : plugin.enabled ? '工具已对后续 AI 会话生效。' : '启用后工具才会出现在 AI 工具列表。'}</span>
        <div class="plugin-foot-actions">
          <button type="button" class="plugin-quiet" data-plugin-action="reload" title="重新读取清单与代码">${uiIcon('refresh')}<span>重载</span></button>
          <button type="button" class="plugin-quiet is-danger" data-plugin-action="remove" title="卸载插件，保留数据目录">${uiIcon('trash')}<span>卸载</span></button>
        </div>
      </footer>
    </article>`;
  }).join('');

  list.querySelectorAll('.plugin-card').forEach((card) => {
    const id = card.dataset.pluginId;
    card.querySelector('[data-plugin-enable]')?.addEventListener('change', (event) => setPluginEnabled(id, event.currentTarget.checked));
    card.querySelectorAll('[data-plugin-action]').forEach((button) => button.addEventListener('click', () => runPluginAction(id, button.dataset.pluginAction)));
    card.querySelectorAll('[data-plugin-tool-open]').forEach(button => {
      button.disabled = !pluginState.plugins.find(plugin => plugin.id === id)?.enabled;
      button.addEventListener('click', () => getPluginWorkspace().open(id, button.dataset.pluginToolOpen));
    });
    card.querySelector('[data-plugin-open]')?.addEventListener('click', () => getPluginWorkspace().open(id));
  });
  // A repaint must not drop the keyboard: return focus to the control that
  // caused it, addressed by card id rather than a stale node reference.
  if (pluginFocusAfterRender) {
    const { id, selector } = pluginFocusAfterRender;
    pluginFocusAfterRender = null;
    list.querySelector(`.plugin-card[data-plugin-id="${CSS.escape(id)}"] ${selector}`)?.focus();
  }
}

async function loadPlugins() {
  const list = document.getElementById('pluginList');
  if (list) list.innerHTML = pluginLoadingSkeleton();
  try {
    const response = await fetch(`${API_BASE}/api/plugins`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取插件失败');
    pluginState = { plugins: data.plugins || [], pluginsDir: data.pluginsDir || '' };
    renderPlugins(pluginState.plugins);
  } catch (error) {
    if (list) list.innerHTML = `<div class="plugin-empty is-error"><span class="plugin-empty-icon">${uiIcon('alert')}</span><strong>读取失败</strong><span>${escapeHtml(error.message || String(error))}</span><button type="button" class="btn-secondary btn-sm" data-plugin-retry>${uiIcon('refresh')}<span>重试</span></button></div>`;
  }
}

async function installPlugin() {
  try {
    let source = null;
    if (window.iexaDesktop?.pickPluginFolder) source = await window.iexaDesktop.pickPluginFolder();
    else source = (await window.IexaDialogs.prompt('输入包含 iexa-plugin.json 的插件文件夹绝对路径：', ''));
    if (!source) return;
    setPluginOutput('正在校验并安装插件…');
    const response = await fetch(`${API_BASE}/api/plugins/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: source }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '插件安装失败');
    setPluginOutput(`已安装 ${data.plugin.name} v${data.plugin.version}，${data.plugin.tools.length} 个工具已对后续 AI 会话生效。`);
    await loadPlugins();
  } catch (error) { setPluginOutput('插件安装失败：' + (error.message || error)); }
}

async function setPluginEnabled(id, enabled) {
  pluginWorkspaceHost?.invalidated(id);
  pluginFocusAfterRender = { id, selector: '[data-plugin-enable]' };
  try {
    const response = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(id)}/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '插件状态更新失败');
    setPluginOutput(`${data.plugin.name} 已${enabled ? '启用' : '停用'}。${enabled ? '插件工具将在后续 AI 请求中可用。' : ''}`);
    await loadPlugins();
  } catch (error) { setPluginOutput('插件状态更新失败：' + (error.message || error)); await loadPlugins(); }
}

async function runPluginAction(id, action) {
  pluginWorkspaceHost?.invalidated(id);
  if (action === 'remove' && !(await window.IexaDialogs.confirm('确定卸载这个插件吗？插件数据目录将保留。'))) return;
  if (action === 'reload') pluginFocusAfterRender = { id, selector: '[data-plugin-action="reload"]' };
  try {
    const response = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(id)}${action === 'remove' ? '' : `/${action}`}`, { method: action === 'remove' ? 'DELETE' : 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '插件操作失败');
    setPluginOutput(action === 'remove' ? '插件已卸载。' : `${data.plugin.name} 已重新读取清单与代码。`);
    await loadPlugins();
  } catch (error) { setPluginOutput('插件操作失败：' + (error.message || error)); }
}

async function invokePluginTool(id, tool, json) {
  let args;
  try { args = json.trim() ? JSON.parse(json) : {}; if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
  catch { setPluginOutput('工具参数必须是 JSON 对象。'); return; }
  try {
    setPluginOutput(`正在运行 ${tool}…`);
    const response = await fetch(`${API_BASE}/api/plugins/${encodeURIComponent(id)}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, arguments: args }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '插件工具执行失败');
    setPluginOutput(data.result);
  } catch (error) { setPluginOutput('插件工具执行失败：' + (error.message || error)); }
}

function initPluginPanel() {
  document.getElementById('pluginInstallBtn')?.addEventListener('click', installPlugin);
  document.getElementById('pluginOpenDirBtn')?.addEventListener('click', async () => {
    if (!pluginState.pluginsDir) await loadPlugins();
    if (pluginState.pluginsDir && window.iexaDesktop?.openPath) await window.iexaDesktop.openPath(pluginState.pluginsDir);
    else setPluginOutput(pluginState.pluginsDir || '插件目录尚未就绪。');
  });
  // The list is repainted after every mutation, so the empty state and the retry
  // affordance are handled by delegation rather than per-render listeners.
  document.getElementById('pluginList')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-plugin-install]')) { installPlugin(); return; }
    if (event.target.closest('[data-plugin-retry]')) loadPlugins();
  });
  document.getElementById('pluginConsoleClear')?.addEventListener('click', () => {
    document.getElementById('pluginConsole')?.setAttribute('hidden', '');
    const output = document.getElementById('pluginOutput');
    if (output) output.textContent = '';
  });
}

function connectPluginFrame(frame, pluginId) {
  return window.IexaPluginBridge.connect(frame, pluginId, { apiBase: API_BASE, context: () => ({ sessionId: currentSessionId || null }) });
}
