const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'src/main/api');
const server = fs.readFileSync(path.join(ROOT, 'src/main/server.ts'), 'utf8');
const lines = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').length;

test('server.ts stays a bootstrap, not an application', () => {
  // The god-file budget. Raising it means the next feature goes back into the
  // request handler instead of its own module, which is how it got to 4,139.
  assert.ok(lines(path.join(ROOT, 'src/main/server.ts')) < 3600, 'server.ts grew past its budget');
});

test('every route module is actually dispatched', () => {
  const files = fs.readdirSync(API).filter((f) => /Routes\.ts$/.test(f));
  assert.ok(files.length >= 6, `expected the api/ modules, found ${files.join(', ')}`);
  for (const file of files) {
    const source = fs.readFileSync(path.join(API, file), 'utf8');
    const handlers = [...source.matchAll(/export async function (handle\w+Route)\(/g)].map((m) => m[1]);
    if (!handlers.length) continue; // helper-only module (HttpServer, StreamBatcher)
    for (const handler of handlers) {
      // A module nobody calls is dead weight; the route it owns would 404.
      assert.match(server, new RegExp(`\\b${handler}\\(req, res, url`), `${file}: ${handler} is never called from server.ts`);
    }
  }
});

test('route modules never import the server back', () => {
  // server.ts importing api/* is fine; the reverse would be a cycle whose
  // behaviour depends on which file the loader happened to start with.
  for (const file of fs.readdirSync(API)) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(API, file), 'utf8');
    assert.ok(!/from '\.\.\/server'/.test(source), `${file} imports server.ts`);
  }
});

test('a route module declares the context it needs instead of reaching for globals', () => {
  for (const file of fs.readdirSync(API).filter((f) => /Routes\.ts$/.test(f))) {
    const source = fs.readFileSync(path.join(API, file), 'utf8');
    if (!/export async function handle\w+Route\(/.test(source)) continue;
    assert.match(source, /interface \w*(?:Route|Routes)Context \{/, `${file} has no context interface`);
  }
});
