# -*- coding: utf-8 -*-
"""Apply the memory persistence fix to server.ts only."""

import os

ROOT = r'C:\Users\Administrator\Desktop\iEXA-WIN'
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
c = src.count(old3a); assert c == 1, f'3a got {c}'; src = src.replace(old3a, new3a)

# 3b. Add loadSessionSummary + update saveSessionContext signature
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
c = src.count(old3b); assert c == 1, f'3b got {c}'; src = src.replace(old3b, new3b)

# 3c. Add configAnchors array
old3c = '''  const userNotes: string[] = [];
  const toolNotes: string[] = [];
  const addAnchors = (value: unknown) => {'''
new3c = '''  const userNotes: string[] = [];
  const toolNotes: string[] = [];
  const configAnchors: string[] = [];
  const addAnchors = (value: unknown) => {'''
c = src.count(old3c); assert c == 1, f'3c got {c}'; src = src.replace(old3c, new3c)

# 3d. Add extractConfigAnchors + increase userNotes limit
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
c = src.count(old3d); assert c == 1, f'3d got {c}'; src = src.replace(old3d, new3d)

# 3e. toolCalls loop
old3e = '''    for (const call of message.toolCalls || []) {
      addAnchors(call.args);
      addAnchors(call.result?.output);
      const args = JSON.stringify(call.args || {});
      const output = String(call.result?.output || '').trim().substring(0, 900);
      toolNotes.push(`${call.name}: ${args.substring(0, 900)}${output ? `\\n\u7ed3\u679c: ${output}` : ''}`);
    }'''
new3e = '''    for (const call of message.toolCalls || []) {
      addAnchors(call.args);
      addAnchors(call.result?.output);
      extractConfigAnchors(call.args);
      extractConfigAnchors(call.result?.output);
      const args = JSON.stringify(call.args || {});
      const output = String(call.result?.output || '').trim().substring(0, 1200);
      toolNotes.push(`${call.name}: ${args.substring(0, 900)}${output ? `\\n\u7ed3\u679c: ${output}` : ''}`);
    }'''
c = src.count(old3e); assert c == 1, f'3e got {c}'; src = src.replace(old3e, new3e)

# 3f. sections + state
old3f = '''  const sections = [
    '\u6301\u4e45\u5316\u4f1a\u8bdd\u4e0a\u4e0b\u6587\uff08\u6765\u81ea\u672c\u4f1a\u8bdd\u5df2\u4fdd\u5b58\u7684\u6d88\u606f\u3001\u5de5\u5177\u8c03\u7528\u548c\u5de5\u5177\u7ed3\u679c\uff1b\u5176\u4e2d\u7684\u94fe\u63a5\u3001\u8def\u5f84\u3001\u6807\u8bc6\u7b26\u5e94\u89c6\u4e3a\u5df2\u77e5\u4e8b\u5b9e\uff09\uff1a',
    urls.size ? `\u5df2\u51fa\u73b0\u7684\u94fe\u63a5:\\n${[...urls].slice(-80).map((v) => `- ${v}`).join('\\n')}` : '',
    paths.size ? `\u5df2\u51fa\u73b0\u7684\u6587\u4ef6/\u8def\u5f84:\\n${[...paths].slice(-80).map((v) => `- ${v}`).join('\\n')}` : '',
    userNotes.length ? `\u7528\u6237\u7684\u91cd\u8981\u539f\u8bdd\uff08\u6700\u8fd1 ${Math.min(16, userNotes.length)} \u6761\uff09:\\n${userNotes.slice(-16).map((v) => `- ${v}`).join('\\n')}` : '',
    toolNotes.length ? `\u5de5\u5177\u8c03\u7528\u53ca\u7ed3\u679c\u6458\u8981\uff08\u6700\u8fd1 ${Math.min(24, toolNotes.length)} \u6761\uff09:\\n${toolNotes.slice(-24).join('\\n\\n')}` : '',
  ].filter(Boolean);
  const content = sections.join('\\n\\n').substring(0, 30000);
  const state: DurableSessionContext = { version: 1, sessionId, updatedAt: Date.now(), content };'''
new3f = '''  const sections = [
    '\u6301\u4e45\u5316\u4f1a\u8bdd\u4e0a\u4e0b\u6587\uff08\u6765\u81ea\u672c\u4f1a\u8bdd\u5df2\u4fdd\u5b58\u7684\u6d88\u606f\u3001\u5de5\u5177\u8c03\u7528\u548c\u5de5\u5177\u7ed3\u679c\uff1b\u5176\u4e2d\u7684\u94fe\u63a5\u3001\u8def\u5f84\u3001\u6807\u8bc6\u7b26\u5e94\u89c6\u4e3a\u5df2\u77e5\u4e8b\u5b9e\uff09\uff1a',
    uniqueConfig.length ? `\u5173\u952e\u914d\u7f6e/\u53c2\u6570\uff08\u6700\u8fd1 ${Math.min(40, uniqueConfig.length)} \u6761\uff09:\\n${uniqueConfig.slice(-40).map((v) => `- ${v}`).join('\\n')}` : '',
    urls.size ? `\u5df2\u51fa\u73b0\u7684\u94fe\u63a5:\\n${[...urls].slice(-100).map((v) => `- ${v}`).join('\\n')}` : '',
    paths.size ? `\u5df2\u51fa\u73b0\u7684\u6587\u4ef6/\u8def\u5f84:\\n${[...paths].slice(-100).map((v) => `- ${v}`).join('\\n')}` : '',
    userNotes.length ? `\u7528\u6237\u7684\u91cd\u8981\u539f\u8bdd\uff08\u6700\u8fd1 ${Math.min(50, userNotes.length)} \u6761\uff09:\\n${userNotes.slice(-50).map((v) => `- ${v}`).join('\\n')}` : '',
    toolNotes.length ? `\u5de5\u5177\u8c03\u7528\u53ca\u7ed3\u679c\u6458\u8981\uff08\u6700\u8fd1 ${Math.min(40, toolNotes.length)} \u6761\uff09:\\n${toolNotes.slice(-40).join('\\n\\n')}` : '',
  ].filter(Boolean);
  const content = sections.join('\\n\\n').substring(0, 60000);
  const state: DurableSessionContext = { version: 2, sessionId, updatedAt: Date.now(), content, summary: summary || undefined };'''
c = src.count(old3f); assert c == 1, f'3f got {c}'; src = src.replace(old3f, new3f)

# 3g. saveSessionMessages
old3g = '''  saveMessages(sessionId, trimmed);
  saveSessionContext(sessionId, updatedMessages);'''
new3g = '''  saveMessages(sessionId, trimmed);

  // Grab the Codex-style compaction summary from the agent (if any)
  const agent = agentCache.get(sessionId);
  const summary = agent ? agent.getCompactorSummary() : '';
  saveSessionContext(sessionId, updatedMessages, summary);'''
c = src.count(old3g); assert c == 1, f'3g got {c}'; src = src.replace(old3g, new3g)

# 3h. server restore
old3h = '''        agent.setSessionContext(durableContext);
        if (needHydrate) {'''
new3h = '''        agent.setSessionContext(durableContext);
        // Restore Codex-style compaction summary (survives restarts)
        const persistedSummary = loadSessionSummary(sessionId);
        if (persistedSummary) {
          agent.setCompactorSummary(persistedSummary);
        }
        if (needHydrate) {'''
c = src.count(old3h); assert c == 1, f'3h got {c}'; src = src.replace(old3h, new3h)

with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE server.ts — ALL PATCHES APPLIED')