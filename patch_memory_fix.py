# -*- coding: utf-8 -*-
"""Apply the Codex-style memory persistence fix to the three files."""

import os

ROOT = r'C:\Users\Administrator\Desktop\iEXA-WIN'

# ---- 1. ContextCompactor.ts ----
fp = os.path.join(ROOT, 'src', 'main', 'agent', 'ContextCompactor.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

old = '''  recordProviderUsage(inputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) this.lastReportedInputTokens = inputTokens;
  }

  /** Returns a compacted history only if threshold policy says compaction is needed. */'''

new = '''  recordProviderUsage(inputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) this.lastReportedInputTokens = inputTokens;
  }

  /** Expose the current summary for persistence across restarts. */
  getSummary(): string {
    return this.summary;
  }

  /** Restore a previously persisted summary (e.g. after app restart). */
  setSummary(summary: string): void {
    this.summary = summary;
  }

  /** Returns a compacted history only if threshold policy says compaction is needed. */'''

count = src.count(old)
assert count == 1, f'ContextCompactor: expected 1 match, got {count}'
src = src.replace(old, new)
with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE ContextCompactor.ts')

# ---- 2. AgentLoop.ts ----
fp = os.path.join(ROOT, 'src', 'main', 'agent', 'AgentLoop.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

# 2a. Add compactor field after sessionContext
old2a = '''  /** Durable per-session anchors supplied by the server after rehydration. */
  private sessionContext = '''

new2a = '''  /** Durable per-session anchors supplied by the server after rehydration. */
  private sessionContext = '';
  /** Codex-style compaction engine; kept as a field so the server can persist the summary. */
  private compactor: ContextCompactor | null = null;'''

count2a = src.count(old2a)
assert count2a == 1, f'AgentLoop field: expected 1 match, got {count2a}'
src = src.replace(old2a, new2a)

# 2b. Add getCompactorSummary/setCompactorSummary after setSessionContext
old2b = '''  setSessionContext(context: string | null | undefined): void {
    this.sessionContext = typeof context === 'string' ? context.trim() : '';
  }

  /**'''

new2b = '''  setSessionContext(context: string | null | undefined): void {
    this.sessionContext = typeof context === 'string' ? context.trim() : '';
  }

  /** Current Codex-style compaction summary (persisted across restarts). */
  getCompactorSummary(): string {
    return this.compactor ? this.compactor.getSummary() : '';
  }

  /** Restore a persisted compaction summary after restart. */
  setCompactorSummary(summary: string | null | undefined): void {
    if (this.compactor && typeof summary === 'string' && summary.trim()) {
      this.compactor.setSummary(summary.trim());
    }
  }

  /**'''

count2b = src.count(old2b)
assert count2b == 1, f'AgentLoop methods: expected 1 match, got {count2b}'
src = src.replace(old2b, new2b)

# 2c. Assign this.compactor = compactor after compactor creation
old2c = '''    const compactor = new ContextCompactor(this.config.provider, contextWindow, tools, systemPrompt);
    let turnCount = 0;'''

new2c = '''    const compactor = new ContextCompactor(this.config.provider, contextWindow, tools, systemPrompt);
    this.compactor = compactor;
    let turnCount = 0;'''

count2c = src.count(old2c)
assert count2c == 1, f'AgentLoop assign: expected 1 match, got {count2c}'
src = src.replace(old2c, new2c)

with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE AgentLoop.ts')

# ---- 3. server.ts ----
fp = os.path.join(ROOT, 'src', 'main', 'server.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

# 3a. Upgrade DurableSessionContext to version 2, add summary field
old3a = '''interface DurableSessionContext {
  version: 1;
  sessionId: string;
  updatedAt: number;
  content: string;
}'''

new3a = '''interface DurableSessionContext {
  version: 2;
  sessionId: string;
  updatedAt: number;
  content: string;
  /** Codex-style rolling summary of the compacted past (survives restarts). */
  summary?: string;
}'''

count3a = src.count(old3a)
assert count3a == 1, f'server DurableSessionContext: expected 1 match, got {count3a}'
src = src.replace(old3a, new3a)

# 3b. Add loadSessionSummary function, update saveSessionContext signature
old3b = '''function loadSessionContext(sessionId: string): string {
  try {
    const fp = sessionContextPath(sessionId);
    if (!fs.existsSync(fp)) return '';
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<DurableSessionContext>;
    return typeof state.content === 'string' ? state.content : '';
  } catch { return ''; }
}

function saveSessionContext(sessionId: string, messages: ChatMessage[]): void {'''

new3b = '''function loadSessionContext(sessionId: string): string {
  try {
    const fp = sessionContextPath(sessionId);
    if (!fs.existsSync(fp)) return '';
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<DurableSessionContext>;
    return typeof state.content === 'string' ? state.content : '';
  } catch { return ''; }
}

/** Load the persisted Codex-style compaction summary for a session. */
function loadSessionSummary(sessionId: string): string {
  try {
    const fp = sessionContextPath(sessionId);
    if (!fs.existsSync(fp)) return '';
    const state = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<DurableSessionContext>;
    return typeof state.summary === 'string' ? state.summary : '';
  } catch { return ''; }
}

function saveSessionContext(sessionId: string, messages: ChatMessage[], summary = ''): void {'''

count3b = src.count(old3b)
assert count3b == 1, f'server loadSessionSummary: expected 1 match, got {count3b}'
src = src.replace(old3b, new3b)

# 3c. Add configAnchors array
old3c = '''  const userNotes: string[] = [];
  const toolNotes: string[] = [];
  const addAnchors = (value: unknown) => {'''

new3c = '''  const userNotes: string[] = [];
  const toolNotes: string[] = [];
  const configAnchors: string[] = [];
  const addAnchors = (value: unknown) => {'''

count3c = src.count(old3c)
assert count3c == 1, f'server configAnchors: expected 1 match, got {count3c}'
src = src.replace(old3c, new3c)

# 3d. Add extractConfigAnchors function, increase userNotes limit
old3d = '''  for (const message of messages) {
    addAnchors(message.content);
    if (message.role === 'user' && message.content?.trim()) {
      userNotes.push(message.content.trim().substring(0, 700));
    }'''

new3d = '''  // Extract config-style facts (key=value pairs) that must survive trimming:
  // API keys, base URLs, model names, output dirs, file paths.
  const extractConfigAnchors = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    // e.g. API_KEY_EDU = "sk-...", OUTPUT_DIR = "C:\\...", --model gpt-image-2-edu
    const kv = text.match(/(?:API_KEY|BASE_URL|OUTPUT_DIR|BASEURL|API_BASE|MODEL|model|base_url|output_dir|api_key|baseurl)\\s*[=:]\\s*["']?([A-Za-z0-9_\\-.:\\\\\\/]+)["']?/gi) || [];
    const modelArgs = text.match(/--model\\s+([A-Za-z0-9_.\\-]+)/gi) || [];
    for (const m of [...kv, ...modelArgs].slice(-40)) {
      const clean = m.replace(/[.,;]+$/, '');
      if (clean.length > 4 && clean.length < 200) configAnchors.push(clean);
    }
  };
  for (const message of messages) {
    addAnchors(message.content);
    extractConfigAnchors(message.content);
    if (message.role === 'user' && message.content?.trim()) {
      userNotes.push(message.content.trim().substring(0, 2000));
    }'''

count3d = src.count(old3d)
assert count3d == 1, f'server extractConfig: expected 1 match, got {count3d}'
src = src.replace(old3d, new3d)

# 3e. Add extractConfigAnchors to tool calls, increase limits
# Note: the original file has literal \\n (backslash-n) in the template literal
old3e = '''    for (const call of message.toolCalls || []) {
      addAnchors(call.args);
      addAnchors(call.result?.output);
      const args = JSON.stringify(call.args || {});
      const output = String(call.result?.output || '').trim().substring(0, 900);
      toolNotes.push(`${call.name}: ${args.substring(0, 900)}${output ? `\\n结果: ${output}` : ''}`);
    }'''

new3e = '''    for (const call of message.toolCalls || []) {
      addAnchors(call.args);
      addAnchors(call.result?.output);
      extractConfigAnchors(call.args);
      extractConfigAnchors(call.result?.output);
      const args = JSON.stringify(call.args || {});
      const output = String(call.result?.output || '').trim().substring(0, 1200);
      toolNotes.push(`${call.name}: ${args.substring(0, 900)}${output ? `\\n结果: ${output}` : ''}`);
    }'''

count3e = src.count(old3e)
assert count3e == 1, f'server tool call: expected 1 match, got {count3e}'
src = src.replace(old3e, new3e)

# 3f. Update sections - add config anchors, increase limits, add summary
old3f = '''  const sections = [
    '持久化会话上下文（来自本会话已保存的消息、工具调用和工具结果；其中的链接、路径、标识符应视为已知事实）：',
    urls.size ? `已出现的链接:\\n${[...urls].slice(-80).map((v) => `- ${v}`).join('\\n')}` : '',
    paths.size ? `已出现的文件/路径:\\n${[...paths].slice(-80).map((v) => `- ${v}`).join('\\n')}` : '',
    userNotes.length ? `用户的重要原话（最近 ${Math.min(16, userNotes.length)} 条）:\\n${userNotes.slice(-16).map((v) => `- ${v}`).join('\\n')}` : '',
    toolNotes.length ? `工具调用及结果摘要（最近 ${Math.min(24, toolNotes.length)} 条）:\\n${toolNotes.slice(-24).join('\\n\\n')}` : '',
  ].filter(Boolean);
  const content = sections.join('\\n\\n').substring(0, 30000);
  const state: DurableSessionContext = { version: 1, sessionId, updatedAt: Date.now(), content };'''

new3f = '''  const sections = [
    '持久化会话上下文（来自本会话已保存的消息、工具调用和工具结果；其中的链接、路径、标识符应视为已知事实）：',
    uniqueConfig.length ? `关键配置/参数（最近 ${Math.min(40, uniqueConfig.length)} 条）:\\n${uniqueConfig.slice(-40).map((v) => `- ${v}`).join('\\n')}` : '',
    urls.size ? `已出现的链接:\\n${[...urls].slice(-100).map((v) => `- ${v}`).join('\\n')}` : '',
    paths.size ? `已出现的文件/路径:\\n${[...paths].slice(-100).map((v) => `- ${v}`).join('\\n')}` : '',
    userNotes.length ? `用户的重要原话（最近 ${Math.min(50, userNotes.length)} 条）:\\n${userNotes.slice(-50).map((v) => `- ${v}`).join('\\n')}` : '',
    toolNotes.length ? `工具调用及结果摘要（最近 ${Math.min(40, toolNotes.length)} 条）:\\n${toolNotes.slice(-40).join('\\n\\n')}` : '',
  ].filter(Boolean);
  const content = sections.join('\\n\\n').substring(0, 60000);
  const state: DurableSessionContext = { version: 2, sessionId, updatedAt: Date.now(), content, summary: summary || undefined };'''

count3f = src.count(old3f)
assert count3f == 1, f'server sections: expected 1 match, got {count3f}'
src = src.replace(old3f, new3f)

# 3g. Update saveSessionMessages to pass summary
old3g = '''  saveMessages(sessionId, trimmed);
  saveSessionContext(sessionId, updatedMessages);'''

new3g = '''  saveMessages(sessionId, trimmed);

  // Grab the Codex-style compaction summary from the agent (if any)
  const agent = agentCache.get(sessionId);
  const summary = agent ? agent.getCompactorSummary() : '';
  saveSessionContext(sessionId, updatedMessages, summary);'''

count3g = src.count(old3g)
assert count3g == 1, f'server saveSessionMessages: expected 1 match, got {count3g}'
src = src.replace(old3g, new3g)

# 3h. Add summary restoration after agent.setSessionContext
old3h = '''        agent.setSessionContext(durableContext);
        if (needHydrate) {'''

new3h = '''        agent.setSessionContext(durableContext);
        // Restore Codex-style compaction summary (survives restarts)
        const persistedSummary = loadSessionSummary(sessionId);
        if (persistedSummary) {
          agent.setCompactorSummary(persistedSummary);
        }
        if (needHydrate) {'''

count3h = src.count(old3h)
assert count3h == 1, f'server restore: expected 1 match, got {count3h}'
src = src.replace(old3h, new3h)

with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE server.ts')
print('ALL THREE FILES PATCHED SUCCESSFULLY')