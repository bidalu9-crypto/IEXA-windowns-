// =============================================================================
// IEXA PC - Skill Store (mirrors iOS SkillStore.swift)
// Anthropic-style SKILL.md progressive disclosure
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { SkillValidator } from './SkillValidator';

export type SkillSource = 'file' | 'paste' | 'bundled' | 'session' | 'url';

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  useCount: number;
  body: string;
  /** Explicitly trusted application-level skill. */
  systemPrompt: boolean;
  /** Absolute path to SKILL.md on disk */
  skillPath: string;
  dirPath: string;
}

interface SkillMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  useCount: number;
  systemPrompt?: boolean;
}

interface SkillsIndex {
  skills: SkillMeta[];
}

const MAX_SKILL_METADATA = 20;

export class SkillStore {
  private skillsDir: string;
  private indexFile: string;
  private skills: Skill[] = [];
  private readonly validator = new SkillValidator();

  constructor(baseDir: string) {
    this.skillsDir = path.join(baseDir, 'skills');
    this.indexFile = path.join(baseDir, '.iexa-skills.json');
    fs.mkdirSync(this.skillsDir, { recursive: true });
    this.reload();
  }

  getSkillsDir(): string {
    return this.skillsDir;
  }

  list(): Skill[] {
    return this.skills.slice();
  }

  get(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /** Absolute path the model should file_read */
  skillMdPath(id: string): string {
    return path.join(this.skillsDir, id, 'SKILL.md');
  }

  reload(): void {
    const index = this.loadIndex();
    const byId = new Map(index.skills.map((s) => [s.id, s]));

    // Scan disk for skill dirs
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { /* */ }

    const loaded: Skill[] = [];
    const seen = new Set<string>();

    for (const id of dirs) {
      const dirPath = path.join(this.skillsDir, id);
      const skillPath = path.join(dirPath, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      let raw = '';
      try { raw = fs.readFileSync(skillPath, 'utf-8'); } catch { continue; }
      if (!this.validator.validate(raw).valid) continue;
      const parsed = parseSkillMd(raw);
      const meta = byId.get(id);
      const name = parsed.name || meta?.name || id;
      const description = parsed.description || meta?.description || '';
      const version = parsed.version || meta?.version || '1.0.0';
      const systemPrompt = meta?.systemPrompt ?? parsed.systemPrompt ?? isBuiltInSystemSkill(id);
      loaded.push({
        id,
        name,
        description,
        version,
        source: meta?.source || 'session',
        enabled: meta ? meta.enabled : true,
        installedAt: meta?.installedAt || Date.now(),
        updatedAt: meta?.updatedAt || Date.now(),
        useCount: meta?.useCount || 0,
        body: parsed.body,
        systemPrompt,
        skillPath,
        dirPath,
      });
      seen.add(id);
    }

    // Keep meta for missing dirs cleaned on save
    this.skills = loaded.sort((a, b) => b.updatedAt - a.updatedAt);
    this.saveIndex();
  }

  /** Import from SKILL.md text content */
  importFromContent(content: string, source: SkillSource = 'paste'): Skill {
    this.validator.assertValid(content);
    const parsed = parseSkillMd(content);
    let name = parsed.name || 'Untitled Skill';
    let id = slugify(name);
    if (!id) id = 'skill-' + Date.now().toString(36);

    // Avoid collision
    let finalId = id;
    let n = 2;
    while (this.skills.some((s) => s.id === finalId) || fs.existsSync(path.join(this.skillsDir, finalId))) {
      finalId = `${id}-${n++}`;
    }

    const dirPath = path.join(this.skillsDir, finalId);
    fs.mkdirSync(dirPath, { recursive: true });
    const skillPath = path.join(dirPath, 'SKILL.md');

    // Normalize content to always have frontmatter
    const normalized = ensureSkillMd(content, name, parsed.description, parsed.version || '1.0.0');
    fs.writeFileSync(skillPath, normalized, 'utf-8');

    const now = Date.now();
    const skill: Skill = {
      id: finalId,
      name,
      description: parsed.description || '',
      version: parsed.version || '1.0.0',
      source,
      enabled: true,
      installedAt: now,
      updatedAt: now,
      useCount: 0,
      body: parsed.body,
      systemPrompt: parsed.systemPrompt ?? isBuiltInSystemSkill(finalId),
      skillPath,
      dirPath,
    };
    this.skills.unshift(skill);
    this.saveIndex();
    return skill;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const s = this.skills.find((x) => x.id === id);
    if (!s) return false;
    s.enabled = enabled;
    s.updatedAt = Date.now();
    this.saveIndex();
    return true;
  }

  setSystemPrompt(id: string, value: boolean): boolean {
    const s = this.skills.find((x) => x.id === id);
    if (!s) return false;
    s.systemPrompt = value;
    s.updatedAt = Date.now();
    this.saveIndex();
    return true;
  }

  delete(id: string): boolean {
    const idx = this.skills.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const s = this.skills[idx];
    this.skills.splice(idx, 1);
    try {
      fs.rmSync(s.dirPath, { recursive: true, force: true });
    } catch { /* */ }
    this.saveIndex();
    return true;
  }

  recordUse(id: string): void {
    const s = this.skills.find((x) => x.id === id);
    if (!s) return;
    s.useCount = (s.useCount || 0) + 1;
    s.updatedAt = Date.now();
    this.saveIndex();
  }

  /** If path points at a skill SKILL.md, return skill id */
  skillIdFromPath(filePath: string): string | null {
    if (!filePath) return null;
    const norm = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
    const root = path.resolve(this.skillsDir).replace(/\\/g, '/').toLowerCase();
    if (!norm.startsWith(root)) return null;
    // .../skills/<id>/SKILL.md
    const rel = norm.slice(root.length).replace(/^\//, '');
    const parts = rel.split('/');
    if (parts.length >= 2 && parts[1].toLowerCase() === 'skill.md') {
      return parts[0];
    }
    // Also match if model used relative path skills/<id>/SKILL.md
    const m = filePath.replace(/\\/g, '/').match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i);
    if (m) return m[1];
    return null;
  }

  /**
   * iOS-style progressive disclosure fragment for system prompt.
   * Only name + description + path — model file_reads SKILL.md for full body.
   */
  skillPromptFragment(): string | null {
    const enabled = this.skills.filter((s) => s.enabled);
    if (enabled.length === 0) return null;

    let selected: Skill[];
    let hasMore = false;

    if (enabled.length <= MAX_SKILL_METADATA) {
      selected = enabled.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      const picked: Skill[] = [];
      const seen = new Set<string>();

      // Priority 1: bundled
      for (const s of enabled) {
        if (s.source === 'bundled' && !seen.has(s.id)) {
          picked.push(s);
          seen.add(s.id);
        }
      }

      // Priority 2: recent 7 days (up to 10)
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const recent = enabled
        .filter((s) => s.updatedAt > weekAgo && !seen.has(s.id))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const recentLimit = Math.min(10, MAX_SKILL_METADATA - picked.length);
      for (const s of recent.slice(0, recentLimit)) {
        picked.push(s);
        seen.add(s.id);
      }

      // Priority 3: by useCount
      if (picked.length < MAX_SKILL_METADATA) {
        const remaining = MAX_SKILL_METADATA - picked.length;
        const byUsage = enabled
          .filter((s) => !seen.has(s.id))
          .sort((a, b) => b.useCount - a.useCount);
        for (const s of byUsage.slice(0, remaining)) {
          picked.push(s);
          seen.add(s.id);
        }
      }
      selected = picked;
      hasMore = enabled.length > selected.length;
    }

    const skillsRoot = this.skillsDir.replace(/\\/g, '/');
    let xml = '<available_skills>\n';
    for (const skill of selected) {
      let desc = skill.description || '';
      if (desc.length > 200) desc = desc.substring(0, 200) + '…';
      const skillPath = skill.skillPath.replace(/\\/g, '/');
      xml += '  <skill>\n';
      xml += `    <name>${xmlEscape(skill.name)}</name>\n`;
      xml += `    <description>${xmlEscape(desc)}</description>\n`;
      xml += `    <path>${xmlEscape(skillPath)}</path>\n`;
      xml += '  </skill>\n';
    }
    xml += '</available_skills>';

    let fragment =
      'Skills:\n' +
      `Reusable instruction sets stored at ${skillsRoot}/<name>/SKILL.md. ` +
      'Read the SKILL.md file with file_read to load full instructions before using a skill.\n\n' +
      xml;

    if (hasMore) {
      const omitted = enabled.filter((s) => !selected.some((x) => x.id === s.id));
      const names = omitted.slice(0, 100 - selected.length).map((s) => s.name).join(', ');
      fragment += `\n\n${omitted.length} more skills not shown above: ${names}. List ${skillsRoot}/ or search to find all.`;
    }

    return fragment;
  }

  /**
   * Full bodies for explicitly trusted application-level skills. Ordinary
   * imported skills remain catalog-only and are loaded through file_read.
   */
  systemPromptFragment(): string | null {
    const selected = this.skills
      .filter((s) => s.enabled && s.systemPrompt && s.body.trim())
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (selected.length === 0) return null;

    const sections: string[] = [];
    let total = 0;
    const maxTotal = 60000;
    const maxBody = 30000;
    for (const skill of selected) {
      const body = skill.body.trim();
      const clipped = body.length > maxBody
        ? body.slice(0, maxBody) + '\n\n[内置技能正文已截断]'
        : body;
      if (total + clipped.length > maxTotal) break;
      total += clipped.length;
      sections.push(`### ${skill.name} (v${skill.version})\n${clipped}`);
    }
    if (sections.length === 0) return null;
    return [
      '## 内置系统技能（应用级指令）',
      '以下技能由 IEXA 应用内置并在每次请求中加载。它们属于系统提示词，不是用户消息，也不需要通过 file_read 再加载。',
      '系统安全边界、工具权限和本系统明确约束始终优先于技能正文。',
      '',
      sections.join('\n\n'),
    ].join('\n');
  }

  private loadIndex(): SkillsIndex {
    try {
      if (fs.existsSync(this.indexFile)) {
        const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
        if (raw && Array.isArray(raw.skills)) return raw as SkillsIndex;
      }
    } catch { /* */ }
    return { skills: [] };
  }

  private saveIndex(): void {
    const index: SkillsIndex = {
      skills: this.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        source: s.source,
        enabled: s.enabled,
        installedAt: s.installedAt,
        updatedAt: s.updatedAt,
        useCount: s.useCount,
        systemPrompt: s.systemPrompt,
      })),
    };
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');
  }
}

// ---- Parsing helpers ----

export interface ParsedSkillMD {
  name: string;
  description: string;
  version: string;
  body: string;
  systemPrompt?: boolean;
}

export function parseSkillMd(content: string): ParsedSkillMD {
  const result: ParsedSkillMD = { name: '', description: '', version: '', body: content };
  const lines = content.split(/\r?\n/);
  const trimmed = content.trim();
  const hasOpening = trimmed.startsWith('---');

  let frontmatterEnd: number | undefined;
  const scanStart = hasOpening ? 1 : 0;
  for (let i = scanStart; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      frontmatterEnd = i;
      break;
    }
  }
  if (frontmatterEnd == null) {
    result.body = content;
    return result;
  }

  if (!hasOpening) {
    // headless frontmatter must look like key: value with recognized keys
    let sawRecognized = false;
    let ok = true;
    for (let i = scanStart; i < frontmatterEnd; i++) {
      const line = lines[i];
      const stripped = line.trim();
      if (!stripped) continue;
      if (line[0] === ' ' || line[0] === '\t') continue;
      const colon = line.indexOf(':');
      if (colon < 0) { ok = false; break; }
      const key = line.slice(0, colon).trim().toLowerCase();
      if (!key || !/^[a-z0-9_-]+$/i.test(key)) { ok = false; break; }
      if (key === 'name' || key === 'description' || key === 'version') sawRecognized = true;
    }
    if (!ok || !sawRecognized) {
      result.body = content;
      return result;
    }
  }

  let i = scanStart;
  while (i < frontmatterEnd) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();

    // YAML block scalar | or >
    if (value.startsWith('|') || value.startsWith('>')) {
      const blockLines: string[] = [];
      i++;
      while (i < frontmatterEnd) {
        const bl = lines[i];
        if (bl.length > 0 && bl[0] !== ' ' && bl[0] !== '\t' && bl.includes(':')) break;
        blockLines.push(bl.replace(/^\s{1,2}/, ''));
        i++;
      }
      value = blockLines.join('\n').trim();
    } else {
      // strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      i++;
    }

    if (key === 'name') result.name = value;
    else if (key === 'description') result.description = value;
    else if (key === 'version') result.version = value;
    else if (key === 'systemprompt' || key === 'system_prompt' || key === 'system') {
      result.systemPrompt = /^(true|yes|1|on)$/i.test(value);
    }
  }

  result.body = lines.slice(frontmatterEnd + 1).join('\n').replace(/^\n+/, '');
  return result;
}

function isBuiltInSystemSkill(id: string): boolean {
  return id.toLowerCase() === 'gpt-5-6-instruct';
}

function ensureSkillMd(content: string, name: string, description: string, version: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('---')) return content.endsWith('\n') ? content : content + '\n';
  // Rebuild with frontmatter
  const parsed = parseSkillMd(content);
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: ${description || parsed.description || ''}\n` +
    `version: ${version}\n` +
    `---\n\n` +
    (parsed.body || content).trim() +
    `\n`
  );
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64) || 'skill';
}

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Install a couple of built-in example skills if none exist */
export function ensureBundledSkills(store: SkillStore): void {
  if (store.list().length > 0) return;

  store.importFromContent(`---
name: code-review
description: 对当前项目做代码审查：风格、潜在 bug、安全与可维护性，并给出可执行修改建议。
version: 1.0.0
---

# Code Review Skill

当用户请求代码审查或 review 时：

1. 先用 file_read / shell 了解项目结构（package.json、主要源码目录）
2. 重点检查：错误处理、边界条件、安全（注入/密钥）、重复代码
3. 用简洁中文列出问题（严重 / 建议 / 风格），并给出具体修改方案
4. 需要改代码时用 file_edit，不要整文件重写
`, 'bundled');

  store.importFromContent(`---
name: git-commit
description: 根据当前 git diff 生成规范的中文 commit message，并按用户确认执行提交。
version: 1.0.0
---

# Git Commit Skill

当用户要提交代码或写 commit message 时：

1. 运行 \`git status\` 与 \`git diff\`（及 staged diff）了解变更
2. 用一行中文概括变更（type: feat/fix/docs/refactor/chore）
3. 先把 message 给用户确认，确认后再执行 \`git add\` / \`git commit\`
4. 不要 force push，不要改 git config
`, 'bundled');
}
