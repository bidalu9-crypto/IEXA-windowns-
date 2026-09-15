import { redactSecrets } from '../errors/IexaError';
import { AgentMessage, AgentToolDefinition } from '../providers/types';

export interface PromptRequest {
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
}
export interface PromptPreview {
  capturedAt: number;
  expiresAt: number;
  provider: string;
  model: string;
  text: string;
  truncated: boolean;
  originalCharacters: number;
  warning: string;
}
/** Explicit opt-in, one next provider call, sanitized memory only, bounded TTL. */
export class PromptPreviewStore {
  private entries = new Map<string, { expiresAt: number; timer?: NodeJS.Timeout; preview?: PromptPreview }>();
  constructor(private readonly secrets: () => string[] = () => [], private readonly now = Date.now) {}
  private prune(): void {
    for (const [id, value] of this.entries) if (value.expiresAt <= this.now()) this.clear(id);
  }
  arm(sessionId: string): void {
    this.prune();
    this.clear(sessionId);
    while (this.entries.size >= 16) this.clear(this.entries.keys().next().value!);
    const timer = setTimeout(() => this.clear(sessionId), 5 * 60_000); timer.unref();
    this.entries.set(sessionId, { expiresAt: this.now() + 5 * 60_000, timer });
  }
  clear(sessionId: string): void { clearTimeout(this.entries.get(sessionId)?.timer); this.entries.delete(sessionId); }
  read(sessionId: string): { armed: boolean; preview: PromptPreview | null } {
    this.prune();
    const entry = this.entries.get(sessionId);
    return { armed: !!entry && !entry.preview, preview: entry?.preview || null };
  }
  capture(request: PromptRequest): void {
    this.prune();
    const entry = this.entries.get(request.sessionId);
    if (!entry || entry.preview) return;
    const sensitive = /^(?:authorization|cookie|set-cookie|password|passwd|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret)$/i;
    let text = JSON.stringify({ systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools }, (key, value) => {
      if (sensitive.test(key)) return '[REDACTED]';
      if (/^(?:data|base64|imageData|imageUrl|image_url)$/.test(key)) return '[MEDIA OMITTED]';
      return value;
    }, 2);
    for (const secret of this.secrets().filter(Boolean).sort((a,b) => b.length-a.length)) {
      for (const form of new Set([secret, JSON.stringify(secret).slice(1,-1)])) text = text.split(form).join('[REDACTED]');
    }
    text = redactSecrets(text)
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)([^\s,;"\\]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[MEDIA OMITTED]');
    const limit = 256_000;
    entry.preview = {
      capturedAt: this.now(), expiresAt: entry.expiresAt,
      provider: redactSecrets(request.provider), model: redactSecrets(request.model),
      text: text.slice(0, limit), originalCharacters: text.length, truncated: text.length > limit,
      warning: '实际主模型调用前的应用层输入（不是服务商最终 HTTP 请求体）；包含系统指令、压缩后历史与工具定义。已做尽力脱敏，仍可能含私密正文，请勿直接分享。媒体已省略；仅保存在内存，5 分钟内失效。',
    };
  }
}
