const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const tempDir = require('./helpers/temp-dir');
const path = require('node:path');
const { SessionSearchIndex, tokenize } = require('../dist/main/search/SessionSearchIndex');

function fixture() {
  const root = tempDir.make('iexa-search-');
  const sessions = path.join(root, 'sessions');
  const index = path.join(root, 'index');
  fs.mkdirSync(sessions, { recursive: true });
  return { root, sessions, index };
}

function writeSession(dir, id, messages) {
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(messages));
  return file;
}

function source(id, filePath, title, updated = Date.now()) {
  return { id, title, updated, filePath };
}

test('indexes prose and finds it', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_a', [
    { role: 'user', content: '帮我做一个 SQL 注入测试', timestamp: 1000 },
    { role: 'assistant', content: '好的，下面是注入测试流程与边界说明。', timestamp: 2000 },
  ]);
  const idx = new SessionSearchIndex(index);
  const stats = idx.sync([source('sess_a', file, '注入测试')]);
  assert.equal(stats.indexed, 1);
  assert.equal(stats.skipped, 0);

  const hits = idx.search('注入');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'sess_a');
  assert.equal(hits[0].matches.length, 2);
  assert.equal(hits[0].matches[0].index, 0);
  assert.equal(hits[0].matches[0].role, 'user');
  assert.ok(hits[0].matches[0].snippet.includes('注入'));
});

test('search is case-insensitive and supports several terms', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_b', [
    { role: 'user', content: 'Deploy the Agent Loop to staging', timestamp: 1 },
    { role: 'assistant', content: 'The agent loop retries with backoff.', timestamp: 2 },
  ]);
  const idx = new SessionSearchIndex(index);
  idx.sync([source('sess_b', file, 'deploy notes')]);
  assert.equal(idx.search('AGENT LOOP').length, 1);
  assert.equal(idx.search('agent backoff').length, 1);
  assert.equal(idx.search('agent missing').length, 0);
});

test('a session is only re-read when its fingerprint changes', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_c', [{ role: 'user', content: 'first' }]);
  const idx = new SessionSearchIndex(index);
  assert.deepEqual(idx.sync([source('sess_c', file, 'first')]), { scanned: 1, indexed: 1, skipped: 0, removed: 0, bytesRead: fs.statSync(file).size });
  const again = idx.sync([source('sess_c', file, 'first')]);
  assert.equal(again.skipped, 1);
  assert.equal(again.indexed, 0);

  // A fresh instance must reuse the on-disk record rather than the cache.
  const reopened = new SessionSearchIndex(index);
  assert.equal(reopened.sync([source('sess_c', file, 'first')]).skipped, 1);
});

test('changed transcripts are reindexed and deletions are pruned', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_d', [{ role: 'user', content: 'alpha' }]);
  const idx = new SessionSearchIndex(index);
  idx.sync([source('sess_d', file, 'alpha')]);
  assert.equal(idx.search('alpha').length, 1);

  fs.appendFileSync(file, ' ');
  const stats = idx.sync([source('sess_d', file, 'alpha')]);
  assert.equal(stats.indexed, 1);

  assert.equal(idx.search('alpha').length, 1);
  const pruned = idx.sync([]);
  assert.equal(pruned.removed, 1);
  assert.equal(idx.search('alpha').length, 0);
});

test('tool payloads are not indexed', () => {
  const { sessions, index } = fixture();
  const big = 'Z'.repeat(2 * 1024 * 1024);
  const file = writeSession(sessions, 'sess_e', [
    {
      role: 'assistant',
      content: 'visible prose',
      toolCalls: [{ id: 't1', name: 'shell_execute', result: { content: `SECRET_TOOL_MARKER ${big}` } }],
    },
  ]);
  const idx = new SessionSearchIndex(index);
  idx.sync([source('sess_e', file, 'tool heavy')]);
  assert.equal(idx.search('SECRET_TOOL_MARKER').length, 0);
  assert.equal(idx.search('visible').length, 1);

  const recordSize = fs.statSync(path.join(index, 'sess_e.json')).size;
  assert.ok(recordSize < 16 * 1024, `index record should stay tiny, got ${recordSize} bytes`);
  assert.ok(recordSize < fs.statSync(file).size / 50);
});

test('title-only matches are reported once', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_f', [{ role: 'user', content: 'unrelated body' }]);
  const idx = new SessionSearchIndex(index);
  idx.sync([source('sess_f', file, 'Pelican bicycle')]);
  const hits = idx.search('pelican');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matches.length, 1);
  assert.equal(hits[0].matches[0].role, 'title');
  assert.equal(hits[0].matches[0].index, -1);
});

test('quoted phrases stay together and terms are de-duplicated', () => {
  assert.deepEqual(tokenize('  "SQL 注入"  SQL  '), ['sql 注入', 'sql']);
  assert.deepEqual(tokenize(''), []);
});

test('a damaged record is rebuilt instead of crashing', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_g', [{ role: 'user', content: 'recover me' }]);
  const idx = new SessionSearchIndex(index);
  idx.sync([source('sess_g', file, 'recover')]);
  fs.writeFileSync(path.join(index, 'sess_g.json'), '{ broken');
  const reopened = new SessionSearchIndex(index);
  assert.equal(reopened.search('recover').length, 0);
  reopened.sync([source('sess_g', file, 'recover')]);
  assert.equal(reopened.search('recover').length, 1);
});

test('unsafe session ids are ignored', () => {
  const { sessions, index } = fixture();
  const file = writeSession(sessions, 'sess_h', [{ role: 'user', content: 'safe' }]);
  const idx = new SessionSearchIndex(index);
  const stats = idx.sync([source('../escape', file, 'escape')]);
  assert.equal(stats.indexed, 0);
  assert.equal(stats.scanned, 0);
});
