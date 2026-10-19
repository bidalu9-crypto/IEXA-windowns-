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
  if (output) output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function pluginToolEditor(plugin, tool) {
  return `<button type="button" class="plugin-tool-launch" data-plugin-tool-open="${escapeHtml(tool.name)}"><b>${escapeHtml(tool.name)}</b><span>${escapeHtml(tool.description || '')}</span><small>打开工具表单 →</small></button>`;
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

function renderPlugins(plugins) {
  const list = document.getElementById('pluginList');
  if (!list) return;
  document.getElementById('pluginCount').textContent = String(plugins.length);
  document.getElementById('pluginEnabledCount').textContent = String(plugins.filter((plugin) => plugin.enabled).length);
  document.getElementById('pluginToolCount').textContent = String(plugins.reduce((sum, plugin) => sum + (plugin.tools || []).length, 0));
  if (!plugins.length) {
    list.innerHTML = `<div class="plugin-empty"><span class="plugin-empty-icon">${uiIcon('box')}</span><strong>还没有安装拓展</strong><span>添加包含 iexa-plugin.json 的本地插件文件夹。</span></div>`;
    return;
  }
  list.innerHTML = plugins.map((plugin) => `<article class="plugin-card ${plugin.enabled ? 'is-enabled' : ''}" data-plugin-id="${escapeHtml(plugin.id)}">
    <div class="plugin-card-head">
      <span class="plugin-badge">${uiIcon('box')}</span>
      <span class="plugin-identity"><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.id)} · v${escapeHtml(plugin.version)}</small></span>
      <label class="plugin-toggle" title="${plugin.enabled ? '停用插件' : '启用插件'}"><input type="checkbox" data-plugin-enable ${plugin.enabled ? 'checked' : ''} ${plugin.error ? 'disabled' : ''}><span></span></label>
    </div>
    <p class="plugin-description">${escapeHtml(plugin.description || '没有插件描述。')}</p>
    <div class="plugin-card-meta"><span>${escapeHtml(plugin.author || '未知作者')}</span><span>${(plugin.tools || []).length} 个工具</span><span>${plugin.hasUI ? '包含界面' : '无界面'}</span></div>
    ${plugin.error ? `<div class="plugin-error">${uiIcon('alert')}<span>${escapeHtml(plugin.error)}</span></div>` : ''}
    ${(plugin.tools || []).length ? `<div class="plugin-tools">${plugin.tools.map((tool) => pluginToolEditor(plugin, tool)).join('')}</div>` : ''}
    ${plugin.hasUI ? `<button type="button" class="plugin-panel-launch btn-secondary" data-plugin-open ${!plugin.enabled || plugin.error ? 'disabled' : ''}>${uiIcon('box')}<span>打开拓展工作台</span><small>${plugin.contributions?.panels?.length || 1} 个面板</small></button>` : ''}
    <div class="plugin-card-actions"><button type="button" class="btn-secondary btn-sm" data-plugin-action="reload">${uiIcon('refresh')}<span>重载</span></button><button type="button" class="btn-secondary btn-sm plugin-remove" data-plugin-action="remove">${uiIcon('trash')}<span>卸载</span></button></div>
  </article>`).join('');

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
}

async function loadPlugins() {
  const list = document.getElementById('pluginList');
  if (list) list.innerHTML = '<div class="plugin-empty"><span class="plugin-loading"></span><strong>正在读取拓展</strong></div>';
  try {
    const response = await fetch(`${API_BASE}/api/plugins`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取插件失败');
    pluginState = { plugins: data.plugins || [], pluginsDir: data.pluginsDir || '' };
    renderPlugins(pluginState.plugins);
  } catch (error) {
    if (list) list.innerHTML = `<div class="plugin-empty plugin-error-text">${escapeHtml(error.message || String(error))}</div>`;
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
}

function connectPluginFrame(frame, pluginId) {
  return window.IexaPluginBridge.connect(frame, pluginId, { apiBase: API_BASE, context: () => ({ sessionId: currentSessionId || null }) });
}
