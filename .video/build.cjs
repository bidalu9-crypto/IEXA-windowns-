// Build the 1080p60 feature film.
//
// Two passes on purpose: pass A renders each still into a zoomed clip, pass B
// chains them with xfade, burns the ASS captions and muxes the narration. Doing
// it in one graph would make a single bad scene unrecoverable.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const FF = path.join(ROOT, 'workspace', 'tools', 'ffmpeg.exe');
const FP = path.join(ROOT, 'workspace', 'tools', 'ffprobe.exe');
const SHOTS = path.join(ROOT, '.video-shots');
const VO = path.join(ROOT, '.video', 'vo');
const WORK = path.join(ROOT, '.video', 'build');

const W = 1920;
const H = 1080;
const FPS = 60;
const XFADE = 0.4;
const PAD = 1.0;          // breathing room after each line
const LEAD_IN = 0.35;     // narration starts just after the cut settles

fs.mkdirSync(WORK, { recursive: true });

const probe = (file) => Number(execFileSync(FP, [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
], { encoding: 'utf8' }).trim());

// ---- scene table: shot name, narration name, caption, isCard ----
// Shot names come from the capture pass; narration names from the VO pass. They
// were numbered independently, so the mapping is explicit rather than derived.
// Cards carry their own title, so they get no caption and no scrim.
const SCENES = [
  ['00-intro', '00-intro', '', true],
  ['01-hero', '01-hero', '本地优先的 AI 工作台', false],
  ['02-chat', '02-chat', '思考、工具、计划，每一步都可见', false],
  ['04-insights', '03-insights', '上下文洞察：Token、耗时、用量趋势', false],
  ['05-chart', '04-chart', '模型直接画图：折线、柱状、可交互', false],
  ['06-doc', '05-doc', '文档工作区：分栏预览与自动保存', false],
  ['08-appearance', '06-appearance', '八套皮肤，可调配色与字号', false],
  ['09-scheduled', '07-scheduled', '定时任务：到点自动执行', false],
  ['10-pet', '08-pet', '桌面宠物：一张图，本地抠图', false],
  ['11-paused', '09-paused', '暂停保留进度，继续从原处接着跑', false],
  ['12-settings', '10-settings', '多模型档案，密钥保存在本地', false],
  ['12-outro', '11-outro', '', true],
];

// ---- pass A: still -> 60fps clip with a slow push-in ----
const SCRIM = path.join(ROOT, '.video', 'scrim.png');
const clips = [];
for (const [name, voName, caption, isCard] of SCENES) {
  const img = path.join(SHOTS, `${name}.png`);
  if (!fs.existsSync(img)) throw new Error('missing shot: ' + img);
  const voFile = path.join(VO, `${voName}.wav`);
  const voDur = fs.existsSync(voFile) ? probe(voFile) : 4;
  const dur = Math.max(4, voDur + PAD);
  const frames = Math.round(dur * FPS);
  const out = path.join(WORK, `scene-${name}.mp4`);

  // 1.00 -> 1.055 over the clip. Cards zoom less so the type stays crisp.
  const span = isCard ? 0.03 : 0.055;
  const base = [
    `scale=${W * 2}:${H * 2}:flags=lanczos`,
    `zoompan=z='min(1+${span}*on/${frames},${1 + span})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`,
    'format=rgba',
  ].join(',');

  const args = ['-y', '-loglevel', 'error', '-loop', '1', '-i', img];
  let graph;
  if (isCard) {
    graph = `[0:v]${base},format=yuv420p[vout]`;
  } else {
    // Bake the caption scrim in here rather than in the xfade pass: the cards
    // must not be darkened, and per-scene handling keeps the final graph simple.
    // `-vf` cannot reference a second input, so this needs -filter_complex.
    args.push('-i', SCRIM);
    graph = `[0:v]${base}[bg];[bg][1:v]overlay=0:0,format=yuv420p[vout]`;
  }
  const graphFile = path.join(WORK, `passA-${name}.txt`);
  fs.writeFileSync(graphFile, graph, 'utf8');

  execFileSync(FF, [
    ...args,
    '-/filter_complex', graphFile,
    '-map', '[vout]',
    '-frames:v', String(frames),
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12',
    '-pix_fmt', 'yuv420p',
    out,
  ], { stdio: 'inherit' });

  clips.push({ name, caption, isCard, file: out, dur, voFile, voDur });
  console.log(`scene ${name.padEnd(15)} ${dur.toFixed(2)}s  ${frames} frames${isCard ? '  (card)' : ''}`);
}

// ---- timeline ----
clips[0].start = 0;
for (let i = 1; i < clips.length; i += 1) {
  clips[i].start = clips[i - 1].start + clips[i - 1].dur - XFADE;
}
const total = clips[clips.length - 1].start + clips[clips.length - 1].dur;
console.log('total duration', total.toFixed(2) + 's');

// ---- ASS captions ----
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
  'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Cap,Microsoft YaHei UI,40,&H00F4F4F7,&H00F4F4F7,&H00101014,&H96000000,-1,0,0,0,100,100,1.5,0,1,2,3,2,160,160,116,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];
const ts = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};
clips.forEach((clip, i) => {
  if (!clip.caption) return;                 // cards carry their own title
  // Captions live only inside the settled part of each scene. Covering the
  // dissolve itself let the outgoing and incoming lines overlap on screen.
  const from = clip.start + XFADE / 2 + 0.10;
  const to = clip.start + clip.dur - XFADE / 2 - 0.10;
  ass.push(`Dialogue: 0,${ts(from)},${ts(to)},Cap,,0,0,0,,{\\fad(380,380)}${clip.caption}`);
});
fs.writeFileSync(path.join(WORK, 'captions.ass'), ass.join('\n'), 'utf8');

// ---- pass B: xfade chain + captions + narration ----
const inputs = [];
for (const clip of clips) inputs.push('-i', clip.file);
for (const clip of clips) inputs.push('-i', clip.voFile);

let filter = '';
let last = '[0:v]';
for (let i = 1; i < clips.length; i += 1) {
  const out = i === clips.length - 1 ? '[vx]' : `[v${i}]`;
  const off = clips[i - 1].start + clips[i - 1].dur - XFADE;
  filter += `${last}[${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${off.toFixed(3)}${out};`;
  last = out;
}

// Subtitles, then a hairline progress bar that grows across the whole film.
// This ffmpeg has no -filter_complex_script (removed in 6.x): the replacement is
// `-/filter_complex <file>`. And inside a filtergraph a Windows drive colon must
// be escaped, or the parser reads "E:" as an option name.
const assPath = path.join(WORK, 'captions.ass').replace(/\\/g, '/').replace(':', '\\:');
filter += `[vx]ass=filename='${assPath}':fontsdir='C\\:/Windows/Fonts'[vsub];`;
filter += `[vsub]drawbox=x=0:y=ih-4:w='iw*t/${total.toFixed(3)}':h=4:color=0x8B7BFF@0.9:t=fill[vout];`;

// Narration: one delayed copy per line, summed. normalize=0 keeps the levels.
const audioBase = clips.length;
const mix = [];
clips.forEach((clip, i) => {
  const idx = audioBase + i;
  const ms = Math.round((clip.start + LEAD_IN) * 1000);
  filter += `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}];`;
  mix.push(`[a${i}]`);
});
filter += `${mix.join('')}amix=inputs=${clips.length}:normalize=0:duration=longest,alimiter=limit=0.95,apad=whole_dur=${total.toFixed(3)}[aout]`;

const graphFile = path.join(WORK, 'graph.txt');
fs.writeFileSync(graphFile, filter, 'utf8');

const finalFile = path.join(ROOT, 'IEXA-WIN-功能介绍.mp4');
execFileSync(FF, [
  '-y', '-loglevel', 'error',
  ...inputs,
  '-/filter_complex', graphFile,
  '-map', '[vout]', '-map', '[aout]',
  '-t', total.toFixed(3),
  '-r', String(FPS),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-movflags', '+faststart',
  finalFile,
], { stdio: 'inherit' });

// ---- loudness ----
// The raw mix measured -22.1 LUFS: audible, but far below the -14 LUFS web
// players expect, so viewers reach for the volume slider. Measure once, then
// apply a linear gain: linear keeps speech transparent instead of pumping the
// way a single-pass dynamic normalize would.
function measureLoudness(file) {
  const r = spawnSync(FF, [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=7:print_format=json',
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!m) throw new Error('loudnorm measurement failed');
  return JSON.parse(m[0]);
}

const loud = measureLoudness(finalFile);
const normFile = path.join(WORK, 'normalized.mp4');
execFileSync(FF, [
  '-y', '-loglevel', 'error', '-i', finalFile,
  '-c:v', 'copy',
  '-af', `loudnorm=I=-14:TP=-1.5:LRA=7:measured_I=${loud.input_i}:measured_TP=${loud.input_tp}:measured_LRA=${loud.input_lra}:measured_thresh=${loud.input_thresh}:offset=${loud.target_offset}:linear=true`,
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-movflags', '+faststart',
  normFile,
], { stdio: 'inherit' });
fs.renameSync(normFile, finalFile);
console.log(`loudness: ${loud.input_i} LUFS -> -14 LUFS (linear, cap -1.5 dBTP)`);

const size = (fs.statSync(finalFile).size / 1024 / 1024).toFixed(1);
console.log(`\nfinal: ${finalFile}`);
console.log(`size: ${size} MB, duration: ${probe(finalFile).toFixed(2)}s`);
