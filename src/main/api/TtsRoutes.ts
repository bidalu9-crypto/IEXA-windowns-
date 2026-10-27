import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import type * as http from 'http';

/**
 * Read replies aloud with the same neural voices the intro film used.
 *
 * The synthesis itself is delegated to `python -m edge_tts` rather than
 * reimplemented here: the service validates a `Sec-MS-GEC` token whose second
 * half comes from a modified SHA-256 with a salt-dependent initial state. I
 * verified against the live service that a plain SHA-256 gets HTTP 403, so
 * hand-porting that hash would be a 600-line liability that breaks whenever
 * Microsoft rotates it. The CLI is version-pinned in the docs and gives one
 * clear failure mode when Python is absent.
 */

const VOICES = new Set([
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunxiNeural',
  'zh-CN-YunxiaNeural', 'zh-CN-YunyangNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'en-US-AriaNeural', 'en-US-GuyNeural', 'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural',
]);

export const DEFAULT_TTS_VOICE = 'zh-CN-YunyangNeural';
const DEFAULT_RATE = '-4%';
const MAX_CHARS = 6000;
const SPAWN_TIMEOUT_MS = 60_000;

/** One synthesis at a time: each call pays a Python start plus a websocket leg. */
let queue: Promise<unknown> = Promise.resolve();

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

/**
 * Markdown read aloud is mostly noise: fence contents, tables and link targets
 * are not sentences. Keep the prose, drop the scaffolding.
 */
export function stripForSpeech(markdown: string): string {
  let text = String(markdown || '');
  text = text.replace(/```[\s\S]*?```/g, ' ');          // fenced blocks
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');               // inline code keeps its text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');  // images -> alt text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // links -> label
  text = text.replace(/^\s*\|.*\|\s*$/gm, ' ');          // table rows
  text = text.replace(/^\s*[-*+]\s+/gm, '');             // bullets
  text = text.replace(/^\s*#{1,6}\s+/gm, '');            // headings
  text = text.replace(/^\s*>\s?/gm, '');                 // quotes
  text = text.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');       // stray html
  text = text.replace(/\r/g, '');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function pythonCandidates(): string[][] {
  const override = process.env.IEXA_TTS_PYTHON;
  if (override) return [[override]];
  return [['python'], ['py', '-3']];
}

/** Run one synthesis. Resolves with the produced file path. */
function synthesize(textFile: string, outFile: string, voice: string, rate: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempts = pythonCandidates();
    let index = 0;

    const run = () => {
      const [exe, ...prefix] = attempts[index];
      const args = [...prefix, '-m', 'edge_tts', '-f', textFile, '-v', voice, '--rate', rate,
        '--no-progress', '--write-media', outFile];
      const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(new Error('语音合成超时'));
      }, SPAWN_TIMEOUT_MS);

      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        // "not found" means this interpreter does not exist; try the next one.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index + 1 < attempts.length) {
          index += 1;
          settled = true;
          clearTimeout(timer);
          run();
          return;
        }
        finish(error);
      });
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 512) return finish();
        const detail = stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200);
        finish(new Error(detail || `edge-tts 退出码 ${code}`));
      });
    };

    run();
  });
}

export interface TtsRouteContext {
  workspaceDir: string;
}

/**
 * @returns true when the request was handled here.
 */
export async function handleTtsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: TtsRouteContext,
): Promise<boolean> {
  const cacheDir = path.join(ctx.workspaceDir, '.iexa-tts');

  if (url.pathname === '/api/tts/voices' && req.method === 'GET') {
    reply(res, 200, { voices: [...VOICES], defaultVoice: DEFAULT_TTS_VOICE, rate: DEFAULT_RATE });
    return true;
  }

  if (url.pathname === '/api/tts/speak' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 200_000) { reply(res, 413, { error: '请求过大' }); return true; }
    }
    let parsed: { text?: string; voice?: string };
    try { parsed = JSON.parse(body || '{}'); } catch { reply(res, 400, { error: '请求不是有效 JSON' }); return true; }

    const voice = String(parsed.voice || DEFAULT_TTS_VOICE);
    if (!VOICES.has(voice)) { reply(res, 400, { error: '不支持的语音' }); return true; }

    const spoken = stripForSpeech(parsed.text || '');
    if (!spoken) { reply(res, 400, { error: '这条回复没有可朗读的文字' }); return true; }
    if (spoken.length > MAX_CHARS) { reply(res, 413, { error: `文字过长（上限 ${MAX_CHARS} 字）` }); return true; }

    const key = crypto.createHash('sha1').update(`${voice}|${DEFAULT_RATE}|${spoken}`).digest('hex').slice(0, 20);
    const audioFile = path.join(cacheDir, `${key}.mp3`);
    const audioUrl = `/api/tts/audio/${key}.mp3`;

    if (fs.existsSync(audioFile) && fs.statSync(audioFile).size > 512) {
      reply(res, 200, { ok: true, url: audioUrl, voice, cached: true, chars: spoken.length });
      return true;
    }

    const job = queue.then(async () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      const textFile = path.join(cacheDir, `${key}.txt`);
      fs.writeFileSync(textFile, spoken, 'utf8');
      try {
        await synthesize(textFile, audioFile, voice, DEFAULT_RATE);
      } finally {
        try { fs.unlinkSync(textFile); } catch { /* already removed */ }
      }
      return { ok: true, url: audioUrl, voice, cached: false, chars: spoken.length };
    });
    // Keep the chain alive even when this call fails, or one error blocks speech.
    queue = job.catch(() => undefined);

    try {
      reply(res, 200, await job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply(res, 503, {
        error: '语音合成失败',
        detail: message,
        hint: '需要本机安装 Python 3 与 edge-tts：pip install edge-tts（可用 IEXA_TTS_PYTHON 指定解释器）',
      });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/tts/audio/') && req.method === 'GET') {
    const name = path.basename(url.pathname);
    if (!/^[0-9a-f]{20}\.mp3$/.test(name)) { reply(res, 400, { error: '无效的音频名' }); return true; }
    const file = path.join(cacheDir, name);
    if (!fs.existsSync(file)) { reply(res, 404, { error: '音频不存在或已过期' }); return true; }
    // One clip is tens of KB; reading it whole avoids stream plumbing and lets a
    // plain object stand in for the response in tests.
    const audio = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(audio);
    return true;
  }

  return false;
}
