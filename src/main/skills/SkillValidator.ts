export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_SKILL_CHARS = 120_000;

/** Validates skill documents as prompt content, never as executable authority. */
export class SkillValidator {
  validate(content: string): SkillValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!content || !content.trim()) errors.push('SKILL.md 内容不能为空。');
    if (content.length > MAX_SKILL_CHARS) errors.push(`SKILL.md 不能超过 ${MAX_SKILL_CHARS} 个字符。`);
    if (content.includes('\0')) errors.push('SKILL.md 不允许包含 NUL 字符。');
    const trimmed = content.trim();
    if (!trimmed.startsWith('---')) warnings.push('缺少 YAML frontmatter；将使用导入时生成的默认元数据。');
    if (trimmed.startsWith('---')) {
      const close = trimmed.indexOf('\n---', 3);
      if (close < 0) errors.push('YAML frontmatter 缺少结束分隔符。');
      else {
        const frontmatter = trimmed.slice(3, close).split(/\r?\n/);
        for (const line of frontmatter) {
          if (!line.trim() || /^\s/.test(line)) continue;
          if (!/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line)) errors.push(`frontmatter 格式无效：${line}`);
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  assertValid(content: string): void {
    const result = this.validate(content);
    if (!result.valid) throw new Error(result.errors.join(' '));
  }
}
