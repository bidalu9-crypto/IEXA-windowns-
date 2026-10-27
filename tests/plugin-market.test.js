'use strict';
// The market reads one explicit JSON index, validates it, and filters locally.
// It never executes index content and refuses non-HTTP(S) sources.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PluginMarket } = require('../dist/main/plugins/PluginMarket');

const INDEX = {
  version: 1,
  title: 'IEXA 官方索引',
  plugins: [
    { id: 'git-tools', name: 'Git Tools', version: '1.2.0', description: 'Branch and diff helpers', author: 'iexa', tags: ['git', 'dev'], download: 'https://example.com/git.zip', sha256: 'a'.repeat(64) },
    { id: 'image-lab', name: 'Image Lab', version: '0.4.1', description: 'Generate and edit images', author: 'community', tags: ['image'], download: 'https://example.com/image.zip' },
  ],
};

function serve(body) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('search filters by name, author and tag', async () => {
  const server = await serve(INDEX);
  try {
    const url = `http://127.0.0.1:${server.address().port}/index.json`;
    const market = new PluginMarket();
    const all = await market.search(url, '');
    assert.equal(all.title, 'IEXA 官方索引');
    assert.equal(all.items.length, 2);
    const git = await market.search(url, 'git');
    assert.deepEqual(git.items.map((item) => item.id), ['git-tools']);
    const community = await market.search(url, 'community');
    assert.deepEqual(community.items.map((item) => item.id), ['image-lab']);
  } finally {
    server.close();
  }
});

test('a non-HTTP source is refused before any request', async () => {
  const market = new PluginMarket();
  await assert.rejects(() => market.search('file:///etc/passwd', ''), /http/);
});

test('an unsupported index version is refused', async () => {
  const server = await serve({ version: 99, plugins: [] });
  try {
    const url = `http://127.0.0.1:${server.address().port}/index.json`;
    await assert.rejects(() => new PluginMarket().search(url, ''), /版本/);
  } finally {
    server.close();
  }
});
