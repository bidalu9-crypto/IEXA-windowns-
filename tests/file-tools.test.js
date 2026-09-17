'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const iconv = require('iconv-lite');
const { FileTools } = require('../dist/main/tools/ToolExecutors');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-files-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, tools: new FileTools() };
}

function body(output) { return output.split('\n---\n')[1]?.split('\n\n[Truncated/paged')[0] || ''; }

test('file_read strips BOM, preserves Unicode characters, and reports every kind of paging', async (t) => {
  const { root, tools } = fixture(t);
  fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\nworld')]));
  const bom = await tools.readFile('bom.txt', root);
  assert.equal(bom.success, true);
  assert.equal(body(bom.output), 'hello\nworld');
  assert.doesNotMatch(body(bom.output), /^\uFEFF/);

  fs.writeFileSync(path.join(root, 'emoji.txt'), '😀😀😀');
  const emoji = await tools.readFile('emoji.txt', root, { maxLength: 1 });
  assert.equal(body(emoji.output), '😀');
  assert.doesNotMatch(emoji.output, /�/);
  assert.match(emoji.output, /Truncated\/paged/);

  fs.writeFileSync(path.join(root, 'lines.txt'), 'one\ntwo\nthree');
  const page = await tools.readFile('lines.txt', root, { lines: 1 });
  assert.equal(body(page.output), 'one');
  assert.match(page.output, /Truncated\/paged/);
});

test('file_edit accepts displayed LF text for CRLF files and preserves file line endings', async (t) => {
  const { root, tools } = fixture(t);
  const target = path.join(root, 'crlf.txt');
  fs.writeFileSync(target, 'alpha\r\nbeta\r\n');
  const result = await tools.editFile('crlf.txt', 'alpha\nbeta', 'first\nsecond', root);
  assert.equal(result.success, true, result.output);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first\r\nsecond\r\n');

  const mixed = path.join(root, 'mixed.txt');
  fs.writeFileSync(mixed, 'a\r\nb\nc');
  const mixedResult = await tools.editFile('mixed.txt', 'b\nc', 'x\ny', root);
  assert.equal(mixedResult.success, true, mixedResult.output);
  assert.equal(fs.readFileSync(mixed, 'utf8'), 'a\r\nx\ny');
});

test('file_edit uses the file EOL when a single-line anchor inserts multiple lines', async (t) => {
  const { root, tools } = fixture(t);
  const target = path.join(root, 'crlf-anchor.txt');
  fs.writeFileSync(target, 'top\r\nTARGET\r\nbottom\r\n');
  const result = await tools.editFile('crlf-anchor.txt', 'TARGET', 'new\nvalue', root);
  assert.equal(result.success, true, result.output);
  const content = fs.readFileSync(target, 'utf8');
  assert.equal(content, 'top\r\nnew\r\nvalue\r\nbottom\r\n');
  assert.equal(/(^|[^\r])\n/.test(content), false);
});

test('append and edit preserve UTF-16/GB18030 encodings and produce byte-exact undo hashes', async (t) => {
  const { root, tools } = fixture(t);
  const utf16Path = path.join(root, 'utf16.txt');
  fs.writeFileSync(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('甲\r\n乙', 'utf16le')]));
  const overwrite = await tools.writeFile('utf16.txt', '新\r\n文', root);
  assert.equal(overwrite.success, true, overwrite.output);
  let utf16Bytes = fs.readFileSync(utf16Path);
  assert.deepEqual([...utf16Bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(iconv.decode(utf16Bytes.subarray(2), 'utf16le'), '新\r\n文');
  assert.equal(overwrite.fileChange.rollback.afterSha256, crypto.createHash('sha256').update(utf16Bytes).digest('hex'));

  const append = await tools.writeFile('utf16.txt', '\r\n丙', root, { append: true });
  assert.equal(append.success, true, append.output);
  utf16Bytes = fs.readFileSync(utf16Path);
  assert.deepEqual([...utf16Bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(iconv.decode(utf16Bytes.subarray(2), 'utf16le'), '新\r\n文\r\n丙');
  assert.equal(append.fileChange.rollback.afterSha256, crypto.createHash('sha256').update(utf16Bytes).digest('hex'));

  const gbPath = path.join(root, 'gb.txt');
  fs.writeFileSync(gbPath, iconv.encode('你好\r\n世界', 'gb18030'));
  const edit = await tools.editFile('gb.txt', '你好\n世界', '再见\n世界', root);
  assert.equal(edit.success, true, edit.output);
  const gbBytes = fs.readFileSync(gbPath);
  assert.equal(iconv.decode(gbBytes, 'gb18030'), '再见\r\n世界');
  assert.equal(edit.fileChange.rollback.afterSha256, crypto.createHash('sha256').update(gbBytes).digest('hex'));
});

test('file_read and file_write reject binary bytes without corrupting the file', async (t) => {
  const { root, tools } = fixture(t);
  const target = path.join(root, 'binary.dat');
  const original = Buffer.from([0xff, 0xfe, 0, 0, 1, 2]);
  fs.writeFileSync(target, original);
  const read = await tools.readFile('binary.dat', root);
  assert.equal(read.success, false);
  assert.match(read.output, /binary/);
  const append = await tools.writeFile('binary.dat', 'text', root, { append: true });
  assert.equal(append.success, false);
  assert.deepEqual(fs.readFileSync(target), original);

  const deepTarget = path.join(root, 'deep-binary.dat');
  fs.writeFileSync(deepTarget, Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0, 1, 2])]));
  const deepRead = await tools.readFile('deep-binary.dat', root);
  assert.equal(deepRead.success, false);
  assert.match(deepRead.output, /binary/);

  const invalidPath = path.join(root, 'invalid-gb.dat');
  const invalid = Buffer.from([0x81, 0x30, 0x20, 0x20, 0x82, 0x20]);
  fs.writeFileSync(invalidPath, invalid);
  const invalidRead = await tools.readFile('invalid-gb.dat', root);
  assert.equal(invalidRead.success, false);
  const invalidEdit = await tools.editFile('invalid-gb.dat', ' ', 'X', root, true);
  assert.equal(invalidEdit.success, false);
  assert.deepEqual(fs.readFileSync(invalidPath), invalid);

  const deepUtf16Path = path.join(root, 'deep-utf16.dat');
  fs.writeFileSync(deepUtf16Path, Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from('a'.repeat(5000), 'utf16le'), Buffer.from([0, 0, 1, 0]),
  ]));
  const deepUtf16Read = await tools.readFile('deep-utf16.dat', root);
  assert.equal(deepUtf16Read.success, false);
  assert.match(deepUtf16Read.output, /binary/);
});
