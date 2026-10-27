// Read-aloud endpoint. Synthesis itself is delegated to the edge-tts CLI, so
// these tests pin everything around it: the markdown clean-up, the voice
// allow-list, the cache, and the audio response. One opt-in test runs the real
// synthesizer because that is the only way to know the CLI contract still holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { stripForSpeech, DEFAULT_TTS_VOICE, handleTtsRoute } = require('../dist/main/api/TtsRoutes');

test('markdown is reduced to prose before it is spoken', () => {
  const source = [
    '# 标题',
    '',
    '正常一段话，带 **重点** 和 `行内代码`。',
    '',
    '```js',
    'console.log("这行不该被读出来")',
    '```',
    '',
    '- 列表项',
    '> 引用',
    '',
    '看 [这个链接](https://example.com) 和 ![图](a.png)',
    '| a | b |',
  ].join('\n');
  const spoken = stripForSpeech(source);
  assert.doesNotMatch(spoken, /console\.log/, 'fence bodies are dropped');
  assert.doesNotMatch(spoken, /example\.com/, 'link targets are dropped');
  assert.doesNotMatch(spoken, /^#|\*\*|`/m, 'markers are stripped');
  assert.match(spoken, /正常一段话，带 重点 和 行内代码。/);
  assert.match(spoken, /这个链接/, 'the label survives');
  assert.match(spoken, /图/, 'image alt text survives');
});

test('the route serves audio, caches it, and refuses what it cannot read', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-tts-'));
  t.after(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* locked */ } });

  // Pre-seed the cache so this test never spawns Python: same key derivation the
  // route uses (voice | rate | spoken text).
  const text = '这是一段用来测试缓存的回复。';
  const key = crypto.createHash('sha1').update(`${DEFAULT_TTS_VOICE}|-4%|${stripForSpeech(text)}`).digest('hex').slice(0, 20);
  const cacheDir = path.join(workspace, '.iexa-tts');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fakeMp3 = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(2048, 0x11)]);
  fs.writeFileSync(path.join(cacheDir, `${key}.mp3`), fakeMp3);

  const call = async (pathname, init) => {
    const url = new URL(`http://127.0.0.1${pathname}`);
    let status = 0; let body = null; let headers = {};
    const res = {
      writeHead(code, h) { status = code; headers = h || {}; return this; },
      end(payload) {
        if (!payload) { body = null; return; }
        const type = String(headers['Content-Type'] || '');
        body = /json/.test(type) ? JSON.parse(payload) : Buffer.from(payload);
      },
      on() { return this; },
    };
    const handled = await handleTtsRoute(init?.req || { method: init?.method || 'GET', [Symbol.asyncIterator]: async function* () { if (init?.body) yield Buffer.from(init.body); } }, res, url, { workspaceDir: workspace });
    return { handled, status, body, headers };
  };
  const post = (payload) => call('/api/tts/speak', { method: 'POST', body: JSON.stringify(payload) });

  const voices = await call('/api/tts/voices');
  assert.equal(voices.handled, true);
  assert.ok(voices.body.voices.length >= 8, 'the allow-list is published');
  assert.equal(voices.body.defaultVoice, DEFAULT_TTS_VOICE);

  const cached = await post({ text });
  assert.equal(cached.status, 200);
  assert.equal(cached.body.cached, true, 'a warm cache skips synthesis');
  assert.equal(cached.body.url, `/api/tts/audio/${key}.mp3`);

  const audio = await call(`/api/tts/audio/${key}.mp3`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers['Content-Type'], 'audio/mpeg');
  assert.equal(audio.body[0], 0xff, 'the body is the mp3 itself, not json');

  const unknownVoice = await post({ text, voice: 'evil-voice' });
  assert.equal(unknownVoice.status, 400, 'the voice list is an allow-list');

  const codeOnly = await post({ text: '```\nonly code\n```' });
  assert.equal(codeOnly.status, 400);
  assert.match(codeOnly.body.error, /没有可朗读/);

  const tooLong = await post({ text: '字'.repeat(6001) });
  assert.equal(tooLong.status, 413);

  // A plain ../ is normalised away by URL parsing, so the route never sees it;
  // an encoded one survives into pathname and must be rejected by the name check.
  const traversal = await call('/api/tts/audio/..%2F..%2Fsettings.json');
  assert.equal(traversal.status, 400, 'only a hash name may be read');

  const missing = await call(`/api/tts/audio/${'0'.repeat(20)}.mp3`);
  assert.equal(missing.status, 404);

  assert.equal((await call('/api/other')).handled, false, 'unrelated paths are left alone');
});

// Opt-in: proves the CLI contract (args, output size) still matches.
test('real synthesis produces a playable clip', { skip: !process.env.IEXA_TEST_TTS, timeout: 90000 }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-tts-live-'));
  t.after(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* locked */ } });

  let body = null; let status = 0;
  const res = {
    writeHead(code) { status = code; return this; },
    end(payload) { body = JSON.parse(payload); },
    on() { return this; },
  };
  const req = { method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text: '朗读功能测试。' })); } };
  await handleTtsRoute(req, res, new URL('http://127.0.0.1/api/tts/speak'), { workspaceDir: workspace });
  assert.equal(status, 200, JSON.stringify(body));
  const file = path.join(workspace, '.iexa-tts', path.basename(body.url));
  assert.ok(fs.statSync(file).size > 4096, 'a real clip is more than a header');
});
