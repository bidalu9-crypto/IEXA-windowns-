'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

// Fixture data lives only beneath the harness's isolated run directory. It is
// never copied into the installed plugin directory by this module: installation
// must be performed through IEXA's real directory picker.
async function prepareData(h) {
  const fixtureRoot = path.resolve(h.report.fixture.root);
  const source = path.join(fixtureRoot, 'component-plugin-source');
  assert.ok(source.startsWith(fixtureRoot + path.sep));
  fs.mkdirSync(source, { recursive: true });
  const plugin = { id: 'component-pages-fixture', name: 'Component Pages Fixture', version: '1.0.0', description: 'Local desktop acceptance fixture', ui: 'panel.html', tools: [] };
  fs.writeFileSync(path.join(source, 'iexa-plugin.json'), JSON.stringify(plugin, null, 2));
  fs.writeFileSync(path.join(source, 'panel.html'), '<!doctype html><meta charset="utf-8"><title>Component Fixture</title><h1>PLUGIN_COMPONENT_RECEIPT</h1><p>Installed through the actual IEXA plugin picker.</p>');
  const requests = [];
  let origin;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) { res.writeHead(413); res.end(); return; } }
    if (req.url.startsWith('/webdav')) { requests.push({ method: req.method, path: req.url }); res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'COMPONENT_WEBDAV_UNAVAILABLE' })); return; }
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); res.end(); return; }
    requests.push({ method: req.method, path: req.url, rpc: body.method, arguments: body.params?.arguments });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/market.json') { res.end(JSON.stringify({ version: 1, title: 'Component fixture market', plugins: [{ ...plugin, tags: ['component-fixture'], download: origin + '/intentionally-unavailable.zip' }] })); return; }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404); res.end(JSON.stringify({ error: 'Fixture route not found' })); return; }
    if (body.id === undefined) { res.writeHead(204); res.end(); return; }
    const text = 'MCP_COMPONENT_RECEIPT ' + String(body.params?.arguments?.text || '');
    const results = {
      initialize: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Component HTTP MCP fixture', version: '1.0.0' } },
      'tools/list': { tools: [{ name: 'component_echo', description: 'Return a local fixture receipt', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] },
      'resources/list': { resources: [{ uri: 'fixture://component', name: 'Component fixture resource', mimeType: 'text/plain' }] },
      'tools/call': { content: [{ type: 'text', text }], isError: false },
      'resources/read': { contents: [{ uri: 'fixture://component', mimeType: 'text/plain', text: 'MCP_RESOURCE_COMPONENT_RECEIPT' }] },
      ping: {},
    };
    if (!(body.method in results)) { res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } })); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  Object.assign(h.report.fixture, { componentPluginSource: source, componentPluginId: plugin.id, componentMcpUrl: origin + '/mcp', componentMarketUrl: origin + '/market.json', componentWebdavUrl: origin + '/webdav' });
  h.save();
  return { source, plugin, origin, requests, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { prepareData };
