// Narration for the motion-graphics cut.
//
// Edge-TTS zh-CN-XiaoxiaoNeural. The installed SAPI voice (Huihui) reads like a
// 2008 GPS unit next to it. Rate pulled back 4% so it lands as a product film
// rather than a notification.
//
// Written in Node rather than PowerShell on purpose: Windows PowerShell 5.1
// parses a UTF-8 script without a BOM as ANSI and mangles every Chinese literal.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = process.cwd();
const FF = path.join(ROOT, 'workspace', 'tools', 'ffmpeg.exe');
const OUT = path.join(ROOT, '.video', 'vo2');
const TMP = path.join(OUT, 'mp3');
fs.mkdirSync(TMP, { recursive: true });

const VOICE = 'zh-CN-XiaoxiaoNeural';

const LINES = [
  ['00-intro', 'IEXA，把 AI 代理放进你的 Windows 桌面。'],
  ['01-hero', '一个本地优先的 AI 工作台。模型在云端，手脚在你的机器上。'],
  ['02-chat', '对话只是入口。思考、工具、计划，每一步都看得见。'],
  ['03-insights', '上下文洞察，把 Token 构成、耗时分布和用量趋势摊开。'],
  ['04-chart', '模型可以直接画图。折线、柱状，可悬停，能切换成表格。'],
  ['05-doc', '长文档在同一个窗口里写。分栏预览、自动保存、撤销重做。'],
  ['06-appearance', '八套皮肤，也可以自己调配色、圆角和字号。'],
  ['07-scheduled', '定时任务按系统时间自动执行，到点就跑。'],
  ['08-pet', '上传一张图，本地抠图，拖到桌面上当宠物。'],
  ['09-paused', '随时暂停，工具结果和进度都保留，继续时接着跑。'],
  ['10-settings', '多模型档案随时切换，密钥存在本地。'],
  ['11-outro', 'IEXA-WIN。你的私有 Windows AI 代理。'],
];

for (const [name, text] of LINES) {
  const mp3 = path.join(TMP, name + '.mp3');
  const wav = path.join(OUT, name + '.wav');
  execFileSync('python', ['-m', 'edge_tts', '--voice', VOICE, '--rate=-4%',
    '--pitch=+0Hz', '--text', text, '--write-media', mp3], { stdio: 'pipe' });
  // 48k mono keeps the mixer trivial.
  execFileSync(FF, ['-y', '-v', 'error', '-i', mp3, '-ar', '48000', '-ac', '1',
    '-c:a', 'pcm_s16le', wav], { stdio: 'pipe' });
  const dur = (fs.statSync(wav).size - 44) / (48000 * 2);
  console.log(name.padEnd(16) + dur.toFixed(2) + 's');
}
