const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AnthropicProvider } = require('../dist/main/providers/AnthropicProvider');
const { maxThinkingLevel } = require('../dist/main/providers/ModelCapabilities');

const frame = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
async function fixture(t, responder) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let source = '';
    for await (const chunk of req) source += chunk;
    const body = JSON.parse(source);
    requests.push({ body, path: req.url, headers: req.headers });
    responder(body, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseURL: `http://127.0.0.1:${server.address().port}`, requests };
}
const input = [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }];

// The official Messages endpoint returns a JSON object unless stream:true is set.
test('Claude Messages API request streams, waits for message_stop and uses adaptive thinking for Opus 5.5', async t => {
  const f = await fixture(t, (body, res) => {
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: '你好！' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } })
      + frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好！' } })
      + frame('content_block_stop', { index: 0 })
      + frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
      + frame('message_stop', {}));
  });
  const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'medium' });
  const events = [];
  for await (const event of provider.streamMessage(input, 'system', [], 2048)) events.push(event);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/messages');
  assert.equal(f.requests[0].headers['anthropic-beta'], undefined);
  assert.equal(f.requests[0].headers['x-api-key'], 'fixture-key');
  assert.equal(f.requests[0].body.stream, true);
  assert.equal(f.requests[0].body.thinking, undefined); // Opus 5.5 uses adaptive by default
  assert.deepEqual(f.requests[0].body.output_config, { effort: 'medium' });
  assert.equal(events.find(event => event.type === 'textDelta').text, '你好！');
  assert.deepEqual(events.find(event => event.type === 'usage').usage, { inputTokens: 5, outputTokens: 8 });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'endTurn' });
  assert.equal(maxThinkingLevel('anthropic', 'claude-opus-5-5'), 'max');
});

test('Claude tool_use retains signed thinking for tool-result continuation', async t => {
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame('message_start', { message: { usage: { input_tokens: 2, output_tokens: 1 } } })
      + frame('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-fixture' } })
      + frame('content_block_stop', { index: 0 })
      + frame('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'shell_execute', input: {} } })
      + frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"echo ok"}' } })
      + frame('content_block_stop', { index: 1 })
      + frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } })
      + frame('message_stop', {}));
  });
  const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'medium' });
  const events = [];
  for await (const event of provider.streamMessage(input, 'system', [], 1024)) events.push(event);
  const thinking = events.find(e => e.type === 'thinkingBlockComplete').block;
  assert.deepEqual(thinking, { type: 'thinking', thinking: 'plan', signature: 'sig-fixture' });
  assert.deepEqual(events.find(e => e.type === 'toolCallComplete').args, { command: 'echo ok' });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'toolUse' });
  const next = provider.convertMessages([
    { role: 'assistant', parts: [{ type: 'toolUse', id: 'call-1', name: 'shell_execute', input: { command: 'echo ok' } }], thinkingBlocks: [thinking] },
    { role: 'user', parts: [{ type: 'toolResult', id: 'call-1', name: 'shell_execute', content: 'ok', isError: false }] },
  ]);
  assert.deepEqual(next[0].content[0], thinking);
  assert.equal(next[0].content[1].type, 'tool_use');
  assert.equal(next[1].content[0].tool_use_id, 'call-1');
});

test('Claude HTTP 200 JSON error is reported as provider error rather than incomplete stream', async t => {
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model parameter' } }));
  });
  const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'off' });
  await assert.rejects(async () => {
    for await (const _event of provider.streamMessage(input, '', [], 1024)) { /* drain */ }
  }, /bad model parameter/);
});

test('a truncated Claude stream fails instead of reporting successful completion', async t => {
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame('message_start', { message: { usage: { input_tokens: 2, output_tokens: 0 } } })
      + frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }));
  });
  const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'off' });
  await assert.rejects(async () => {
    for await (const _event of provider.streamMessage(input, '', [], 1024)) { /* drain */ }
  }, /terminated before completion/);
});


test('Claude-compatible JSON gateway response yields content and tool calls', async t => {
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', usage: { input_tokens: 4, output_tokens: 7 }, stop_reason: 'tool_use', content: [
      { type: 'text', text: 'ready' }, { type: 'tool_use', id: 'use-1', name: 'test', input: { key: 1 } },
    ] }));
  });
  const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'off' });
  const events = [];
  for await (const event of provider.streamMessage(input, '', [], 1024)) events.push(event);
  assert.equal(events.find(e => e.type === 'textDelta').text, 'ready');
  assert.deepEqual(events.find(e => e.type === 'toolCallComplete').args, { key: 1 });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'toolUse' });
  assert.deepEqual(f.requests[0].body.output_config, { effort: 'low' });
});


test('Anthropic base URL accepts origin, /v1, and full /v1/messages without duplicating path', async t => {
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  });
  for (const suffix of ['', '/v1/', '/v1/messages']) {
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'fixture-key', baseURL: f.baseURL + suffix, thinkingLevel: 'off' });
    const events = [];
    for await (const event of provider.streamMessage(input, '', [], 1024)) events.push(event);
    assert.equal(events.find(e => e.type === 'textDelta').text, 'OK');
  }
  assert.deepEqual(f.requests.map(r => r.path), ['/v1/messages', '/v1/messages', '/v1/messages']);
});


test('restored Anthropic tool history does not replay calls without their thinking signatures', () => {
  const { AgentLoop } = require('../dist/main/agent/AgentLoop');
  const saved = [{ role: 'assistant', content: 'done', toolCalls: [
    { id: 'old', name: 'shell_execute', args: { command: 'echo ok' }, result: { success: true, output: 'ok' } },
  ] }];
  const anthro = AgentLoop.prototype.hydrateSavedTurn.call({ config: { provider: { name: 'anthropic' } } }, saved);
  assert.ok(anthro.some(m => m.parts.some(p => p.type === 'text' && p.text.includes('shell_execute'))));
  assert.ok(anthro.every(m => m.parts.every(p => p.type !== 'toolUse' && p.type !== 'toolResult')));
  const other = AgentLoop.prototype.hydrateSavedTurn.call({ config: { provider: { name: 'openai' } } }, saved);
  assert.ok(other.some(m => m.parts.some(p => p.type === 'toolUse')));
  assert.ok(other.some(m => m.parts.some(p => p.type === 'toolResult')));
});


test('Claude 4.6 avoids unsupported xhigh effort; Opus 5.5 retains it', async t => {
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  });
  for (const model of ['claude-sonnet-4-6', 'claude-opus-5-5']) {
    const p = new AnthropicProvider({ model, apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'xhigh' });
    for await (const _event of p.streamMessage(input, '', [], 2048)) { /* drain */ }
  }
  assert.deepEqual(f.requests.map(r => r.body.output_config.effort), ['high', 'xhigh']);
  assert.deepEqual(f.requests[0].body.thinking, { type: 'adaptive' });
  assert.equal(f.requests[1].body.thinking, undefined);
});
