'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionManager } = require('../dist/main/security/PermissionManager');
const { redactSecretValues } = require('../dist/main/errors/IexaError');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-audit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function tool(name = 'mcp_fixture') {
  return { name, description: 'fixture', parameters: {}, required: [], risk: 'medium', parallelSafe: false, cancellable: true, requiresApproval: true, execute: async () => ({ success: true, output: 'ok' }) };
}

test('permission audit redacts nested and JSON-string encoded secrets', async (t) => {
  const auditDir = fixture(t);
  const manager = new PermissionManager(auditDir, async () => 'allow_once', 'ask');
  const argumentsJson = JSON.stringify({ password: 'TOPSECRET', token: 'TOKSECRET', nested: { api_key: 'KEYSECRET', safe: 'visible' } });
  await manager.authorize({ sessionId: 'session', tool: tool(), args: {
    arguments_json: argumentsJson,
    access_token: 'ACCESSSECRET',
    nested: { cookie: 'COOKIESECRET', safe: 'kept' },
  }, signal: new AbortController().signal });
  const text = fs.readFileSync(path.join(auditDir, 'security-audit.jsonl'), 'utf8');
  for (const secret of ['TOPSECRET', 'TOKSECRET', 'KEYSECRET', 'ACCESSSECRET', 'COOKIESECRET']) assert.equal(text.includes(secret), false, `audit leaked ${secret}`);
  const record = JSON.parse(text.trim());
  assert.equal(record.args.access_token, '[REDACTED]');
  assert.equal(record.args.nested.cookie, '[REDACTED]');
  assert.equal(record.args.nested.safe, 'kept');
  const embedded = JSON.parse(record.args.arguments_json);
  assert.equal(embedded.password, '[REDACTED]'); assert.equal(embedded.token, '[REDACTED]');
  assert.equal(embedded.nested.api_key, '[REDACTED]'); assert.equal(embedded.nested.safe, 'visible');
});

test('redaction handles arrays, malformed JSON strings and depth safely', () => {
  const result = redactSecretValues({ items: [{ authorization: 'Bearer secret', note: 'api_key=PLAINTEXT' }], malformed: '{"password":' });
  assert.equal(result.items[0].authorization, '[REDACTED]');
  assert.equal(result.items[0].note.includes('PLAINTEXT'), false);
  assert.equal(result.malformed, '{"password":');
  let deep = {}; let cursor = deep; for (let i = 0; i < 20; i++) cursor = cursor.next = {};
  assert.doesNotThrow(() => redactSecretValues(deep));
});
