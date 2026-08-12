// =============================================================================
// IEXA PC - HTTP Server (multi-model profiles)
// =============================================================================

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { AgentLoop, AgentLoopConfig } from './agent/AgentLoop';
import { compactThresholdForWindow, contextWindowForModel, estimateMessageTokens } from './agent/ContextCompactor';
import { ProviderFactory } from './providers/ProviderFactory';
import { makeAgentTools } from './tools/ToolDefinitions';
import { AgentLoopCallbacks, LLMUsage, ProviderType } from './providers/types';
import { setConfigFile, loadConfig, saveConfig, testConnection, syncAll, WebDAVConfig } from './webdav-sync';
import {
  MAX_TITLE_ATTEMPTS,
  buildConversationSummary,
  callModelForTitle,
  fallbackTitleFromFirstUserMessage,
} from './session-title';
import { SkillStore, ensureBundledSkills } from './skills/SkillStore';
import { maxThinkingLevel } from './providers/ModelCapabilities';

const PORT = 19840;
/** App data dir (sessions / settings / memory) — always under iexa workspace */
const WORKSPACE_DIR = process.env.IEXA_WORKSPACE || path.join(process.cwd(), 'workspace');
const MEMORY_DIR = path.join(WORKSPACE_DIR, '.iexa-memory');
const SETTINGS_FILE = path.join(WORKSPACE_DIR, '.iexa-settings.json');
const SESSIONS_FILE = path.join(WORKSPACE_DIR, '.iexa-sessions.json');
const SESSIONS_DIR = path.join(WORKSPACE_DIR, '.iexa-sessions');
const SESSION_CONTEXT_DIR = path.join(WORKSPACE_DIR, '.iexa-session-context');
const WEBDAV_CONFIG_FILE = path.join(WORKSPACE_DIR, '.iexa-webdav.json');
const PROJECT_FILE = path.join(WORKSPACE_DIR, '.iexa-project.json');
const TOKEN_USAGE_FILE = path.join(WORKSPACE_DIR, '.iexa-token-usage.json');
const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'src', 'renderer');

setConfigFile(WEBDAV_CONFIG_FILE);

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(SESSION_CONTEXT_DIR, { recursive: true });

// Skills (iOS-style progressive disclosure via SKILL.md)
const skillStore = new SkillStore(WORKSPACE_DIR);
ensureBundledSkills(skillStore);

/** Currently opened user project (like OpenCode cwd). null = none selected. */
interface ProjectState {
  root: string | null;
  recent: string[];
}

function loadProjectState(): ProjectState {
  try {
    if (fs.existsSync(PROJECT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf-8'));
      const root = typeof raw.root === 'string' && raw.root && fs.existsSync(raw.root) && fs.statSync(raw.root).isDirectory()
        ? path.resolve(raw.root)
        : null;
      const recent = Array.isArray(raw.recent)
        ? raw.recent.filter((p: unknown) => typeof p === 'string' && p && fs.existsSync(p as string)).slice(0, 12)
        : [];
      return { root, recent };
    }
  } catch { /* */ }
  return { root: null, recent: [] };
}

function saveProjectState(state: ProjectState): void {
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

let projectState = loadProjectState();

/** Active project root for tools + file browser; null when none. */
function getProjectRoot(): string | null {
  if (projectState.root && fs.existsSync(projectState.root) && fs.statSync(projectState.root).isDirectory()) {
    return projectState.root;
  }
  return null;
}

function projectInfo(): {
  root: string | null;
  name: string | null;
  recent: Array<{ path: string; name: string }>;
} {
  const root = getProjectRoot();
  return {
    root,
    name: root ? path.basename(root) : null,
    recent: projectState.recent.map((p) => ({ path: p, name: path.basename(p) })),
  };
}

function setProjectRoot(root: string | null): {
  ok: boolean;
  error?: string;
  project?: ReturnType<typeof projectInfo>;
} {
  if (root == null || root === '') {
    projectState.root = null;
    saveProjectState(projectState);
    // Drop agents so next turn picks up new cwd + system prompt
    for (const id of [...agentCache.keys()]) cancelSessionAgent(id);
    return { ok: true, project: projectInfo() };
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: '文件夹不存在' };
  }
  projectState.root = abs;
  projectState.recent = [abs, ...projectState.recent.filter((p) => p !== abs)].slice(0, 12);
  saveProjectState(projectState);
  for (const id of [...agentCache.keys()]) cancelSessionAgent(id);
  return { ok: true, project: projectInfo() };
}

// ---- Profile Types ----
interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

interface AppSettings {
  profiles: ModelProfile[];
  activeProfileId: string;
  /** Global thinking effort: off | low | medium | high (iOS-style). */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

// ---- Settings I/O ----
function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      // Migrate old format
      if (!raw.profiles && raw.provider) {
        return {
          profiles: [{
            id: 'default',
            name: '默认',
            provider: raw.provider || 'anthropic',
            model: raw.model || 'claude-sonnet-4-20250514',
            apiKey: raw.apiKey || '',
            baseURL: raw.baseURL || '',
          }],
          activeProfileId: 'default',
        };
      }
      return {
        profiles: raw.profiles || [],
        activeProfileId: raw.activeProfileId || raw.profiles?.[0]?.id || '',
        thinkingLevel: normalizeThinkingLevel(raw.thinkingLevel),
      };
    }
  } catch { /* ignore */ }
  return { profiles: [], activeProfileId: '', thinkingLevel: 'medium' };
}

function normalizeThinkingLevel(v: unknown): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {
  const id = String(v || '').toLowerCase();
  if (id === 'off' || id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh' || id === 'max' || id === 'ultra') return id;
  return 'medium';
}

function getThinkingLevel(): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {
  return normalizeThinkingLevel(loadSettings().thinkingLevel);
}

function saveSettings(s: AppSettings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

function activeProfile(): ModelProfile | null {
  const s = loadSettings();
  return s.profiles.find(p => p.id === s.activeProfileId) || s.profiles[0] || null;
}

function maskKey(key: string): string {
  if (!key || key.length < 12) return key ? '***' : '';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

// ---- Session Types ----
interface ChatAttachmentMeta {
  name: string;
  mime: string;
  kind: 'image' | 'text' | 'file';
  savedPath?: string;
  /** Small preview only for images (may be omitted for large files on reload) */
  previewUrl?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown>; result?: { output: string; success: boolean; fileChange?: NonNullable<import('./providers/types').ToolExecutionResult['fileChange']>; artifacts?: NonNullable<import('./providers/types').ToolExecutionResult['artifacts']> } }[];
  usage?: { inputTokens: number; outputTokens: number };
  attachments?: ChatAttachmentMeta[];
  timestamp: number;
}

interface IncomingAttachment {
  name?: string;
  mime?: string;
  kind?: string;
  dataUrl?: string;
  text?: string;
}

interface Session {
  id: string;
  title: string;
  /** default=新会话, message=首条消息截断, ai=模型命名, manual=用户手动 */
  titleSource?: 'default' | 'message' | 'ai' | 'manual';
  /** iOS-style category from title gen: code, writing, chat, ... */
  category?: string;
  /** Auto title attempts (max 3, mirrors iOS titleGenAttempts) */
  titleGenAttempts?: number;
  created: number;
  updated: number;
  messageCount: number;
}

interface SessionStore {
  sessions: Session[];
  activeSessionId: string;
}

// ---- Session I/O ----
function loadSessionStore(): SessionStore {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { sessions: [], activeSessionId: '' };
}

function saveSessionStore(s: SessionStore): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

function loadMessages(sessionId: string): ChatMessage[] {
  try {
    const fp = path.join(SESSIONS_DIR, sessionId + '.json');
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveMessages(sessionId: string, msgs: ChatMessage[]): void {
  const fp = path.join(SESSIONS_DIR, sessionId + '.json');
  fs.writeFileSync(fp, JSON.stringify(msgs, null, 2), 'utf-8');
}

interface DurableSessionContext {
  version: 2;
  sessionId: string;
  updatedAt: number;
  content: string;
  /** Codex-style rolling summary of the compacted past (survives restarts). */
  summary?: string;
}

function sessionContextPath(sessionId: string): string {
  return path.join(SESSION_CONTEXT_DIR, sessionId + '.json');
}

function loadSessionContext(sessionId: string): string {
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

function saveSessionContext(sessionId: string, messages: ChatMessage[], summary = ''): void {
  // Build a small durable index from the complete history. The chat transcript
  // remains the source of truth; this index carries high-value anchors through
  // restart, model changes and transcript trimming without replaying huge tool
  // outputs into every request.
  const urls = new Set<string>();
  const paths = new Set<string>();
  const userNotes: string[] = [];
  const toolNotes: string[] = [];
  const configAnchors: string[] = [];
  const addAnchors = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    for (const match of text.match(/https?:\/\/[^\s<>\])}\\"']+/gi) || []) urls.add(match.replace(/[.,;]+$/, ''));
    for (const match of text.match(/(?:[A-Za-z]:[\\/][^\s<>\])}\\"']+|(?:workspace|uploads|attachments)[\\/][^\s<>\])}\\"']+)/g) || []) {
      const normalized = match.replace(/[.,;]+$/, '');
      // A URL such as https://... can otherwise be misread as the trailing
      // `s://...` Windows-drive alternative above.
      if (!/^[a-z]:\/\//i.test(normalized)) paths.add(normalized);
    }
  };
  // Extract config-style facts (key=value pairs) that must survive trimming:
  // API keys, base URLs, model names, output dirs, file paths.
  const extractConfigAnchors = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    // e.g. API_KEY_EDU = "sk-...", OUTPUT_DIR = "C:\...", --model gpt-image-2-edu
    const kv = text.match(/(?:API_KEY|BASE_URL|OUTPUT_DIR|BASEURL|API_BASE|MODEL|model|base_url|output_dir|api_key|baseurl)\s*[=:]\s*["']?([A-Za-z0-9_\-.:\\\/]+)["']?/gi) || [];
    const modelArgs = text.match(/--model\s+([A-Za-z0-9_.\-]+)/gi) || [];
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
    }
    for (const attachment of message.attachments || []) {
      addAnchors(attachment.savedPath);
      if (attachment.savedPath) paths.add(attachment.savedPath);
    }
    for (const call of message.toolCalls || []) {
      addAnchors(call.args);
      addAnchors(call.result?.output);
      extractConfigAnchors(call.args);
      extractConfigAnchors(call.result?.output);
      const args = JSON.stringify(call.args || {});
      const output = String(call.result?.output || '').trim().substring(0, 1200);
      toolNotes.push(`${call.name}: ${args.substring(0, 900)}${output ? `\n结果: ${output}` : ''}`);
    }
  }
  // Deduplicate config anchors while keeping last occurrence order.
  const uniqueConfig = [...new Set(configAnchors)];
  const sections = [
    '持久化会话上下文（来自本会话已保存的消息、工具调用和工具结果；其中的链接、路径、标识符应视为已知事实）：',
    uniqueConfig.length ? `关键配置/参数（最近 ${Math.min(40, uniqueConfig.length)} 条）:\n${uniqueConfig.slice(-40).map((v) => `- ${v}`).join('\n')}` : '',
    urls.size ? `已出现的链接:\n${[...urls].slice(-100).map((v) => `- ${v}`).join('\n')}` : '',
    paths.size ? `已出现的文件/路径:\n${[...paths].slice(-100).map((v) => `- ${v}`).join('\n')}` : '',
    userNotes.length ? `用户的重要原话（最近 ${Math.min(50, userNotes.length)} 条）:\n${userNotes.slice(-50).map((v) => `- ${v}`).join('\n')}` : '',
    toolNotes.length ? `工具调用及结果摘要（最近 ${Math.min(40, toolNotes.length)} 条）:\n${toolNotes.slice(-40).join('\n\n')}` : '',
  ].filter(Boolean);
  const content = sections.join('\n\n').substring(0, 60000);
  const state: DurableSessionContext = { version: 2, sessionId, updatedAt: Date.now(), content, summary: summary || undefined };
  try { fs.writeFileSync(sessionContextPath(sessionId), JSON.stringify(state, null, 2), 'utf-8'); } catch { /* best effort */ }
}

interface TokenUsageRecord {
  key: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  requests: number;
  updatedAt: number;
}

function loadTokenUsage(): TokenUsageRecord[] {
  try {
    if (fs.existsSync(TOKEN_USAGE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf-8'));
      return Array.isArray(raw) ? raw : [];
    }
  } catch { /* ignore corrupt statistics */ }
  return [];
}

function recordTokenUsage(profile: ModelProfile, usage: LLMUsage): void {
  const key = `${profile.provider}:${profile.model}`;
  const records = loadTokenUsage();
  let record = records.find((item) => item.key === key);
  if (!record) {
    record = { key, provider: profile.provider, model: profile.model, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, requests: 0, updatedAt: Date.now() };
    records.push(record);
  }
  record.inputTokens += Math.max(0, Number(usage.inputTokens) || 0);
  record.outputTokens += Math.max(0, Number(usage.outputTokens) || 0);
  record.cacheCreationInputTokens += Math.max(0, Number(usage.cacheCreationInputTokens) || 0);
  record.cacheReadInputTokens += Math.max(0, Number(usage.cacheReadInputTokens) || 0);
  record.requests += 1;
  record.updatedAt = Date.now();
  fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

// ---- Agent (per session) ----
const agentCache = new Map<string, AgentLoop>();
const artifactRegistry = new Map<string, { path: string; mimeType: string; size: number; created: number }>();

function getOrCreateAgent(sessionId: string): AgentLoop | null {
  let agent = agentCache.get(sessionId);
  if (agent) return agent;

  const profile = activeProfile();
  if (!profile || !profile.apiKey) return null;

  const provider = ProviderFactory.create({
    type: profile.provider as ProviderType,
    name: profile.provider,
    model: profile.model,
    apiKey: profile.apiKey,
    baseURL: profile.baseURL || undefined,
    thinkingLevel: getThinkingLevel(),
  });

  // Tools run in the opened project (OpenCode-style); fall back to app workspace
  const projectRoot = getProjectRoot();
  const toolCwd = projectRoot || WORKSPACE_DIR;
  skillStore.reload();
  const skillsDir = skillStore.getSkillsDir();
  const config: AgentLoopConfig = {
    provider,
    workspaceDir: toolCwd,
    memoryDir: MEMORY_DIR,
    memoryEnabled: true,
    maxTokens: 64000,
    hasProject: !!projectRoot,
    projectName: projectRoot ? path.basename(projectRoot) : null,
    skillFragment: skillStore.skillPromptFragment(),
    systemSkillFragment: skillStore.systemPromptFragment(),
    skillsDir,
    onSkillRead: (resolvedPath: string) => {
      const sid = skillStore.skillIdFromPath(resolvedPath);
      if (sid) skillStore.recordUse(sid);
    },
    onSkillWrite: (resolvedPath: string) => {
      // iOS: agent-created SKILL.md under skills/ → rescan registry
      const norm = path.resolve(resolvedPath).replace(/\\/g, '/').toLowerCase();
      const root = path.resolve(skillsDir).replace(/\\/g, '/').toLowerCase();
      if (norm.startsWith(root) && norm.endsWith('skill.md')) {
        skillStore.reload();
        console.log('[Skills] reloaded after agent write:', resolvedPath);
      }
    },
  };
  agent = new AgentLoop(config);
  agentCache.set(sessionId, agent);
  return agent;
}

function cancelSessionAgent(sessionId: string, dispose = true): void {
  const agent = agentCache.get(sessionId);
  if (agent) {
    agent.cancel();
    if (dispose) agentCache.delete(sessionId);
  }
}

// Helper: persist chat messages after a turn
function saveSessionMessages(
  sessionId: string,
  existingMessages: ChatMessage[],
  userMsg: ChatMessage,
  assistantText: string,
  toolCalls: { id: string; name: string; args: Record<string, unknown>; result?: { output: string; success: boolean; fileChange?: NonNullable<import('./providers/types').ToolExecutionResult['fileChange']>; artifacts?: NonNullable<import('./providers/types').ToolExecutionResult['artifacts']> } }[],
  usage: { inputTokens: number; outputTokens: number } | undefined,
): void {
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: assistantText,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage,
    timestamp: Date.now(),
  };
  const updatedMessages = [...existingMessages, userMsg, assistantMsg];

  // Limit to last 200 messages per session (prevent bloat)
  const trimmed = updatedMessages.length > 200
    ? updatedMessages.slice(updatedMessages.length - 200)
    : updatedMessages;

  saveMessages(sessionId, trimmed);

  // Grab the Codex-style compaction summary from the agent (if any)
  const agent = agentCache.get(sessionId);
  const summary = agent ? agent.getCompactorSummary() : '';
  saveSessionContext(sessionId, updatedMessages, summary);

  // Update session metadata
  const store = loadSessionStore();
  const sess = store.sessions.find(s => s.id === sessionId);
  if (sess) {
    sess.messageCount = trimmed.length;
    sess.updated = Date.now();
    saveSessionStore(store);
  }
}

function backfillSessionContexts(): void {
  try {
    const store = loadSessionStore();
    for (const session of store.sessions || []) {
      const messages = loadMessages(session.id);
      if (messages.length > 0) {
        saveSessionContext(session.id, messages);
      }
    }
  } catch { /* best effort during startup */ }
}

// ---- Agent (per session) ----
// Agents are now cached per session via getOrCreateAgent()/cancelSessionAgent()
// See agentCache Map above.

// ---- MIME ----
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let fp = req.url === '/' ? '/index.html' : req.url || '/index.html';
  fp = path.join(RENDERER_DIR, fp);
  const ext = path.extname(fp);
  try {
    const content = fs.readFileSync(fp);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch { res.writeHead(404); res.end('未找到'); }
}

function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  // Write + flush so tool steps appear live in the UI (not only after the turn ends).
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const anyRes = res as http.ServerResponse & { flush?: () => void };
  if (typeof anyRes.flush === 'function') {
    try { anyRes.flush(); } catch { /* ignore */ }
  }
}

function jsonReply(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base || 'file';
}

/** Resolve a path relative to the active project; block path traversal. */
function resolveProjectPath(rel: string): string | null {
  const projectRoot = getProjectRoot();
  if (!projectRoot) return null;
  const raw = (rel || '.').replace(/\\/g, '/').trim() || '.';
  if (raw.includes('\0')) return null;
  const abs = path.resolve(projectRoot, raw === '.' ? '' : raw);
  const root = path.resolve(projectRoot);
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
  return abs;
}

/**
 * iOS-style auto title: JSON {title, category}, language injection, summary,
 * up to 3 attempts, fallback from first user message.
 */
async function generateSessionTitleIfNeeded(opts: {
  sessionId: string;
  userMessage: string;
  assistantText: string;
  toolEntries: Array<{ name: string; args: Record<string, unknown> }>;
  sendTitle?: (title: string, category?: string) => void;
}): Promise<void> {
  const st = loadSessionStore();
  const s = st.sessions.find((x) => x.id === opts.sessionId);
  if (!s) return;
  if (s.titleSource === 'manual' || s.titleSource === 'ai') return;

  const attempts = s.titleGenAttempts || 0;
  if (attempts >= MAX_TITLE_ATTEMPTS) return;

  const responseText = (opts.assistantText || '').trim();
  if (!responseText && (!opts.toolEntries || opts.toolEntries.length === 0)) return;

  s.titleGenAttempts = attempts + 1;
  saveSessionStore(st);

  const profile = activeProfile();
  if (!profile || !profile.apiKey) {
    applyFallbackTitle(opts.sessionId, opts.userMessage, opts.sendTitle);
    return;
  }

  const summary = buildConversationSummary({
    firstUser: opts.userMessage,
    firstAssistant: responseText,
    toolEntries: opts.toolEntries,
  });

  console.log(`[TitleGen] attempt ${s.titleGenAttempts}/${MAX_TITLE_ATTEMPTS} session=${opts.sessionId}`);
  const result = await callModelForTitle(
    {
      provider: profile.provider,
      model: profile.model,
      apiKey: profile.apiKey,
      baseURL: profile.baseURL || undefined,
    },
    summary,
  );

  const st2 = loadSessionStore();
  const s2 = st2.sessions.find((x) => x.id === opts.sessionId);
  if (!s2 || s2.titleSource === 'manual') return;

  if (result && result.title && result.title !== '新会话') {
    s2.title = result.title;
    s2.titleSource = 'ai';
    if (result.category) s2.category = result.category;
    s2.titleGenAttempts = MAX_TITLE_ATTEMPTS;
    s2.updated = Date.now();
    saveSessionStore(st2);
    console.log(`[TitleGen] saved: "${result.title}" category=${result.category || 'nil'}`);
    try { opts.sendTitle?.(result.title, result.category); } catch { /* */ }
    return;
  }

  // Failed parse / empty — fallback like iOS
  applyFallbackTitle(opts.sessionId, opts.userMessage, opts.sendTitle);
}

function applyFallbackTitle(
  sessionId: string,
  firstUserRaw: string,
  sendTitle?: (title: string, category?: string) => void,
): void {
  const st = loadSessionStore();
  const s = st.sessions.find((x) => x.id === sessionId);
  if (!s || s.titleSource === 'manual' || s.titleSource === 'ai') return;

  const fallback = fallbackTitleFromFirstUserMessage(firstUserRaw);
  if (!fallback) return;

  s.title = fallback;
  s.titleSource = 'message';
  s.titleGenAttempts = MAX_TITLE_ATTEMPTS;
  s.updated = Date.now();
  saveSessionStore(st);
  console.log(`[TitleGen] fallback title: "${fallback}"`);
  try { sendTitle?.(fallback); } catch { /* */ }
}

function getSystemInfo(): {
  platform: string;
  release: string;
  arch: string;
  label: string;
} {
  const platform = process.platform;
  const release = os.release();
  const arch = os.arch();
  let label = `${platform} ${release}`;

  if (platform === 'win32') {
    // Map NT kernel version → friendly Windows name
    // 10.0.22000+ ≈ Windows 11, 10.0.* ≈ Windows 10, 6.3 ≈ 8.1, 6.2 ≈ 8, 6.1 ≈ 7
    const parts = release.split('.').map((n) => parseInt(n, 10) || 0);
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    const build = parts[2] || 0;
    let winName = 'Windows';
    if (major === 10 && build >= 22000) winName = 'Windows 11';
    else if (major === 10) winName = 'Windows 10';
    else if (major === 6 && minor === 3) winName = 'Windows 8.1';
    else if (major === 6 && minor === 2) winName = 'Windows 8';
    else if (major === 6 && minor === 1) winName = 'Windows 7';
    else if (major === 6 && minor === 0) winName = 'Windows Vista';
    else if (major === 5) winName = 'Windows XP';
    const archLabel = arch === 'x64' ? 'x64' : arch === 'ia32' ? 'x86' : arch;
    label = `${winName} ${archLabel}`;
  } else if (platform === 'darwin') {
    label = `macOS ${release}`;
  } else {
    label = `${os.type()} ${release}`;
  }

  return { platform, release, arch, label };
}

// ---- Create Server ----
function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // =====================================================================
    // System info
    // =====================================================================
    if (url.pathname === '/api/system' && req.method === 'GET') {
      jsonReply(res, 200, getSystemInfo());
      return;
    }

    // =====================================================================
    // WebDAV Sync API
    // =====================================================================
    if (url.pathname === '/api/webdav/config') {
      if (req.method === 'GET') {
        const cfg = loadConfig();
        // Mask password
        const masked = { ...cfg, password: maskKey(cfg.password) };
        jsonReply(res, 200, masked);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const input: WebDAVConfig = JSON.parse(body);
          const existing = loadConfig();
          // Only update password if a new one is provided (not masked)
          if (input.password && input.password !== maskKey(existing.password)) {
            existing.password = input.password;
          }
          existing.url = input.url || existing.url;
          existing.username = input.username || existing.username;
          existing.enabled = input.enabled !== undefined ? input.enabled : existing.enabled;
          existing.autoSync = input.autoSync !== undefined ? input.autoSync : existing.autoSync;
          saveConfig(existing);
          jsonReply(res, 200, { ok: true });
        } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
        return;
      }
    }

    if (url.pathname === '/api/webdav/test' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { url, username, password } = JSON.parse(body);
        const result = await testConnection({ url, username, password, enabled: true, autoSync: false, lastSync: 0 });
        jsonReply(res, result.ok ? 200 : 400, result);
      } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
      return;
    }

    if (url.pathname === '/api/webdav/sync' && req.method === 'POST') {
      const cfg = loadConfig();
      if (!cfg.url) { jsonReply(res, 400, { error: 'WebDAV 未配置' }); return; }

      const result = await syncAll(cfg, WORKSPACE_DIR, SESSIONS_DIR, SETTINGS_FILE, SESSIONS_FILE);
      jsonReply(res, result.ok ? 200 : 500, result);
      return;
    }

    if (url.pathname === '/api/webdav/status' && req.method === 'GET') {
      const cfg = loadConfig();
      jsonReply(res, 200, {
        configured: !!cfg.url,
        enabled: cfg.enabled,
        autoSync: cfg.autoSync,
        lastSync: cfg.lastSync,
      });
      return;
    }

    // =====================================================================
    // Search API — fuzzy search across session titles + messages
    // =====================================================================
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) { jsonReply(res, 200, { results: [] }); return; }

      const store = loadSessionStore();
      const results: { session: Session; matches: { role: string; snippet: string }[] }[] = [];

      for (const sess of store.sessions) {
        const msgs = loadMessages(sess.id);
        const matches: { role: string; snippet: string }[] = [];

        // Search message content
        for (const msg of msgs) {
          const content = msg.content.toLowerCase();
          if (content.includes(q)) {
            const idx = content.indexOf(q);
            const start = Math.max(0, idx - 40);
            const end = Math.min(content.length, idx + q.length + 40);
            let snippet = msg.content.substring(start, end);
            if (start > 0) snippet = '...' + snippet;
            if (end < msg.content.length) snippet += '...';
            matches.push({ role: msg.role, snippet });
            if (matches.length >= 5) break;
          }
        }

        // Also match session title
        const titleLower = sess.title.toLowerCase();
        if (titleLower.includes(q) && matches.length === 0) {
          matches.push({ role: 'title', snippet: '📝 ' + sess.title });
        }

        if (matches.length > 0) {
          results.push({ session: sess, matches });
        }
      }

      jsonReply(res, 200, { results, query: q });
      return;
    }

    // =====================================================================
    // Sessions API (CRUD)
    // =====================================================================
    if (url.pathname === '/api/sessions') {
      if (req.method === 'GET') {
        const store = loadSessionStore();
        // Sort newest first
        store.sessions.sort((a, b) => b.updated - a.updated);
        jsonReply(res, 200, { sessions: store.sessions, activeSessionId: store.activeSessionId });
        return;
      }

      if (req.method === 'POST') {
        const store = loadSessionStore();
        const session: Session = {
          id: 'sess_' + Date.now(),
          title: '新会话',
          titleSource: 'default',
          titleGenAttempts: 0,
          created: Date.now(),
          updated: Date.now(),
          messageCount: 0,
        };
        store.sessions.push(session);
        store.activeSessionId = session.id;
        saveSessionStore(store);
        saveMessages(session.id, []);
        jsonReply(res, 200, { session });
        return;
      }
    }

    // GET /api/sessions/:id — load messages
    // PUT /api/sessions/:id — rename
    // DELETE /api/sessions/:id — delete
    if (url.pathname.startsWith('/api/sessions/')) {
      const sid = url.pathname.split('/').pop() || '';

      if (req.method === 'GET') {
        const msgs = loadMessages(sid);
        jsonReply(res, 200, { messages: msgs });
        return;
      }

      // Revert a conversation branch to a selected user message (OpenCode-style).
      // The selected message remains; everything after it is discarded.
      if (req.method === 'POST' && url.pathname.endsWith('/reset')) {
        const sessionId = url.pathname.split('/').slice(-2, -1)[0] || '';
        try {
          const body = JSON.parse(await readBody(req));
          const messageIndex = Number(body.messageIndex);
          const messages = loadMessages(sessionId);
          if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) {
            jsonReply(res, 400, { error: '无效的消息位置' });
            return;
          }
          if (messages[messageIndex].role !== 'user') {
            jsonReply(res, 400, { error: '只能重置到用户消息' });
            return;
          }
          const retained = messages.slice(0, messageIndex + 1);
          cancelSessionAgent(sessionId);
          saveMessages(sessionId, retained);
          saveSessionContext(sessionId, retained);
          const store = loadSessionStore();
          const session = store.sessions.find((s) => s.id === sessionId);
          if (session) {
            session.messageCount = retained.length;
            session.updated = Date.now();
            saveSessionStore(store);
          }
          jsonReply(res, 200, { ok: true, messages: retained.length });
        } catch {
          jsonReply(res, 400, { error: '无效的重置请求' });
        }
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        try {
          const { title } = JSON.parse(body);
          const store = loadSessionStore();
          const s = store.sessions.find(s => s.id === sid);
          if (s) {
            s.title = title || s.title;
            s.titleSource = 'manual';
            s.updated = Date.now();
            saveSessionStore(store);
            jsonReply(res, 200, { ok: true });
          } else {
            jsonReply(res, 404, { error: '会话未找到' });
          }
        } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
        return;
      }

      if (req.method === 'DELETE') {
        cancelSessionAgent(sid);
        const store = loadSessionStore();
        store.sessions = store.sessions.filter(s => s.id !== sid);
        if (store.activeSessionId === sid) {
          store.activeSessionId = store.sessions[0]?.id || '';
        }
        saveSessionStore(store);
        // Delete message file
        const fp = path.join(SESSIONS_DIR, sid + '.json');
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
        try {
          const contextFp = sessionContextPath(sid);
          if (fs.existsSync(contextFp)) fs.unlinkSync(contextFp);
        } catch { /* ignore */ }
        jsonReply(res, 200, { ok: true, activeSessionId: store.activeSessionId });
        return;
      }
    }

    // =====================================================================
    // Per-model token usage (iOS-style cumulative actual usage)
    // =====================================================================
    if (url.pathname === '/api/token-usage' && req.method === 'GET') {
      jsonReply(res, 200, { records: loadTokenUsage() });
      return;
    }

    // =====================================================================
    // Chat API
    // =====================================================================
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        const message: string = parsed.message || '';
        const sessionId: string = parsed.sessionId || '';
        const rawAttachments: IncomingAttachment[] = Array.isArray(parsed.attachments) ? parsed.attachments : [];
        if (!message && rawAttachments.length === 0) throw new Error('message required');
        if (!sessionId) throw new Error('sessionId required');

        const profile = activeProfile();
        if (!profile || !profile.apiKey) {
          jsonReply(res, 400, { error: '请先在设置中配置至少一个 AI 模型。' });
          return;
        }

        // Soft-cancel any in-flight turn but keep agent so multi-turn memory stays warm.
        // If none exists (app restart / first message), create and hydrate from disk.
        cancelSessionAgent(sessionId, false);
        let agent = agentCache.get(sessionId) || null;
        const needHydrate = !agent || agent.getHistoryLength() === 0;
        if (!agent) {
          agent = getOrCreateAgent(sessionId);
        }
        if (!agent) {
          jsonReply(res, 400, { error: '创建 Agent 失败。' });
          return;
        }
        await agent.initialize();
        // Reapply the durable session index on every turn. The AgentLoop may
        // survive a normal turn, or may have just been recreated after a
        // restart/profile change; either way the model receives the same
        // session-level anchors as a Codex-style task context.
        const persistedMessages = loadMessages(sessionId);
        let durableContext = loadSessionContext(sessionId);
        if (!durableContext && persistedMessages.length > 0) {
          saveSessionContext(sessionId, persistedMessages);
          durableContext = loadSessionContext(sessionId);
        }
        agent.setSessionContext(durableContext);
        // Restore Codex-style compaction summary (survives restarts)
        const persistedSummary = loadSessionSummary(sessionId);
        if (persistedSummary) {
          agent.setCompactorSummary(persistedSummary);
        }
        if (needHydrate) {
          // Prior turns from disk → model remembers after reopen / process restart
          agent.seedHistoryFromChat(persistedMessages);
        }
        const tools = makeAgentTools(true);
        // Initial estimate makes the context ring useful before the provider
        // returns its first token-usage receipt.
        const seedHistory = loadMessages(sessionId);
        const contextWindow = contextWindowForModel(profile.model, profile.provider);
        const estimatedTokens = estimateMessageTokens(seedHistory.map((m) => ({
          role: m.role,
          parts: [{ type: 'text' as const, text: m.content || '' }],
        })));
        const compactThreshold = compactThresholdForWindow(contextWindow);

        // Process attachments: save to workspace, prepare for agent
        const attachDir = path.join(WORKSPACE_DIR, 'uploads', sessionId);
        if (rawAttachments.length > 0) {
          fs.mkdirSync(attachDir, { recursive: true });
        }

        const agentAttachments: Array<{
          name: string;
          mime: string;
          kind: 'image' | 'text' | 'file';
          data?: Buffer;
          text?: string;
          savedPath?: string;
        }> = [];
        const metaAttachments: ChatAttachmentMeta[] = [];

        for (const raw of rawAttachments.slice(0, 8)) {
          const safeName = sanitizeFileName(raw.name || 'file');
          const kind = (raw.kind === 'image' || raw.kind === 'text' || raw.kind === 'file')
            ? raw.kind
            : (raw.mime || '').startsWith('image/') ? 'image'
              : raw.text != null ? 'text' : 'file';
          const mime = raw.mime || (kind === 'image' ? 'image/png' : kind === 'text' ? 'text/plain' : 'application/octet-stream');

          let data: Buffer | undefined;
          let text = raw.text;
          let previewUrl: string | undefined;

          if (raw.dataUrl && typeof raw.dataUrl === 'string') {
            const m = raw.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
            if (m) {
              data = Buffer.from(m[2], 'base64');
              if (kind === 'image' && raw.dataUrl.length < 200000) {
                previewUrl = raw.dataUrl;
              }
            }
          }

          // Persist to workspace so agent tools can open the path
          let savedPath: string | undefined;
          try {
            const stamp = Date.now().toString(36);
            const destName = `${stamp}_${safeName}`;
            const dest = path.join(attachDir, destName);
            if (kind === 'text' && text != null) {
              fs.writeFileSync(dest, text, 'utf-8');
            } else if (data) {
              fs.writeFileSync(dest, data);
            }
            if (fs.existsSync(dest)) {
              savedPath = path.join('uploads', sessionId, destName).replace(/\\/g, '/');
              if (kind === 'image') previewUrl = `/api/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(destName)}`;
            }
          } catch { /* ignore save errors */ }

          agentAttachments.push({ name: safeName, mime, kind, data, text, savedPath });
          metaAttachments.push({ name: safeName, mime, kind, savedPath, previewUrl });
        }

        // Save user message
        const userMsg: ChatMessage = {
          role: 'user',
          content: message,
          attachments: metaAttachments.length ? metaAttachments : undefined,
          timestamp: Date.now(),
        };
        const existingMessages = loadMessages(sessionId);

        // Provisional sidebar title from first user message (like iOS pre-AI state)
        const store = loadSessionStore();
        const sess = store.sessions.find(s => s.id === sessionId);
        const src = sess?.titleSource || 'default';
        if (sess && (src === 'default' || !sess.title || sess.title === '新会话')) {
          const fb = fallbackTitleFromFirstUserMessage(
            message || (metaAttachments[0]?.name ? `附件：${metaAttachments[0].name}` : ''),
          );
          if (fb) {
            sess.title = fb;
            sess.titleSource = 'message';
            sess.updated = Date.now();
            saveSessionStore(store);
          }
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        // Disable Nagle so tiny SSE frames (tool_start) leave the socket immediately.
        try { (res.socket as any)?.setNoDelay?.(true); } catch { /* ignore */ }
        sendSSE(res, 'context', {
          contextWindow,
          usedTokens: estimatedTokens,
          estimated: true,
          compactThreshold,
          state: compactThreshold > 0 && estimatedTokens >= compactThreshold ? 'near-limit' : 'ok',
        });

        // Accumulate assistant response for saving
        let assistantFullText = '';
        let assistantToolCalls: ChatMessage['toolCalls'] = [];
        let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
        let titleJob: Promise<void> | null = null;

        // iOS: generateSessionTitleIfNeeded after each LLM stream completes
        const maybeAiTitle = async () => {
          await generateSessionTitleIfNeeded({
            sessionId,
            userMessage: message,
            assistantText: assistantFullText,
            toolEntries: assistantToolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
            sendTitle: (title, category) => {
              if (!res.writableEnded) {
                sendSSE(res, 'session_title', { sessionId, title, category });
              }
            },
          });
        };

        const cb: AgentLoopCallbacks = {
          onTextDelta: (_t, ft) => {
            assistantFullText = ft;
            sendSSE(res, 'text', { content: ft });
          },
          // Enforce the user's setting at the final transport boundary too.
          // This covers compatible gateways that emit reasoning despite an
          // enable_thinking: false request.
          onThinkingDelta: t => {
            if (getThinkingLevel() !== 'off') sendSSE(res, 'thinking', { content: t });
          },
          onToolCallStart: (id, name) => sendSSE(res, 'tool_start', { id, name }),
          onToolInputDelta: (name, acc, id) => sendSSE(res, 'tool_input', { id, name, args: acc }),
          onToolCallComplete: (id, name, args) => {
            assistantToolCalls.push({ id, name, args });
            sendSSE(res, 'tool_complete', { id, name, args });
          },
          onToolResult: (id, r) => {
            const entry = assistantToolCalls.find((tc) => tc.id === id);
            const artifacts = (r.artifacts || []).map((artifact) => {
              const artifactId = `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
              const absolute = path.resolve(artifact.path);
              artifactRegistry.set(artifactId, { path: absolute, mimeType: artifact.mimeType, size: artifact.size, created: Date.now() });
              return { ...artifact, path: absolute, url: `/api/artifacts/${artifactId}` };
            });
            if (entry) entry.result = { output: r.output, success: r.success, fileChange: r.fileChange, artifacts };
            sendSSE(res, 'tool_result', {
              id, output: r.output, success: r.success,
              fileChange: r.fileChange,
              artifacts,
              imageData: r.imageData ? r.imageData.toString('base64') : undefined,
              imageMimeType: r.imageMimeType,
            });
          },
          onRetry: (attempt, delayMs, error) => sendSSE(res, 'retry', { attempt, delayMs, error }),
          onUsage: (u: LLMUsage) => {
            lastUsage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
            // Persist each provider usage receipt immediately; a turn can contain multiple model calls.
            recordTokenUsage(profile, u);
            sendSSE(res, 'usage', u);
          },
          onContext: (context) => sendSSE(res, 'context', context),
          onError: (e) => {
            sendSSE(res, 'error', { message: e });
            saveSessionMessages(sessionId, existingMessages, userMsg, assistantFullText, assistantToolCalls, lastUsage);
            titleJob = maybeAiTitle().finally(() => { try { res.end(); } catch { /* */ } });
          },
          onDone: (sr) => {
            saveSessionMessages(sessionId, existingMessages, userMsg, assistantFullText, assistantToolCalls, lastUsage);
            // Unlock UI first (iOS generates title async in background Task)
            sendSSE(res, 'done', { stopReason: sr });
            titleJob = maybeAiTitle().finally(() => {
              try { res.end(); } catch { /* */ }
            });
          },
          onCancelled: () => {
            sendSSE(res, 'cancelled', {});
            res.end();
            saveSessionMessages(sessionId, existingMessages, userMsg, assistantFullText, assistantToolCalls, lastUsage);
          },
        };
        await agent.run(message, tools, cb, agentAttachments);
        if (titleJob) await titleJob;
      } catch (err: unknown) {
        if (!res.headersSent) jsonReply(res, 500, { error: (err as Error).message });
      }
      return;
    }

    if (url.pathname === '/api/cancel') {
      let sessionId = url.searchParams.get('sessionId') || '';
      if (!sessionId) {
        // Legacy fallback: try reading body
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          sessionId = parsed.sessionId || '';
        } catch { /* ignore */ }
      }
      if (sessionId) {
        cancelSessionAgent(sessionId);
      }
      jsonReply(res, 200, { ok: true });
      return;
    }

    // =====================================================================
    // Fetch models from a custom OpenAI-compatible endpoint
    // =====================================================================
    if (url.pathname === '/api/profiles/fetch-models' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { baseURL, apiKey } = JSON.parse(body);
        if (!baseURL || !apiKey) {
          jsonReply(res, 400, { error: '请输入接口地址和 API 密钥。' });
          return;
        }
        let modelsUrl = baseURL.replace(/\/+$/, '');
        if (!modelsUrl.includes('/v1')) {
          modelsUrl = modelsUrl + '/v1';
        }
        modelsUrl += '/models';
        const endpoint = new URL(modelsUrl);
        const requestModule = endpoint.protocol === 'https:' ? https : http;
        requestModule.get(endpoint, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
          timeout: 20000,
        }, (r: http.IncomingMessage) => {
          let data = '';
          r.on('data', (c: Buffer) => data += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              let list: string[] = [];
              if (Array.isArray(parsed.data)) {
                list = parsed.data.map((m: any) => m.id).filter(Boolean);
              } else if (Array.isArray(parsed)) {
                list = parsed.map((m: any) => m.id).filter(Boolean);
              }
              if (list.length === 0) {
                jsonReply(res, 404, { error: '未找到可用模型。' });
                return;
              }
              jsonReply(res, 200, { models: list });
            } catch { jsonReply(res, 500, { error: '无法解析模型列表。' }); }
          });
        }).on('error', (e: Error) => jsonReply(res, 500, { error: `请求失败：${e.message}` }));
      } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
      return;
    }

    // =====================================================================
    // Profiles API (CRUD)
    // =====================================================================
    if (url.pathname === '/api/profiles') {
      if (req.method === 'GET') {
        const s = loadSettings();
        const masked = s.profiles.map(p => ({
          ...p,
          apiKey: maskKey(p.apiKey),
          maxThinkingLevel: maxThinkingLevel(p.provider, p.model),
        }));
        jsonReply(res, 200, {
          profiles: masked,
          activeProfileId: s.activeProfileId,
          thinkingLevel: normalizeThinkingLevel(s.thinkingLevel),
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const profile: ModelProfile = JSON.parse(body);
          if (!profile.id) profile.id = 'p_' + Date.now();
          if (!profile.name) profile.name = profile.model || '未命名';
          const s = loadSettings();
          const idx = s.profiles.findIndex(p => p.id === profile.id);
          if (idx >= 0) s.profiles[idx] = profile;
          else s.profiles.push(profile);
          if (!s.activeProfileId) s.activeProfileId = profile.id;
          saveSettings(s);
          jsonReply(res, 200, { ok: true, profile: { ...profile, apiKey: maskKey(profile.apiKey) } });
        } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        try {
          const { activeProfileId } = JSON.parse(body);
          const s = loadSettings();
          if (s.profiles.find(p => p.id === activeProfileId)) {
            s.activeProfileId = activeProfileId;
            saveSettings(s);
            for (const id of [...agentCache.keys()]) cancelSessionAgent(id);
            jsonReply(res, 200, { ok: true });
          } else {
            jsonReply(res, 404, { error: '配置未找到' });
          }
        } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
        return;
      }
    }

    // DELETE /api/profiles/:id
    if (url.pathname.startsWith('/api/profiles/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop() || '';
      const s = loadSettings();
      s.profiles = s.profiles.filter(p => p.id !== id);
      if (s.activeProfileId === id) s.activeProfileId = s.profiles[0]?.id || '';
      saveSettings(s);
      jsonReply(res, 200, { ok: true });
      return;
    }

    // =====================================================================
    // Thinking level (global, iOS-style)
    // =====================================================================
    if (url.pathname === '/api/thinking-level') {
      if (req.method === 'GET') {
        jsonReply(res, 200, { thinkingLevel: getThinkingLevel() });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        try {
          const parsed = JSON.parse(body);
          const level = normalizeThinkingLevel(parsed.thinkingLevel ?? parsed.level);
          const s = loadSettings();
          s.thinkingLevel = level;
          saveSettings(s);
          // Rebuild agents so next turn picks up new reasoning effort
          for (const id of [...agentCache.keys()]) cancelSessionAgent(id);
          jsonReply(res, 200, { ok: true, thinkingLevel: level });
        } catch {
          jsonReply(res, 400, { error: '无效的 JSON' });
        }
        return;
      }
    }

    // =====================================================================
    // Active profile info
    // =====================================================================
    if (url.pathname === '/api/active-profile' && req.method === 'GET') {
      const p = activeProfile();
      if (p) {
        jsonReply(res, 200, { id: p.id, name: p.name, provider: p.provider, model: p.model });
      } else {
        jsonReply(res, 200, { id: '', name: '无模型', provider: '', model: '' });
      }
      return;
    }

    // =====================================================================
    // Legacy compat + reset
    // =====================================================================
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') {
        const p = activeProfile();
        jsonReply(res, 200, {
          provider: p?.provider || '',
          model: p?.model || '',
          apiKey: maskKey(p?.apiKey || ''),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const d = JSON.parse(body);
          if (d.provider && d.apiKey) {
            const profile: ModelProfile = {
              id: 'default', name: d.model || '默认',
              provider: d.provider, model: d.model || '', apiKey: d.apiKey,
              baseURL: d.baseURL || '',
            };
            saveSettings({ profiles: [profile], activeProfileId: 'default' });
          }
          jsonReply(res, 200, { ok: true });
        } catch { jsonReply(res, 400, { error: '无效的 JSON' }); }
        return;
      }
    }

    if (url.pathname === '/api/reset') {
      let sessionId = url.searchParams.get('sessionId') || '';
      if (sessionId) {
        cancelSessionAgent(sessionId);
      }
      jsonReply(res, 200, { ok: true });
      return;
    }

    // =====================================================================
    // Project (OpenCode-style: open a folder, then browse it)
    // =====================================================================
    // =====================================================================
    // Skills API (iOS-style SKILL.md)
    // =====================================================================
    if (url.pathname === '/api/skills' && req.method === 'GET') {
      skillStore.reload(); // always rescan disk so Explorer edits show up
      jsonReply(res, 200, {
        skillsDir: skillStore.getSkillsDir(),
        skills: skillStore.list().map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          version: s.version,
          source: s.source,
          enabled: s.enabled,
          useCount: s.useCount,
          systemPrompt: s.systemPrompt,
          skillPath: s.skillPath,
          updatedAt: s.updatedAt,
        })),
      });
      return;
    }

    if (url.pathname === '/api/skills/open-dir' && req.method === 'POST') {
      const dir = skillStore.getSkillsDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch { /* */ }
      jsonReply(res, 200, { path: dir });
      return;
    }

    if (url.pathname === '/api/skills' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { content, source } = JSON.parse(body || '{}');
        if (!content || typeof content !== 'string') {
          jsonReply(res, 400, { error: '需要 content（SKILL.md 文本）' });
          return;
        }
        const skill = skillStore.importFromContent(
          content,
          source === 'file' || source === 'url' || source === 'session' ? source : 'paste',
        );
        for (const sessionId of [...agentCache.keys()]) cancelSessionAgent(sessionId);
        jsonReply(res, 200, { skill });
      } catch (err) {
        jsonReply(res, 400, { error: (err as Error).message || '导入失败' });
      }
      return;
    }

    if (url.pathname.startsWith('/api/skills/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/skills/', '').split('/')[0] || '');
      if (!id) {
        jsonReply(res, 400, { error: '缺少 skill id' });
        return;
      }

      if (req.method === 'GET') {
        const skill = skillStore.get(id);
        if (!skill) { jsonReply(res, 404, { error: '未找到' }); return; }
        let raw = '';
        try { raw = fs.readFileSync(skill.skillPath, 'utf-8'); } catch { /* */ }
        jsonReply(res, 200, { skill, content: raw });
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        try {
          const data = JSON.parse(body || '{}');
          if (typeof data.enabled === 'boolean') {
            skillStore.setEnabled(id, data.enabled);
          }
          if (typeof data.content === 'string' && data.content.trim()) {
            // Rewrite SKILL.md
            const skill = skillStore.get(id);
            if (skill) {
              fs.writeFileSync(skill.skillPath, data.content, 'utf-8');
              skillStore.reload();
            }
          }
          // Rebuild agents so updated system-level skill content is used on the
          // next request instead of remaining captured in an old prompt.
          for (const sessionId of [...agentCache.keys()]) cancelSessionAgent(sessionId);
          const updated = skillStore.get(id);
          jsonReply(res, 200, { skill: updated });
        } catch (err) {
          jsonReply(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === 'DELETE') {
        const ok = skillStore.delete(id);
        if (ok) {
          for (const sessionId of [...agentCache.keys()]) cancelSessionAgent(sessionId);
        }
        jsonReply(res, ok ? 200 : 404, ok ? { ok: true } : { error: '未找到' });
        return;
      }
    }

    if (url.pathname === '/api/project' && req.method === 'GET') {
      jsonReply(res, 200, projectInfo());
      return;
    }

    if (url.pathname === '/api/project' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { root } = JSON.parse(body || '{}');
        const result = setProjectRoot(typeof root === 'string' ? root : null);
        if (!result.ok) {
          jsonReply(res, 400, { error: result.error || '设置失败' });
          return;
        }
        jsonReply(res, 200, result.project);
      } catch {
        jsonReply(res, 400, { error: '无效的 JSON' });
      }
      return;
    }

    if (url.pathname === '/api/project/clear' && req.method === 'POST') {
      const result = setProjectRoot(null);
      jsonReply(res, 200, result.project);
      return;
    }

    // =====================================================================
    // Project file browser (only when a project is open)
    // =====================================================================
    if (url.pathname.startsWith('/api/artifacts/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/artifacts/'.length));
      const artifact = artifactRegistry.get(id);
      if (!artifact || !fs.existsSync(artifact.path) || Date.now() - artifact.created > 30 * 60 * 1000) {
        artifactRegistry.delete(id);
        res.writeHead(404); res.end('artifact not found'); return;
      }
      const stat = fs.statSync(artifact.path);
      const range = req.headers.range;
      const commonHeaders = {
        'Content-Type': artifact.mimeType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      };
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < stat.size) {
            res.writeHead(206, {
              ...commonHeaders,
              'Content-Length': end - start + 1,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            });
            fs.createReadStream(artifact.path, { start, end }).pipe(res);
            return;
          }
        }
      }
      res.writeHead(200, { ...commonHeaders, 'Content-Length': stat.size });
      fs.createReadStream(artifact.path).pipe(res);
      return;
    }

    if (url.pathname === '/api/fs/raw' && req.method === 'GET') {
      try {
        const projectRoot = getProjectRoot();
        const rel = (url.searchParams.get('path') || '').replace(/\\/g, '/');
        const base = projectRoot || WORKSPACE_DIR;
        const candidate = path.resolve(base, rel || '.');
        const within = path.relative(path.resolve(base), candidate);
        const target = within.startsWith('..') || path.isAbsolute(within) ? null : candidate;
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.writeHead(404); res.end('文件不存在'); return;
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Content-Disposition': 'inline; filename="' + sanitizeFileName(path.basename(target)) + '"',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(target).pipe(res);
      } catch { res.writeHead(400); res.end('无法读取文件'); }
      return;
    }

    if (url.pathname.startsWith('/api/attachments/') && req.method === 'GET') {
      const parts = url.pathname.split('/').filter(Boolean);
      const sid = parts[2] || '';
      const name = sanitizeFileName(decodeURIComponent(parts.slice(3).join('/')));
      const target = path.resolve(WORKSPACE_DIR, 'uploads', sid, name);
      const uploadRoot = path.resolve(WORKSPACE_DIR, 'uploads', sid);
      const rel = path.relative(uploadRoot, target);
      if (!sid || !name || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target)) {
        res.writeHead(404); res.end('附件不存在'); return;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Disposition': 'inline; filename="' + name + '"',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    if (url.pathname === '/api/fs/list' && req.method === 'GET') {
      try {
        const projectRoot = getProjectRoot();
        if (!projectRoot) {
          jsonReply(res, 200, { root: null, path: '.', entries: [], empty: true });
          return;
        }
        const rel = (url.searchParams.get('path') || '.').replace(/\\/g, '/');
        const target = resolveProjectPath(rel);
        if (!target) {
          jsonReply(res, 400, { error: '路径无效' });
          return;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          jsonReply(res, 404, { error: '目录不存在' });
          return;
        }
        const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter((d) => {
            if (d.name === '.' || d.name === '..') return false;
            if (d.name.startsWith('.') && d.name !== '.env' && d.name !== '.gitignore') return false;
            if (SKIP.has(d.name)) return false;
            return true;
          })
          .map((d) => {
            const full = path.join(target, d.name);
            let size = 0;
            let mtime = 0;
            try {
              const st = fs.statSync(full);
              size = st.size;
              mtime = st.mtimeMs;
            } catch { /* */ }
            const isDir = d.isDirectory();
            const relPath = path.relative(projectRoot, full).replace(/\\/g, '/') || '.';
            return {
              name: d.name,
              type: isDir ? 'dir' : 'file',
              size,
              mtime,
              path: relPath,
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-CN');
          });

        const relNorm = path.relative(projectRoot, target).replace(/\\/g, '/') || '.';
        jsonReply(res, 200, {
          root: projectRoot,
          name: path.basename(projectRoot),
          path: relNorm,
          entries,
          empty: false,
        });
      } catch (err) {
        jsonReply(res, 500, { error: (err as Error).message });
      }
      return;
    }

    if (url.pathname === '/api/fs/read' && req.method === 'GET') {
      try {
        const projectRoot = getProjectRoot();
        if (!projectRoot) {
          jsonReply(res, 400, { error: '尚未打开项目' });
          return;
        }
        const rel = (url.searchParams.get('path') || '').replace(/\\/g, '/');
        const target = resolveProjectPath(rel);
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          jsonReply(res, 404, { error: '文件不存在' });
          return;
        }
        const st = fs.statSync(target);
        if (st.size > 512 * 1024) {
          jsonReply(res, 400, { error: '文件过大（>512KB），请用对话工具读取' });
          return;
        }
        const buf = fs.readFileSync(target);
        const sample = buf.subarray(0, Math.min(8000, buf.length));
        let nulls = 0;
        for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nulls++;
        if (nulls > 0) {
          jsonReply(res, 400, { error: '二进制文件，无法预览' });
          return;
        }
        let text = buf.toString('utf-8');
        if (text.length > 80000) text = text.substring(0, 80000) + '\n\n…（已截断）';
        jsonReply(res, 200, {
          path: path.relative(projectRoot, target).replace(/\\/g, '/'),
          name: path.basename(target),
          size: st.size,
          content: text,
        });
      } catch (err) {
        jsonReply(res, 500, { error: (err as Error).message });
      }
      return;
    }

    if (url.pathname === '/api/fs/delete' && req.method === 'POST') {
      try {
        const projectRoot = getProjectRoot();
        if (!projectRoot) {
          jsonReply(res, 400, { error: '尚未打开项目' });
          return;
        }
        const body = await readBody(req);
        let rel = '';
        try { rel = (JSON.parse(body).path || '').replace(/\\/g, '/'); } catch { /* */ }
        const target = resolveProjectPath(rel);
        if (!target) {
          jsonReply(res, 400, { error: '路径无效' });
          return;
        }
        if (path.relative(projectRoot, target) === '' || path.relative(projectRoot, target) === '.') {
          jsonReply(res, 400, { error: '不能删除项目根目录' });
          return;
        }
        if (!fs.existsSync(target)) {
          jsonReply(res, 404, { error: '文件不存在' });
          return;
        }
        const st = fs.statSync(target);
        if (st.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
        jsonReply(res, 200, { ok: true });
      } catch (err) {
        jsonReply(res, 500, { error: (err as Error).message });
      }
      return;
    }

    serveStatic(req, res);
  });
}

// ---- Export ----
export function startServer(port: number = PORT, autoOpen: boolean = true): Promise<http.Server> {
  return new Promise((resolve) => {
    backfillSessionContexts();
    const srv = createServer();
    srv.listen(port, () => {
      console.log(`[IEXA] Server running at http://localhost:${port}`);
      if (autoOpen) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'win32'
          ? `start http://localhost:${port}`
          : process.platform === 'darwin'
            ? `open http://localhost:${port}`
            : `xdg-open http://localhost:${port}`;
        exec(cmd);
      }
      resolve(srv);
    });
  });
}

/** Keep a standalone start.bat server tied to its launcher process. */
function monitorStandaloneParent(server: http.Server): void {
  if (process.platform !== 'win32' || !process.ppid || process.ppid === 1) return;
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(timer);
      console.log(`[IEXA] Launcher process ${parentPid} exited; stopping server`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    }
  }, 1000);
  timer.unref();
}

const isDirectRun = require.main === module;
if (isDirectRun) {
  startServer(PORT, true).then((server) => {
    monitorStandaloneParent(server);
    console.log(`\n========================================`);
    console.log(`  IEXA-WIN Client`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`========================================\n`);
  });
}
