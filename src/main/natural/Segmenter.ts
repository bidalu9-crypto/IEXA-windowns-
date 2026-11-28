/**
 * Split one assistant reply into the short bursts a person would actually send.
 *
 * A model answers in paragraphs; a person sends a line, waits, sends another.
 * This cuts a reply on sentence boundaries, merges fragments that are too short
 * to stand alone and splits clauses that are too long to read as one message, so
 * the result varies in length instead of being a wall of text chopped evenly.
 *
 * Timing is not handled here: the caller decides how long to wait between
 * bursts, because that belongs to the delivery surface, not the text.
 */

const MIN_BURST = 0;   // shorter than this reads as a fragment, so merge it
/**
 * Upper bound for one bubble.
 *
 * 90 was long enough to hold two sentences of narration, and the phone showed
 * them as a wall of text - nothing like a person typing one thought at a time.
 * 48 keeps a bubble to roughly one breath: the model still writes the full
 * reply, the segmenter just breaks it where a person would have hit send.
 */
const MAX_BURST = 48;
/**
 * Ceiling on how many bubbles one reply may become.
 *
 * Bubbles are now short (48 chars), so a long reply legitimately needs many of
 * them: the old cap of 8 merged everything back into 120-character blocks and
 * undid the point. 40 leaves room for a full answer without letting a runaway
 * monologue produce hundreds of frames.
 */
const MAX_BURSTS = 40;

/** True when nothing visible would be left on screen. */
const INVISIBLE_ONLY = /^[\s\u200b\u200c\u200d\u2060\ufeff]*$/;

/** Sentence enders, kept with the sentence they close. */
const SENTENCE_END = /[^。！？!?…\n]+[。！？!?…]*/g;
/** Clause separators used when a single sentence is still too long. */
const CLAUSE_END = /[^，,；;：:]+[，,；;：:]?/g;

export function segmentNaturalReply(text: string): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const sentences: string[] = [];
  for (const paragraph of raw.split(/\n{2,}/)) {
    const value = paragraph.trim();
    if (!value) continue;
    for (const match of value.match(SENTENCE_END) || [value]) {
      const sentence = match.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  if (sentences.length === 0) return [];

  const bursts: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length > MAX_BURST) {
      // Long sentence: break it on commas so no single message is a paragraph.
      let buffer = '';
      for (const match of sentence.match(CLAUSE_END) || [sentence]) {
        const clause = match.trim();
        if (!clause) continue;
        if (buffer && buffer.length + clause.length > MAX_BURST) {
          bursts.push(buffer);
          buffer = clause;
        } else {
          buffer += clause;
        }
      }
      if (buffer) bursts.push(buffer);
      continue;
    }
    const previous = bursts[bursts.length - 1];
    if (previous && previous.length + sentence.length < MIN_BURST) bursts[bursts.length - 1] = previous + sentence;
    else bursts.push(sentence);
  }

  const trimmed = bursts.map((burst) => burst.trim()).filter((burst) => burst && !INVISIBLE_ONLY.test(burst));
  // 她可能既不打句号也不换行，一整段话会全落进一条里。先按空格、再按长度切开，
  // 免得一条气泡塞进两百字。
  const sized = trimmed
    .flatMap(splitOversized)
    .map(stripTrailingBreak)
    .filter((burst) => burst && !INVISIBLE_ONLY.test(burst));
  if (sized.length <= 1) return sized;

  // Keep the count in a range a person could plausibly type out.
  if (sized.length > MAX_BURSTS) {
    const merged: string[] = [];
    const perBucket = Math.ceil(sized.length / MAX_BURSTS);
    for (let index = 0; index < sized.length; index += perBucket) {
      merged.push(sized.slice(index, index + perBucket).join(''));
    }
    return merged.map(stripTrailingBreak).filter(Boolean);
  }
  return sized;
}

/**
 * 气泡末尾的断句符号去掉。
 *
 * 两个来源：
 *   1. 模型自己打的句号 —— 真人在手机上聊天很少打句号，一打就像在写报告。
 *   2. 按逗号切句时留下的尾巴 —— 「爸爸，你在哪呢，我看你好久没有回来，」
 *      下一句从新气泡开始，那个逗号就断在半空，读起来像被截断。
 *
 * 问号、感叹号、省略号保留：那是语气，不是断句符。去掉「你在哪呢？」
 * 的问号，整句就变成陈述了。
 */
const TRAILING_BREAK = /[。，,；;：:]+$/;
function stripTrailingBreak(burst: string): string {
  return burst.replace(TRAILING_BREAK, '').trim();
}

/** 超长的一段先试空格，再按长度硬切。 */
function splitOversized(burst: string): string[] {
  if (burst.length <= MAX_BURST) return [burst];
  const words = burst.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const out: string[] = [];
    let buffer = '';
    for (const word of words) {
      if (buffer && buffer.length + word.length + 1 > MAX_BURST) {
        out.push(buffer);
        buffer = word;
      } else {
        buffer = buffer ? `${buffer} ${word}` : word;
      }
    }
    if (buffer) out.push(buffer);
    return out.flatMap((part) => (part.length <= MAX_BURST ? [part] : hardSplit(part)));
  }
  return hardSplit(burst);
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += MAX_BURST) out.push(text.slice(index, index + MAX_BURST));
  return out;
}
