/* A deterministic MCP protocol fixture, NOT an actual desktop backend. */
const readline = require('node:readline');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize': result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'IEXA screenshot-contract-fixture', version: '1' } }; break;
    case 'tools/list': result = { tools: [{ name: 'snapshot', description: 'Fixture screenshot', inputSchema: { type: 'object', properties: {} } }] }; break;
    case 'resources/list': result = { resources: [] }; break;
    case 'tools/call': result = { isError: request.params.arguments.fail === true, content: [{ type: 'text', text: 'FIXTURE_ONLY: snapshot contract, no software controlled' }, { type: 'image', data: png, mimeType: 'image/png' }, { type: 'image', data: png, mimeType: 'image/png' }], structuredContent: { fixture: true } }; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
