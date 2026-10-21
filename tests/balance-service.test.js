// Provider balances arrive in four incompatible shapes. The service must read
// each one, never invent a number, and cache so a composer chip cannot hammer
// the gateway.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchProviderBalance, clearBalanceCache } = require('../dist/main/providers/BalanceService');

let server, base;
const hits = { subscription: 0, usage: 0, deepseek: 0, credits: 0, pool: 0 };

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/relay/dashboard/billing/subscription') {
      hits.subscription++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'billing_subscription', hard_limit_usd: 12.34, soft_limit_usd: 12.34 }));
      return;
    }
    if (url === '/relay/dashboard/billing/usage') {
      hits.usage++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', total_usage: 320 }));
      return;
    }
    if (url === '/deep/user/balance') {
      hits.deepseek++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '8.50', granted_balance: '2.00', topped_up_balance: '6.50' }],
      }));
      return;
    }
    if (url === '/api/v1/credits') {
      hits.credits++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { total_credits: 20, total_usage: 5 } }));
      return;
    }
    if (url === '/wb/status') {
      hits.pool++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        total: 3,
        healthy: 2,
        cooling: 1,
        disabled: 0,
        accounts: [
          { uid: 'a1', credits: 812, credits_total: 2000, cooling: false },
          { uid: 'a2', credits: 150, credits_total: 500, cooling: true },
          { uid: 'a3', credits: 40, cooling: false, disabled: true },
        ],
      }));
      return;
    }
    if (url === '/plain/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'something-else' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => clearBalanceCache());

test('an OpenAI-compatible relay reports its allowance and usage separately', async () => {
  const result = await fetchProviderBalance({
    id: 'relay', provider: 'custom', apiKey: 'sk-test', baseURL: `${base}/relay/v1`,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.currency, 'USD');
  assert.equal(result.remaining, 12.34);
  assert.equal(result.used, 3.2, 'total_usage is cents');
  assert.match(result.source, /账单/);
});

test('DeepSeek balance keeps granted and topped-up apart', async () => {
  const result = await fetchProviderBalance({
    id: 'deep', provider: 'deepseek', apiKey: 'sk-deep', baseURL: `${base}/deep/v1`,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.remaining, 8.5);
  assert.equal(result.granted, 2);
  assert.equal(result.toppedUp, 6.5);
});

test('OpenRouter credits subtract usage from the purchased total', async () => {
  const result = await fetchProviderBalance({
    id: 'or', provider: 'custom', apiKey: 'sk-or',
    // The host is not openrouter.ai, so this exercises the generic /v1/credits route.
    baseURL: `${base}/v1`,
  });
  assert.equal(result.status, 'unsupported', 'no credits route on this fixture');

  const direct = await fetchProviderBalance({
    id: 'or2', provider: 'custom', apiKey: 'sk-or', baseURL: `${base}/api/v1`,
  });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.remaining, 15);
  assert.equal(direct.used, 5);
  assert.equal(direct.total, 20);
});

test('a WorkBuddy pool gateway reports its pool credits as the balance', async () => {
  const result = await fetchProviderBalance({
    id: 'wb', provider: 'custom', apiKey: 'sk-wb', baseURL: `${base}/wb/v1`,
  });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.currency, 'credits');
  assert.equal(result.remaining, 1002, 'credits sum across the pool');
  assert.equal(result.total, 2500);
  assert.equal(result.used, 1498);
  assert.match(result.source, /账号池/);
  assert.match(result.source, /3 个账号/);
  assert.match(result.source, /1 个可用/, 'cooling and disabled accounts are counted separately');
});

test('an unrelated 200 at /status is not mistaken for a pool', async () => {
  const result = await fetchProviderBalance({
    id: 'plain', provider: 'custom', apiKey: 'sk-plain', baseURL: `${base}/plain/v1`,
  });
  assert.equal(result.status, 'unsupported', 'no accounts array means no reading');
});

test('a gateway without a balance route stays unsupported instead of guessing', async () => {
  const result = await fetchProviderBalance({
    id: 'none', provider: 'custom', apiKey: 'sk-none', baseURL: `${base}/missing/v1`,
  });
  assert.equal(result.status, 'unsupported');
  assert.ok(result.message);
});

test('a missing key is never sent anywhere', async () => {
  const before = hits.subscription + hits.usage + hits.deepseek + hits.credits;
  const result = await fetchProviderBalance({ id: 'nokey', provider: 'custom', baseURL: `${base}/relay/v1` });
  assert.equal(result.status, 'unsupported');
  assert.equal(hits.subscription + hits.usage + hits.deepseek + hits.credits, before);
});

test('the cache absorbs repeated reads and force bypasses it', async () => {
  const profile = { id: 'cache', provider: 'custom', apiKey: 'sk-test', baseURL: `${base}/relay/v1` };
  await fetchProviderBalance(profile);
  const afterFirst = hits.subscription;
  await fetchProviderBalance(profile);
  assert.equal(hits.subscription, afterFirst, 'second read comes from cache');
  await fetchProviderBalance(profile, { force: true });
  assert.equal(hits.subscription, afterFirst + 1, 'force refreshes');
});

test('a slow or dead endpoint resolves as unsupported within the timeout', async () => {
  const started = Date.now();
  const result = await fetchProviderBalance({
    id: 'dead', provider: 'custom', apiKey: 'sk-test', baseURL: 'http://127.0.0.1:9/v1',
  });
  assert.equal(result.status, 'unsupported');
  assert.ok(Date.now() - started < 9000, 'three parallel attempts share one timeout window');
});
