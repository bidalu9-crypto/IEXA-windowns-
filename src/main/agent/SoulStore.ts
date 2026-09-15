// =============================================================================
// IEXA PC - SOUL.md persistent assistant identity and personality
// Mirrors the iOS SOUL.md contract while keeping the desktop implementation
// synchronous and dependency-free for the request construction path.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';

export interface SoulMetadata {
  name: string;
  style: string;
  lang: string;
}

export interface SoulFile {
  metadata: SoulMetadata;
  body: string;
}

export interface SoulLimitCheck {
  count: number;
  limit: number;
  isOverLimit: boolean;
}

export const SOUL_BODY_TOKEN_LIMIT = 2000;

export const DEFAULT_SOUL: SoulFile = {
  metadata: { name: 'IEXA', style: '', lang: 'auto' },
  body: '',
};

export function cloneDefaultSoul(): SoulFile {
  return { metadata: { ...DEFAULT_SOUL.metadata }, body: DEFAULT_SOUL.body };
}

/**
 * SOUL.md deliberately uses a small YAML-frontmatter subset. This parser is
 * tolerant of hand-edited files: malformed or missing frontmatter simply
 * makes the complete file a personality body with default metadata.
 */
export function parseSoulMarkdown(source: string): SoulFile {
  const text = String(source || '');
  const leadingTrimmed = text.replace(/^(?:\r?\n)+/, '');
  const lines = leadingTrimmed.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { metadata: { ...DEFAULT_SOUL.metadata }, body: text };
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closeIndex < 0) return { metadata: { ...DEFAULT_SOUL.metadata }, body: text };

  const metadata: SoulMetadata = { ...DEFAULT_SOUL.metadata };
  for (const rawLine of lines.slice(1, closeIndex)) {
    const separator = rawLine.indexOf(':');
    if (separator < 0) continue;
    const key = rawLine.slice(0, separator).trim().toLowerCase();
    let value = rawLine.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (key === 'name' && value) metadata.name = value;
    if (key === 'style') metadata.style = value;
    if (key === 'lang' && value) metadata.lang = value;
  }
  return { metadata, body: lines.slice(closeIndex + 1).join('\n').replace(/^(?:\r?\n)+/, '') };
}

export function serializeSoulMarkdown(file: SoulFile): string {
  const metadata = normalizeSoulMetadata(file.metadata);
  const body = String(file.body || '');
  const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\nname: "${quote(metadata.name)}"\nstyle: "${quote(metadata.style)}"\nlang: "${quote(metadata.lang)}"\n---\n\n${body}`;
}

/** Count CJK graphemes individually and other language text by word. */
export function soulTokenCount(text: string): number {
  let count = 0;
  let inWord = false;
  for (const char of String(text || '')) {
    if (isCjk(char)) {
      if (inWord) { count++; inWord = false; }
      count++;
    } else if (/\s/u.test(char)) {
      if (inWord) { count++; inWord = false; }
    } else {
      inWord = true;
    }
  }
  return count + (inWord ? 1 : 0);
}

export function checkSoulBodyLimit(body: string): SoulLimitCheck {
  const count = soulTokenCount(String(body || '').trim());
  return { count, limit: SOUL_BODY_TOKEN_LIMIT, isOverLimit: count > SOUL_BODY_TOKEN_LIMIT };
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) || 0;
  return (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x20000 && code <= 0x323af)
    || (code >= 0x3040 && code <= 0x31ff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0x1100 && code <= 0x11ff)
    || (code >= 0x3130 && code <= 0x318f)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xff00 && code <= 0xffef);
}

export function normalizeSoulMetadata(value: Partial<SoulMetadata> | undefined | null): SoulMetadata {
  const compact = (input: unknown, fallback: string, maxLength: number) => {
    const result = typeof input === 'string' ? input.trim().replace(/[\r\n]+/g, ' ') : '';
    return (result || fallback).slice(0, maxLength);
  };
  return {
    name: compact(value?.name, DEFAULT_SOUL.metadata.name, 100),
    style: compact(value?.style, '', 300),
    lang: compact(value?.lang, 'auto', 40),
  };
}

export class SoulStore {
  readonly filePath: string;

  constructor(memoryDir: string) {
    this.filePath = path.join(memoryDir, 'SOUL.md');
  }

  ensureExists(): SoulFile {
    if (!fs.existsSync(this.filePath)) this.save(cloneDefaultSoul());
    return this.load();
  }

  load(): SoulFile {
    try {
      if (!fs.existsSync(this.filePath)) return cloneDefaultSoul();
      return parseSoulMarkdown(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return cloneDefaultSoul();
    }
  }

  save(value: SoulFile): SoulFile {
    const file: SoulFile = { metadata: normalizeSoulMetadata(value.metadata), body: String(value.body || '').replace(/\r\n/g, '\n') };
    const limit = checkSoulBodyLimit(file.body);
    if (limit.isOverLimit) throw new Error(`人格提示词超出限制：${limit.count} / ${limit.limit} tokens。`);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, serializeSoulMarkdown(file), 'utf8');
    fs.renameSync(tempPath, this.filePath);
    return file;
  }

  restoreDefault(): SoulFile {
    return this.save(cloneDefaultSoul());
  }
}

/** Render the app-owned identity sentence and optional user-authored voice. */
export function buildSoulPromptSection(file: SoulFile | undefined | null): string {
  const soul = file || cloneDefaultSoul();
  const metadata = normalizeSoulMetadata(soul.metadata);
  const identity = `你是 ${metadata.name}，运行在 Windows PC 桌面端的 AI 助手，可访问本地文件系统与 Shell。`;
  const style = metadata.style ? `\n\n回复风格：${metadata.style}` : '';
  const lang = metadata.lang && metadata.lang !== 'auto' ? `\n首选回复语言：${metadata.lang}。` : '';
  const body = String(soul.body || '').trim();
  if (!body || checkSoulBodyLimit(body).isOverLimit) return `${identity}${style}${lang}`;
  return `${identity}${style}${lang}\n\n<assistant-personality>\n以下是用户为你设定的长期人格、立场与表达方式。它影响你的角色和语气；用户当前请求与明确指示优先于其中发生冲突的内容。\n\n${body}\n</assistant-personality>`;
}
