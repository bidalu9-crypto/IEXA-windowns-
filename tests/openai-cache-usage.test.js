'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { OpenAIProvider } = require('../dist/main/providers/OpenAIProvider');

/* Prompt-cache observability: OpenAI-compatible gateways report cache hits in
   several dialects (DeepSeek prompt_cache_hit_tokens, OpenAI
   prompt_tokens_details.cached_tokens). The provider must surface them as
   cacheReadInputTokens so a dead prefix cache becomes visible in the usage
   ledger instead of silently re-billing the full prompt every call. */

const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
const done = 'data: [DONE]\n\n';
const input = [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }];

async function fixture(t, body) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let source = '';
    for await (const chunk of req) source += chunk;
    requests.push({ path: req.url, body: JSON.parse(source) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseURL: `http://127.0.0.1:${server.address().port}`, requests };
}

async function usageEvents(provider) {
  const events = [];
  for await (const event of provider.streamMessage(input, 'system', [], 4096)) events.push(event);
  return events;
}

test('DeepSeek prompt_cache_hit_tokens reach the usage event', async t => {
  const f = await fixture(t, frame({ choices: [{ delta: { content: 'ok' } }] })
    + frame({ choices: [], usage: { prompt_tokens: 4096, completion_tokens: 12, prompt_cache_hit_tokens: 3072, prompt_cache_miss_tokens: 1024 } })
    + done);
  const provider = new OpenAIProvider({ model: 'deepseek-v4.1-flash', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'off' });
  const events = await usageEvents(provider);
  assert.equal(f.requests[0].path, '/v1/chat/completions');
  const usage = events.find(event => event.type === 'usage').usage;
  // The provider's prompt_tokens INCLUDE the cached span: 4096 total, 3072 of it
  // cached, so the fresh input is 1024. One meaning across providers keeps the
  // cache share (cache / (input + cache)) and the cost estimate honest.
  assert.deepEqual(usage, { inputTokens: 4096, outputTokens: 12, cacheReadInputTokens: 3072 });
  assert.equal(events.at(-1).type, 'done');
});

test('OpenAI prompt_tokens_details.cached_tokens reach the usage event', async t => {
  const f = await fixture(t, frame({ choices: [], usage: { prompt_tokens: 2048, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1536 } } }) + done);
  const provider = new OpenAIProvider({ model: 'gpt-6-pro', apiKey: 'fixture-key', baseURL: f.baseURL, thinkingLevel: 'off' });
  const usage = (await usageEvents(provider)).find(event => event.type === 'usage').usage;
  assert.deepEqual(usage, { inputTokens: 2048, outputTokens: 4, cacheReadInputTokens: 1536 });
});

test('a genuinely zero hit count is reported explicitly, absent fields stay absent', async t => {
  const zero = await fixture(t, frame({ choices: [], usage: { prompt_tokens: 512, completion_tokens: 4, prompt_cache_hit_tokens: 0 } }) + done);
  const zeroUsage = (await usageEvents(new OpenAIProvider({ model: 'deepseek-v4.1-flash', apiKey: 'k', baseURL: zero.baseURL, thinkingLevel: 'off' })))
    .find(event => event.type === 'usage').usage;
  assert.deepEqual(zeroUsage, { inputTokens: 512, outputTokens: 4, cacheReadInputTokens: 0 });

  const plain = await fixture(t, frame({ choices: [], usage: { prompt_tokens: 512, completion_tokens: 4 } }) + done);
  const plainUsage = (await usageEvents(new OpenAIProvider({ model: 'relay-model', apiKey: 'k', baseURL: plain.baseURL, thinkingLevel: 'off' })))
    .find(event => event.type === 'usage').usage;
  assert.deepEqual(plainUsage, { inputTokens: 512, outputTokens: 4 });
  assert.equal('cacheReadInputTokens' in plainUsage, false);
});

test('the cached span is always a subset of the reported prompt', async t => {
  // The share on screen is cache / input, so this invariant is what makes the
  // number meaningful: a cache larger than the prompt would render over 100%.
  const f = await fixture(t, frame({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 3, prompt_cache_hit_tokens: 400 } }) + done);
  const usage = (await usageEvents(new OpenAIProvider({ model: 'relay-model', apiKey: 'k', baseURL: f.baseURL, thinkingLevel: 'off' })))
    .find(event => event.type === 'usage').usage;
  assert.equal(usage.inputTokens, 900);
  assert.ok(usage.cacheReadInputTokens <= usage.inputTokens, 'cache must sit inside the prompt');
});

test('a cache hint larger than the prompt cannot exceed the prompt budget', async t => {
  const f = await fixture(t, frame({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 2, prompt_cache_hit_tokens: 9999 } }) + done);
  const usage = (await usageEvents(new OpenAIProvider({ model: 'relay-model', apiKey: 'k', baseURL: f.baseURL, thinkingLevel: 'off' })))
    .find(event => event.type === 'usage').usage;
  assert.deepEqual(usage, { inputTokens: 300, outputTokens: 2, cacheReadInputTokens: 300 });
});
