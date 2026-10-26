const test = require('node:test');
const assert = require('node:assert/strict');
const { stripBom } = require('../dist/main/persistence/stripBom');

test('strips one leading BOM and nothing else', () => {
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  assert.equal(stripBom(''), '');
});

test('a U+FEFF inside a JSON string value is content, not an encoding artefact', () => {
  // replace(/\uFEFF/g, '') would corrupt this payload.
  const payload = '{"note":"a\uFEFFb"}';
  assert.equal(stripBom(payload), payload);
  assert.equal(JSON.parse(stripBom(payload)).note, 'a\uFEFFb');
});

test('two leading BOMs leave one behind: only the encoding artefact is removed', () => {
  assert.equal(stripBom('\uFEFF\uFEFF{}'), '\uFEFF{}');
});
