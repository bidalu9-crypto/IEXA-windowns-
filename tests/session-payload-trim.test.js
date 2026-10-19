'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.IEXA_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-trim-'));
const { clientFileChange, clientMessages } = require('../dist/main/server');

test('clientFileChange strips rollback bytes and keeps an undo gate flag', () => {
  const change = { path: 'a.js', added: 1, removed: 2, before: 'x', after: 'y', rollback: { version: 1, beforeBase64: 'QQ==' } };
  const client = clientFileChange(change);
  assert.equal(client.path, 'a.js');
  assert.equal(client.before, 'x');
  assert.equal(client.after, 'y');
  assert.equal(client.rollback, undefined);
  assert.equal(client.hasRollback, true);
  assert.equal(change.rollback.beforeBase64, 'QQ=='); // source object untouched
  const legacy = clientFileChange({ path: 'b.js' });
  assert.equal(legacy.hasRollback, false);
  assert.equal(clientFileChange(null), null);
  assert.equal(clientFileChange(undefined), undefined);
});

test('clientMessages trims only tool calls that carry a fileChange', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'c1', name: 'file_edit', args: {}, result: { output: 'ok', fileChange: { path: 'a.js', rollback: { beforeBase64: 'QQ==' } } } },
      { id: 'c2', name: 'shell_execute', args: {}, result: { output: 'done' } },
    ] },
  ];
  const out = clientMessages(messages);
  assert.equal(out[0], messages[0]); // plain message keeps its reference
  assert.equal(out[1].toolCalls[1], messages[1].toolCalls[1]); // call without fileChange untouched
  const fileChange = out[1].toolCalls[0].result.fileChange;
  assert.equal(fileChange.rollback, undefined);
  assert.equal(fileChange.hasRollback, true);
  assert.equal(messages[1].toolCalls[0].result.fileChange.rollback.beforeBase64, 'QQ==');
});

test('server wires the trim into the GET route and the tool_result stream', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/server.ts'), 'utf8');
  // The route also carries the session's context accounting so the ring can be
  // painted before the first turn; the trim itself must still be applied.
  assert.match(src, /jsonReply\(res, 200, \{ messages: clientMessages\(msgs\), session, context: sessionContextStatus\(sid\) \}\)/);
  assert.match(src, /fileChange: r\.fileChange \? clientFileChange\(r\.fileChange\) : undefined/);
  assert.match(src, /export function clientFileChange/);
  assert.match(src, /export function clientMessages/);
});
