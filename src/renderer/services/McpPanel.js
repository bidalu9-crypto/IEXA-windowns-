// =============================================================================
// MCP panel
//
// MCP server list, resource reader, tool runner and the argument parser.
//
// Classic script, split out of services/FilesPanel.js. Top-level declarations
// stay in the global lexical scope; index.html fixes the load order and this
// file runs nothing when it is evaluated.
// =============================================================================
function setMcpOutput(value) {
  const output = document.getElementById('mcpOutput');
  if (output) output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function renderMcpServers(servers) {
  const list = document.getElementById('mcpServerList');
  if (!list) return;
  if (!servers.length) {
    list.innerHTML = '<div class="workbench-empty">还没有配置 MCP Server。</div>';
    return;
  }
  list.innerHTML = servers.map((server) => {
    const tools = (server.tools || []).map((tool) => `<button type="button" class="mcp-tool" data-mcp-call="${escapeHtml(tool.name)}" title="${escapeHtml(tool.description || tool.name)}">${escapeHtml(tool.name)}</button>`).join('');
    const resources = (server.resources || []).map((resource) => `<button type="button" class="mcp-tool" data-mcp-resource="${escapeHtml(resource.uri)}" title="${escapeHtml(resource.uri)}">${escapeHtml(resource.name || resource.uri)}</button>`).join('');
    const logs = (server.logs || []).join('\n');
    return `<article class="mcp-server-card" data-mcp-server="${escapeHtml(server.id)}">
      <div class="mcp-server-head"><strong>${escapeHtml(server.name)}</strong><span class="mcp-state ${escapeHtml(server.status)}">${escapeHtml(server.status)}</span></div>
      <div class="mcp-server-meta">${escapeHtml(server.transport === 'http' ? server.url : `${server.command || ''} ${(server.args || []).join(' ')}`)}</div>
      ${server.error ? `<div class="mcp-server-error">${escapeHtml(server.error)}</div>` : ''}
      <div class="mcp-server-actions">
        <button type="button" data-mcp-action="connect">连接</button>
        <button type="button" data-mcp-action="disconnect">断开</button>
        <button type="button" data-mcp-action="remove">删除</button>
      </div>
      ${tools ? `<div class="mcp-tools">${tools}</div>` : ''}
      ${resources ? `<div class="mcp-tools mcp-resources">${resources}</div>` : ''}
      ${logs ? `<details class="mcp-logs"><summary>日志</summary><pre>${escapeHtml(logs)}</pre></details>` : ''}
    </article>`;
  }).join('');
  list.querySelectorAll('.mcp-server-card').forEach((card) => {
    const id = card.dataset.mcpServer;
    card.querySelectorAll('[data-mcp-action]').forEach((button) => button.addEventListener('click', () => runMcpAction(id, button.dataset.mcpAction)));
    card.querySelectorAll('[data-mcp-call]').forEach((button) => button.addEventListener('click', () => callMcpTool(id, button.dataset.mcpCall)));
    card.querySelectorAll('[data-mcp-resource]').forEach((button) => button.addEventListener('click', () => readMcpResource(id, button.dataset.mcpResource)));
  });
}

async function loadMcpServers() {
  const list = document.getElementById('mcpServerList');
  if (list) list.innerHTML = '<div class="workbench-empty">正在加载 MCP Server…</div>';
  try {
    const response = await fetch(`${API_BASE}/api/mcp/servers`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 MCP Server 失败');
    renderMcpServers(data.servers || []);
  } catch (error) {
    if (list) list.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

async function runMcpAction(id, action) {
  if (!id || !action) return;
  if (action === 'remove' && !(await window.IexaDialogs.confirm('确定删除这个 MCP Server 配置吗？'))) return;
  try {
    const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}${action === 'remove' ? '' : `/${action}`}`, { method: action === 'remove' ? 'DELETE' : 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'MCP 操作失败');
    if (data.server?.logs?.length) setMcpOutput(data.server.logs.join('\n'));
    await loadMcpServers();
  } catch (error) {
    setMcpOutput('MCP 操作失败：' + (error.message || error));
  }
}

async function callMcpTool(id, name) {
  if (!id || !name) return;
  const raw = (await window.IexaDialogs.prompt(`调用 ${name}\n输入 JSON 参数（留空表示 {}）：`, '{}'));
  if (raw === null) return;
  let args;
  try { args = raw.trim() ? JSON.parse(raw) : {}; } catch { setMcpOutput('参数 JSON 无效。'); return; }
  try {
    setMcpOutput(`正在调用 ${name}…`);
    const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'MCP 工具调用失败');
    setMcpOutput(data.result);
    await loadMcpServers();
  } catch (error) {
    setMcpOutput('MCP 工具调用失败：' + (error.message || error));
  }
}

async function readMcpResource(id, uri) {
  if (!id || !uri) return;
  try {
    setMcpOutput(`正在读取资源 ${uri}…`);
    const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}/resource`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 MCP Resource 失败');
    setMcpOutput(data.result);
  } catch (error) {
    setMcpOutput('读取 MCP Resource 失败：' + (error.message || error));
  }
}

function parseMcpArgs(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return (text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((part) => part.replace(/^("|')|("|')$/g, ''));
}

function initMcpPanel() {
  const form = document.getElementById('mcpAddForm');
  const transport = document.getElementById('mcpTransport');
  const command = document.getElementById('mcpCommand');
  const args = document.getElementById('mcpArgs');
  const url = document.getElementById('mcpUrl');
  const syncTransport = () => {
    const http = transport?.value === 'http';
    if (command) { command.style.display = http ? 'none' : ''; command.required = !http; }
    if (args) args.style.display = http ? 'none' : '';
    if (url) { url.style.display = http ? '' : 'none'; url.required = http; }
  };
  transport?.addEventListener('change', syncTransport);
  syncTransport();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(`${API_BASE}/api/mcp/servers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: document.getElementById('mcpName')?.value || '', transport: transport?.value, command: command?.value || '', args: parseMcpArgs(args?.value), url: url?.value || '' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '添加 MCP Server 失败');
      form.reset(); syncTransport(); setMcpOutput(`已添加 ${data.server.name}。`); await loadMcpServers();
    } catch (error) { setMcpOutput('添加 MCP Server 失败：' + (error.message || error)); }
  });
}
