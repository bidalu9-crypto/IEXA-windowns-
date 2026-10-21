// Balance must follow the profile the user actually selected, and a profile
// that still carries a `$secretRef` must never be sent to a gateway.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-balance-active-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
process.env.IEXA_WORKSPACE = workspace;

const backend = require('../dist/main/server');
const { fetchProviderBalance } = require('../dist/main/providers/BalanceService');

let server, upstream, endpoint, token, upstreamPort;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const auth = req.headers.authorization || '';
    // Only the pool endpoint answers; everything else is a 404 so the probe
    // chain has to walk past it.
    if (url === '/status') {
      if (!auth.startsWith('Bearer sk-good')) { res.statusCode = 401; res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accounts: [{ credits: 5000, credits_total: 10000 }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;

  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});

test.after(async () => {
  for (const target of [server, upstream]) if (target) { target.closeAllConnections(); await new Promise((r) => target.close(r)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function api(route, method = 'GET', data) {
  const response = await fetch(endpoint + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test('the balance endpoint follows the selected profile, not the first one', async () => {
  const relay = `http://127.0.0.1:${upstreamPort}/v1`;
  const first = await api('/api/profiles', 'POST', {
    id: 'first', provider: 'custom', model: 'no-balance', apiKey: 'sk-plain',
    baseURL: relay, contextWindow: 128000, maxOutputTokens: 512,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await api('/api/profiles', 'POST', {
    id: 'second', provider: 'custom', model: 'has-balance', apiKey: 'sk-good',
    baseURL: relay, contextWindow: 128000, maxOutputTokens: 512,
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));

  // Selecting the second profile must move the balance readout with it.
  const patched = await api('/api/profiles', 'PUT', { activeProfileId: 'second' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const listed = await api('/api/profiles');
  assert.equal(listed.body.activeProfileId, 'second', 'the settings endpoint reports the selection');

  const active = await api('/api/profiles/second/balance');
  assert.equal(active.body.status, 'ok', JSON.stringify(active.body));
  assert.equal(active.body.remaining, 5000);
  assert.equal(active.body.currency, 'credits');

  const inactive = await api('/api/profiles/first/balance');
  assert.equal(inactive.body.status, 'unsupported', 'the other profile still has nothing to report');
});

test('a profile that still holds a secret reference is refused, not sent', async () => {
  const relay = `http://127.0.0.1:${upstreamPort}/v1`;
  // This is what an un-hydrated profile looks like: the vault reference object.
  const stale = await fetchProviderBalance({
    id: 'stale', provider: 'custom', model: 'm', baseURL: relay,
    apiKey: { $secretRef: 'vault:abc' },
  }, { force: true });
  assert.equal(stale.status, 'unsupported');
  assert.match(stale.message, /密钥/);
  // `[object Object]` would have produced a 401 from the pool endpoint instead.
  assert.doesNotMatch(String(stale.message), /未提供余额接口/);
});

test('the insights page reads the same active profile the settings report', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/services/UsageInsightsView.js'), 'utf8');
  assert.match(view, /profiles\.activeProfileId \|\| profiles\.activeId/, 'both spellings are accepted');
  assert.match(view, /formatInsightBalance\(data\.remaining, data\.currency\)/, 'the chip formats by currency');
  assert.doesNotMatch(view, /余额 \$\{formatInsightCost/, 'the chip no longer forces the cost symbol');
});
