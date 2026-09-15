from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]

# Frontend level catalog
p = root / 'src/renderer/app.js'
s = p.read_text(encoding='utf-8')
s = re.sub(
    r"const THINKING_LEVELS = \{.*?\n\};",
    """const THINKING_LEVELS = {
  off: { id: 'off', label: '关闭', desc: '不启用额外思考' },
  low: { id: 'low', label: '低', desc: '快速轻量推理' },
  medium: { id: 'medium', label: '标准', desc: '平衡速度与深度' },
  high: { id: 'high', label: '高', desc: '更深入的长思考' },
  xhigh: { id: 'xhigh', label: '超高', desc: '最大化推理深度' },
  max: { id: 'max', label: '最大', desc: '使用模型允许的最大思考' },
  ultra: { id: 'ultra', label: 'Ultra', desc: '更强的深度推理模式' },
};""",
    s, count=1, flags=re.S)
# Replace the existing four-option menu with the seven iOS-aligned options.
option_block = """                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"off\" role=\"option\"><span class=\"thinking-level-option-title\">关闭</span><span class=\"thinking-level-option-desc\">不启用额外思考</span></button>
                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"low\" role=\"option\"><span class=\"thinking-level-option-title\">低</span><span class=\"thinking-level-option-desc\">快速轻量推理</span></button>
                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"medium\" role=\"option\"><span class=\"thinking-level-option-title\">标准</span><span class=\"thinking-level-option-desc\">平衡速度与深度</span></button>
                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"high\" role=\"option\"><span class=\"thinking-level-option-title\">高</span><span class=\"thinking-level-option-desc\">更深入的长思考</span></button>
                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"xhigh\" role=\"option\"><span class=\"thinking-level-option-title\">超高</span><span class=\"thinking-level-option-desc\">最大化推理深度</span></button>
                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"max\" role=\"option\"><span class=\"thinking-level-option-title\">最大</span><span class=\"thinking-level-option-desc\">使用模型允许的最大思考</span></button>
                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"ultra\" role=\"option\"><span class=\"thinking-level-option-title\">Ultra</span><span class=\"thinking-level-option-desc\">更强的深度推理模式</span></button>"""
s = re.sub(r"                  <button type=\"button\" class=\"thinking-level-option\" data-level=\"off\".*?                  </button>\n                </div>", option_block + "\n                </div>", s, count=1, flags=re.S)
p.write_text(s, encoding='utf-8')

# Server settings and normalization
p = root / 'src/main/server.ts'
s = p.read_text(encoding='utf-8')
s = s.replace("thinkingLevel?: 'off' | 'low' | 'medium' | 'high';", "thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';")
s = s.replace("function normalizeThinkingLevel(v: unknown): 'off' | 'low' | 'medium' | 'high' {", "function normalizeThinkingLevel(v: unknown): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {")
s = s.replace("if (id === 'off' || id === 'low' || id === 'medium' || id === 'high') return id;", "if (id === 'off' || id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh' || id === 'max' || id === 'ultra') return id;")
s = s.replace("function getThinkingLevel(): 'off' | 'low' | 'medium' | 'high' {", "function getThinkingLevel(): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {")
p.write_text(s, encoding='utf-8')

# Provider config type
p = root / 'src/main/providers/types.ts'
s = p.read_text(encoding='utf-8').replace("thinkingLevel?: 'off' | 'low' | 'medium' | 'high';", "thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';")
p.write_text(s, encoding='utf-8')

# Anthropic and Gemini budgets follow iOS's increasing ladder.
for name, old, new in [
 ('AnthropicProvider.ts', """      off: 0,
      low: 1024,
      medium: 8000,
      high: 20000,""", """      off: 0,
      low: 8192,
      medium: 32768,
      high: 65536,
      xhigh: maxTokens,
      max: maxTokens,
      ultra: maxTokens,"""),
 ('GeminiProvider.ts', """      off: 0,
      low: 1024,
      medium: 8192,
      high: 24576,""", """      off: 0,
      low: 1024,
      medium: 8192,
      high: 16384,
      xhigh: 32768,
      max: 32768,
      ultra: 32768,"""),
]:
 p = root / 'src/main/providers' / name
 s = p.read_text(encoding='utf-8').replace(old, new)
 p.write_text(s, encoding='utf-8')

# OpenAI-compatible providers: xhigh is wire xhigh, max/ultra clamp to max like iOS.
p = root / 'src/main/providers/OpenAIProvider.ts'
s = p.read_text(encoding='utf-8')
s = s.replace("      high: 24576,", "      high: 16384,\n      xhigh: 32768,\n      max: 32768,\n      ultra: 32768,")
s = s.replace("    body.reasoning_effort = level; // low | medium | high", "    // iOS uses seven local levels; Ultra is a client label and maps to max on wire.\n    body.reasoning_effort = level === 'ultra' || level === 'max' ? 'max' : level; // low | medium | high | xhigh | max")
p.write_text(s, encoding='utf-8')

# Update comments only where they describe the old four-level set.
for path in [root / 'src/renderer/app.js', root / 'src/main/server.ts']:
 s = path.read_text(encoding='utf-8').replace('off / low / medium / high', 'off / low / medium / high / xhigh / max / ultra')
 path.write_text(s, encoding='utf-8')

print('aligned thinking levels')
