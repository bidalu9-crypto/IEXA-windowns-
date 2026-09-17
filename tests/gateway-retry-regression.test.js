const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderError } = require('../dist/main/providers/ProviderError');
const { RetryManager } = require('../dist/main/runtime/RetryManager');
const { readSSEFrames, fetchWithRetry, STREAM_RETRY_DELAYS_MS } = require('../dist/main/providers/stream-utils');
const { OpenAIProvider } = require('../dist/main/providers/OpenAIProvider');
const { AnthropicProvider } = require('../dist/main/providers/AnthropicProvider');
const { GeminiProvider } = require('../dist/main/providers/GeminiProvider');
const config = { model: 'fixture', apiKey: 'TEST', thinkingLevel: 'off' };
const providers = () => [new OpenAIProvider({ ...config, apiMode: 'chat_completions' }), new OpenAIProvider({ ...config, apiMode: 'responses' }), new AnthropicProvider(config), new GeminiProvider(config)];
async function collect(provider, signal) { const events = []; for await (const event of provider.streamMessage([{ role:'user', parts:[{type:'text',text:'hello'}]}], '', [], 100, signal)) events.push(event); return events; }
function chunks(text, size = 1) { const bytes = Buffer.from(text); return new ReadableStream({ start(c) { for(let i=0;i<bytes.length;i+=size)c.enqueue(bytes.subarray(i,i+size)); c.close(); } }); }

test('gateway classifier handles structured causes, bare transient phrases, and never mistakes counts for HTTP status', () => {
  for (const error of [new Error('Bad Gateway'), new Error('upstream connect error'), new Error('no healthy upstream'), { error:{type:'overloaded_error',message:'busy'} }, { cause: { code:'UND_ERR_SOCKET' } }, { statusCode:502 }, { error:{status:'UNAVAILABLE',message:'try again'} }, new Error('HTTP/1.1 503 Service Unavailable'), new Error('request 401 failed: bad gateway')]) assert.equal(ProviderError.from(error).retryable, true, JSON.stringify(error));
  for (const error of [{ status:401,message:'network timeout' }, {status:403,message:'bad gateway'}, {status:404,message:'upstream unavailable'}, {error:{code:'invalid_api_key',message:'overloaded'}}, {error:{code:'insufficient_quota'}}, new Error('model has 503 tokens'), Object.assign(new Error('timeout'),{name:'AbortError'})]) assert.equal(ProviderError.from(error).retryable, false, JSON.stringify(error));
  const circular = { message:'bad gateway' }; circular.cause=circular; assert.equal(ProviderError.from(circular).retryable,true);
});

test('all four providers reject HTTP-200 error frames with retained transient/permanent codes, including split event headers', async t => {
  const original=global.fetch; t.after(()=>global.fetch=original);
  for(const provider of providers()) {
    global.fetch=async()=>new Response(chunks('event: error\r\ndata:{"error":{"type":"overloaded_error","message":"网关繁忙"}}\r\n\r\n'));
    await assert.rejects(collect(provider), error=>error.retryable===true && error.message.includes('网关繁忙'));
    global.fetch=async()=>new Response(chunks('data: {"error":{"code":"invalid_api_key","message":"invalid key"}}'));
    await assert.rejects(collect(provider), error=>error.retryable===false);
    global.fetch=async()=>new Response('{"error":{"code":503,"message":"upstream unavailable"}}',{headers:{'content-type':'application/json'}});
    await assert.rejects(collect(provider), error=>error.retryable===true && error.status===503);
  }
});

test('SSE handles split UTF8, CRLF, multiline data and final frame without newline', async () => {
  const reader=chunks('event: error\r\ndata: {"error":\r\ndata: {"message":"中文😀"}}\r\n\r\ndata:{"done":true}').getReader();
  const frames=[];for await(const frame of readSSEFrames(reader))frames.push(frame);
  assert.equal(frames.length,2);assert.equal(frames[0].event,'error');assert.equal(JSON.parse(frames[0].data).error.message,'中文😀');assert.equal(JSON.parse(frames[1].data).done,true);
});

test('temporary SSE failure actually retries and completes; permanent errors and abort do not retry', async t => {
  const original=global.fetch;t.after(()=>global.fetch=original);let calls=0;
  global.fetch=async()=>{calls++;return new Response(calls===1?'data: {"error":{"code":"bad_gateway","message":"busy"}}\n\n':'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');};
  const notices=[];const result=await new RetryManager([0,0]).run(()=>collect(providers()[0]), n=>notices.push(n));
  assert.equal(calls,2);assert.deepEqual(notices,[1]);assert.equal(result.filter(e=>e.type==='textDelta').map(e=>e.text).join(''),'recovered');
  calls=0;global.fetch=async()=>{calls++;return new Response('data: {"error":{"code":"invalid_api_key"}}\n\n');};
  await assert.rejects(new RetryManager([0,0]).run(()=>collect(providers()[0])));assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(new RetryManager([0]).run(()=>collect(providers()[0]),undefined,controller.signal));assert.equal(calls,1);
});

test('HTTP 502 retries are bounded and permanent HTTP failures preserve status', async t => {
  const original=global.fetch,delays=[...STREAM_RETRY_DELAYS_MS];t.after(()=>{global.fetch=original;STREAM_RETRY_DELAYS_MS.splice(0,delays.length,...delays);});STREAM_RETRY_DELAYS_MS.fill(0);
  let calls=0;global.fetch=async()=>{calls++;return new Response('bad gateway',{status:502});};
  assert.equal((await fetchWithRetry('http://fixture',{},3)).status,502);assert.equal(calls,3);
  calls=0;global.fetch=async()=>{calls++;return new Response('{"error":{"message":"network timeout"}}',{status:401});};
  await assert.rejects(collect(providers()[0]),e=>e.status===401 && e.retryable===false);assert.equal(calls,1);
});

test('truncated and stalled streams do not silently succeed and cancellation promptly releases read', async t => {
  const original=global.fetch;t.after(()=>global.fetch=original);
  for(const provider of providers()) { global.fetch=async()=>new Response('');await assert.rejects(collect(provider),e=>e.retryable===true); }
  let cancelled=false;global.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
  const controller=new AbortController(),pending=collect(providers()[0],controller.signal);setTimeout(()=>controller.abort(),10);
  await assert.rejects(pending);assert.equal(cancelled,true);
});

test('quota exhaustion is permanent while output token limit is a completed response, not a gateway retry',async t=>{
 const original=global.fetch;t.after(()=>global.fetch=original);
 assert.equal(ProviderError.http(429,'{"error":{"code":"insufficient_quota"}}').retryable,false);
 global.fetch=async()=>new Response('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n');
 const events=await collect(providers()[1]);assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).stopReason,'maxTokens');
});
