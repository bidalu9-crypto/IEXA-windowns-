// =============================================================================
// IEXA PC - HTTP Server (multi-model profiles)
// =============================================================================

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { AgentRuntime, AgentRuntimeConfig } from './runtime/AgentRuntime';
import { ProviderFactory } from './providers/ProviderFactory';
import { makeAgentTools } from './tools/ToolDefinitions';
import { AgentLoopCallbacks, LLMUsage, ProviderType } from './providers/types';
import { setConfigFile, loadConfig, saveConfig, testConnection, syncAll, listSyncConflicts, previewSyncConflict, resolveSyncConflict, WebDAVConfig } from './webdav-sync';
import {
  MAX_TITLE_ATTEMPTS,
  buildConversationSummary,
  callModelForTitle,
  fallbackTitleFromFirstUserMessage,
} from './session-title';
import { SkillStore, ensureBundledSkills } from './skills/SkillStore';
import { maxThinkingLevel } from './providers/ModelCapabilities';
import { PermissionBroker, PermissionRequest, PendingPermission, PermissionDecision, PermissionMode } from './security/PermissionManager';
import { SessionManager } from './session/SessionManager';
import { TraceStore } from './observability/TraceStore';
import { JsonStore } from './persistence/JsonStore';
import { estimateCostUsd } from './observability/CostTracker';
import { contextWindowForModel } from './agent/ContextCompactor';
import { SoulStore, checkSoulBodyLimit, normalizeSoulMetadata } from './agent/SoulStore';
import { configureApiResponse, jsonReply, readBody, readRawBody } from './api/HttpServer';
import { handleWebDAVRoute } from './api/WebDAVRoutes';
import { handleRuntimeRoute } from './api/RuntimeRoutes';
import { GitService } from './git/GitService';
import { TerminalManager } from './terminals/TerminalManager';
import { McpManager } from './mcp/McpManager';
import { VisionFallback } from './vision/VisionFallback';

const PORT = 19840;
const MAX_CHAT_BODY_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
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
const JOBS_FILE = path.join(WORKSPACE_DIR, '.iexa-jobs.json');
const TRACES_DIR = path.join(WORKSPACE_DIR, '.iexa-traces');
const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'src', 'renderer');
const MAX_AUTO_MEMORY_CHARS = 6000;
const MAX_DURABLE_CONTEXT_CHARS = 18000;
const MAX_DURABLE_USER_NOTES = 10;
const MAX_DURABLE_TOOL_NOTES = 12;
const gitService = new GitService();
const terminalManager = new TerminalManager();
const mcpManager = new McpManager(path.join(WORKSPACE_DIR, '.iexa-mcp.json'));
const visionFallback = new VisionFallback();
const soulStore = new SoulStore(MEMORY_DIR);

interface McpAgentBinding { name: string; serverId: string; toolName: string; description: string; }

function activeMcpAgentBindings(): McpAgentBinding[] {
  return mcpManager.list().filter((server) => server.status === 'connected').flatMap((server) => server.tools.map((tool) => {
    const safeTool = tool.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40) || 'tool';
    return {
      name: `mcp_${server.id.replace(/-/g, '').slice(0, 10)}_${safeTool}`.slice(0, 64),
      serverId: server.id,
      toolName: tool.name,
      description: `MCP ${server.name} · ${tool.description || tool.name}`,
    };
  }));
}

setConfigFile(WEBDAV_CONFIG_FILE);

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(SESSION_CONTEXT_DIR, { recursive: true });
fs.mkdirSync(TRACES_DIR, { recursive: true });
soulStore.ensureExists();

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
    if (fs.existsSync(PROJECT_FILE) || fs.existsSync(`${PROJECT_FILE}.bak`)) {
      const raw = new JsonStore<Record<string, unknown>>(PROJECT_FILE, () => ({})).loadSync();
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
  new JsonStore<ProjectState>(PROJECT_FILE, () => state).saveSync(state);
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
    invalidateAllAgentsForNextTurn();
    return { ok: true, project: projectInfo() };
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: '文件夹不存在' };
  }
  projectState.root = abs;
  projectState.recent = [abs, ...projectState.recent.filter((p) => p !== abs)].slice(0, 12);
  saveProjectState(projectState);
  invalidateAllAgentsForNextTurn();
  return { ok: true, project: projectInfo() };
}

interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

const WORKSPACE_SEARCH_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'coverage']);

/** Bounded literal text search used by the project workbench search panel. */
function searchProjectText(root: string, query: string, limit: number): WorkspaceSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const results: WorkspaceSearchResult[] = [];
  const pending = [root];
  let visitedFiles = 0;
  const maxFiles = 2_500;

  while (pending.length && results.length < limit && visitedFiles < maxFiles) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (results.length >= limit || visitedFiles >= maxFiles) break;
      if (entry.name === '.' || entry.name === '..' || WORKSPACE_SEARCH_SKIP.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      visitedFiles++;
      let data: Buffer;
      try {
        const stat = fs.statSync(target);
        if (stat.size > 1024 * 1024) continue;
        data = fs.readFileSync(target);
      } catch { continue; }
      if (data.subarray(0, Math.min(data.length, 8192)).includes(0)) continue;
      const lines = data.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < limit; index++) {
        const column = lines[index].toLocaleLowerCase().indexOf(needle);
        if (column < 0) continue;
        results.push({
          path: path.relative(root, target).replace(/\\/g, '/'),
          line: index + 1,
          column: column + 1,
          preview: lines[index].trim().slice(0, 300),
        });
      }
    }
  }
  return results;
}

// ---- Profile Types ----
interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  /** API-reported context window from /v1/models (if available). */
  contextWindow?: number;
  /** User-selected compaction ceiling; undefined means model automatic. */
  contextCompactionLimit?: number;
  /** API-reported max output tokens. */
  maxOutputTokens?: number;
  /** Endpoint contract: it accepts Codex Fast's service_tier: priority field. */
  fastModeSupported?: boolean;
  /** Wire envelope: /v1/chat/completions or /v1/responses. */
  apiMode?: 'chat_completions' | 'responses';
}

interface AppSettings {
  profiles: ModelProfile[];
  activeProfileId: string;
  /** Global thinking effort: off | low | medium | high (iOS-style). */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** User-selected context ceiling for automatic compaction. */
  contextCompactionLimit?: number;
  permissionMode?: PermissionMode;
  visionProfileId?: string;
}

// ---- Settings I/O ----
function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE) || fs.existsSync(`${SETTINGS_FILE}.bak`)) {
      const raw = new JsonStore<Record<string, any>>(SETTINGS_FILE, () => ({})).loadSync();
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
        contextCompactionLimit: normalizeContextCompactionLimit(raw.contextCompactionLimit),
        permissionMode: normalizePermissionMode(raw.permissionMode),
        visionProfileId: typeof raw.visionProfileId === 'string' ? raw.visionProfileId : undefined,
      };
    }
  } catch { /* ignore */ }
  return { profiles: [], activeProfileId: '', thinkingLevel: 'medium', permissionMode: 'risk' };
}

function profileLikelySupportsVision(profile: ModelProfile | null | undefined): boolean {
  if (!profile) return false;
  const model = profile.model.toLowerCase();
  return profile.provider === 'anthropic' || profile.provider === 'gemini' || /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|vl|llava|qwen2\.5-vl|qwen3-vl/.test(model);
}

function configuredVisionProfile(currentProfileId?: string): ModelProfile | null {
  const settings = loadSettings();
  const profile = settings.profiles.find((item) => item.id === settings.visionProfileId) || null;
  // Compatible gateways commonly use private model aliases. The user chooses
  // the vision route explicitly, so every configured profile is eligible.
  return profile && Boolean(profile.apiKey) ? profile : null;
}

function imageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' } as Record<string, string>)[ext] || null;
}

const CONTEXT_COMPACTION_LIMITS = [128_000, 256_000, 384_000, 768_000, 1_000_000] as const;

type ContextCompactionLimit = typeof CONTEXT_COMPACTION_LIMITS[number];

function normalizeContextCompactionLimit(value: unknown): ContextCompactionLimit | undefined {
  if (value === undefined || value === null || value === '' || value === 'auto') return undefined;
  const numeric = Number(value);
  return CONTEXT_COMPACTION_LIMITS.includes(numeric as ContextCompactionLimit)
    ? numeric as ContextCompactionLimit
    : undefined;
}

function effectiveContextWindow(profile: ModelProfile, limit: unknown): number {
  const reportedWindow = Number(profile.contextWindow);
  const hasReportedWindow = Number.isFinite(reportedWindow) && reportedWindow > 0;
  const modelWindow = hasReportedWindow
    ? Math.floor(reportedWindow)
    : contextWindowForModel(profile.model, profile.provider);
  const selectedLimit = normalizeContextCompactionLimit(limit);
  // A custom/OpenAI-compatible endpoint often omits context_window from
  // /v1/models. In that case `modelWindow` is only a conservative guess, so
  // the user-selected compaction tier must override it. A provider-reported
  // window remains a hard ceiling to avoid sending a request it cannot accept.
  if (selectedLimit) return hasReportedWindow ? Math.min(modelWindow, selectedLimit) : selectedLimit;
  return modelWindow;
}

function getContextCompactionLimit(): ContextCompactionLimit | undefined {
  return normalizeContextCompactionLimit(loadSettings().contextCompactionLimit);
}

function saveContextCompactionLimit(value: unknown): ContextCompactionLimit | undefined {
  const limit = normalizeContextCompactionLimit(value);
  const s = loadSettings();
  s.contextCompactionLimit = limit;
  saveSettings(s);
  invalidateAllAgentsForNextTurn();
  return limit;
}

function normalizePermissionMode(value: unknown): PermissionMode {
  const mode = String(value || '').toLowerCase();
  return mode === 'ask' || mode === 'full' ? mode : 'risk';
}

function normalizeThinkingLevel(v: unknown): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {
  const id = String(v || '').toLowerCase();
  if (id === 'off' || id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh' || id === 'max' || id === 'ultra') return id;
  return 'medium';
}

function getThinkingLevel(): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {
  return normalizeThinkingLevel(loadSettings().thinkingLevel);
}

function getPermissionMode(): PermissionMode {
  return normalizePermissionMode(loadSettings().permissionMode);
}

function saveSettings(s: AppSettings): void {
  new JsonStore<AppSettings>(SETTINGS_FILE, () => s).saveSync(s);
}

function activeProfile(): ModelProfile | null {
  const s = loadSettings();
  return s.profiles.find(p => p.id === s.activeProfileId) || s.profiles[0] || null;
}

function modelBindingForProfile(profile: ModelProfile): SessionModelBinding {
  return {
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    contextWindow: effectiveContextWindow(profile, profile.contextCompactionLimit ?? loadSettings().contextCompactionLimit),
    maxOutputTokens: profile.maxOutputTokens,
  };
}

/** Resolve a pinned session route. Existing pre-binding sessions migrate lazily. */
function profileForSession(sessionId: string): ModelProfile | null {
  const settings = loadSettings();
  const store = loadSessionStore();
  const session = store.sessions.find((item) => item.id === sessionId);
  const binding = session?.modelBinding;
  if (binding) {
    const bound = settings.profiles.find((profile) => profile.id === binding.profileId);
    if (bound) return bound;
    return null; // A deleted profile must not silently route a pinned conversation elsewhere.
  }
  const fallback = settings.profiles.find((profile) => profile.id === settings.activeProfileId) || settings.profiles[0] || null;
  if (fallback && session) {
    session.modelBinding = modelBindingForProfile(fallback);
    saveSessionStore(store);
  }
  return fallback;
}

/** Fast is an endpoint capability, not a model-name promise. A profile must
 * explicitly opt in because many relays reject unknown service_tier fields. */
function profileSupportsFastMode(profile: ModelProfile | null | undefined): boolean {
  if (!profile?.fastModeSupported) return false;
  const provider = String(profile.provider || '').toLowerCase();
  const model = String(profile.model || '').toLowerCase();
  const isOpenAICompatible = provider === 'openai' || provider === 'openrouter' || provider === 'custom';
  if (profile.apiMode !== 'responses') return false;
  const isCodexFamily = /(?:^|[-_/])gpt(?:[-_/]|$)|codex/.test(model);
  return isOpenAICompatible && isCodexFamily;
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
  toolCalls?: { id: string; name: string; args: Record<string, unknown>; result?: { output: string; success: boolean; todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>; fileChange?: NonNullable<import('./providers/types').ToolExecutionResult['fileChange']>; artifacts?: NonNullable<import('./providers/types').ToolExecutionResult['artifacts']> } }[];
  /** Files changed successfully in this assistant turn, independent of final prose. */
  deliverables?: { path: string; absolutePath?: string; added?: number; removed?: number }[];
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
  savedPath?: string;
  size?: number;
}

interface SessionModelBinding {
  profileId: string;
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
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
  /** Model is pinned per session so concurrent chats cannot drift with global defaults. */
  modelBinding?: SessionModelBinding;
  /** Per-conversation Codex Fast setting; sends service_tier: priority on eligible routes. */
  fastModeEnabled?: boolean;
}

interface SessionStore {
  sessions: Session[];
  activeSessionId: string;
}

const messageStore = new SessionManager<ChatMessage[]>(SESSIONS_DIR);

// ---- Session I/O ----
function loadSessionStore(): SessionStore {
  try {
    if (fs.existsSync(SESSIONS_FILE) || fs.existsSync(`${SESSIONS_FILE}.bak`)) return new JsonStore<SessionStore>(SESSIONS_FILE, () => ({ sessions: [], activeSessionId: '' })).loadSync();
  } catch { /* ignore */ }
  return { sessions: [], activeSessionId: '' };
}

function saveSessionStore(s: SessionStore): void {
  new JsonStore<SessionStore>(SESSIONS_FILE, () => s).saveSync(s);
}

function loadMessages(sessionId: string): ChatMessage[] {
  try {
    return messageStore.loadSync(sessionId) || [];
  } catch { /* ignore */ }
  return [];
}

function saveMessages(sessionId: string, msgs: ChatMessage[]): void {
  messageStore.saveSync(sessionId, msgs);
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

function compactContextText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `\n[... compacted from ${text.length.toLocaleString()} chars ...]\n`;
  const available = Math.max(80, limit - marker.length);
  const head = Math.ceil(available * 0.7);
  return (text.slice(0, head) + marker + text.slice(-(available - head))).slice(0, limit);
}

/** Load newest memories within a hard request-context budget. */
function loadRecentMemories(maxFiles = 5, maxChars = MAX_AUTO_MEMORY_CHARS): string {
  try {
    if (!fs.existsSync(MEMORY_DIR)) return '';
    const files = fs.readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, maxFiles);
    if (files.length === 0) return '';
    const entries: string[] = [];
    let remaining = maxChars;
    for (const file of files) {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf-8').trim();
      if (!content || remaining <= 0) continue;
      const separator = entries.length ? 7 : 0;
      const budget = remaining - separator;
      if (budget <= 0) break;
      const clipped = compactContextText(content, budget);
      entries.push(clipped);
      remaining -= clipped.length + separator;
    }
    return entries.join('\n\n---\n\n');
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
      userNotes.push(compactContextText(message.content.trim(), 600));
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
      const output = compactContextText(String(call.result?.output || '').trim(), 700);
      toolNotes.push(`${call.name}: ${compactContextText(args, 400)}${output ? `\n结果: ${output}` : ''}`);
    }
  }
  // Deduplicate config anchors while keeping last occurrence order.
  const uniqueConfig = [...new Set(configAnchors)];
  const sections = [
    '持久化会话上下文（来自本会话已保存的消息、工具调用和工具结果；其中的链接、路径、标识符应视为已知事实）：',
    userNotes.length ? `用户的重要原话（最近 ${Math.min(MAX_DURABLE_USER_NOTES, userNotes.length)} 条）:\n${userNotes.slice(-MAX_DURABLE_USER_NOTES).map((v) => `- ${v}`).join('\n')}` : '',
    uniqueConfig.length ? `关键配置/参数（最近 ${Math.min(20, uniqueConfig.length)} 条）:\n${uniqueConfig.slice(-20).map((v) => `- ${v}`).join('\n')}` : '',
    paths.size ? `已出现的文件/路径:\n${[...paths].slice(-30).map((v) => `- ${v}`).join('\n')}` : '',
    urls.size ? `已出现的链接:\n${[...urls].slice(-30).map((v) => `- ${v}`).join('\n')}` : '',
    toolNotes.length ? `最近工具调用及结果摘要（最近 ${Math.min(MAX_DURABLE_TOOL_NOTES, toolNotes.length)} 条）:\n${toolNotes.slice(-MAX_DURABLE_TOOL_NOTES).join('\n\n')}` : '',
  ].filter(Boolean);
  let content = '';
  for (const section of sections) {
    const separator = content ? '\n\n' : '';
    const remaining = MAX_DURABLE_CONTEXT_CHARS - content.length - separator.length;
    if (remaining <= 0) break;
    content += separator + compactContextText(section, remaining);
  }
  const state: DurableSessionContext = { version: 2, sessionId, updatedAt: Date.now(), content, summary: summary || undefined };
  try { new JsonStore<DurableSessionContext>(sessionContextPath(sessionId), () => state).saveSync(state); } catch { /* best effort */ }
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
  estimatedCostUsd?: number | null;
  updatedAt: number;
}

function loadTokenUsage(): TokenUsageRecord[] {
  try {
    if (fs.existsSync(TOKEN_USAGE_FILE) || fs.existsSync(`${TOKEN_USAGE_FILE}.bak`)) {
      const raw = new JsonStore<unknown>(TOKEN_USAGE_FILE, () => []).loadSync();
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
    record = { key, provider: profile.provider, model: profile.model, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, requests: 0, estimatedCostUsd: null, updatedAt: Date.now() };
    records.push(record);
  }
  record.inputTokens += Math.max(0, Number(usage.inputTokens) || 0);
  record.outputTokens += Math.max(0, Number(usage.outputTokens) || 0);
  record.cacheCreationInputTokens += Math.max(0, Number(usage.cacheCreationInputTokens) || 0);
  record.cacheReadInputTokens += Math.max(0, Number(usage.cacheReadInputTokens) || 0);
  record.requests += 1;
  record.estimatedCostUsd = estimateCostUsd(record.provider, record.model, record);
  record.updatedAt = Date.now();
  new JsonStore<TokenUsageRecord[]>(TOKEN_USAGE_FILE, () => records).saveSync(records);
}

// ---- Agent (per session) ----
const agentCache = new Map<string, AgentRuntime>();
const permissionBroker = new PermissionBroker();
const permissionSubscriptions = new Map<string, () => void>();

function permissionPayload(item: PendingPermission): Record<string, unknown> {
  const tool = item.request.tool;
  return {
    id: item.id,
    sessionId: item.request.sessionId,
    tool: { name: tool.name, description: tool.description, risk: tool.risk },
    args: item.request.args,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}
/** Live turns only; cached idle agents remain reusable and are not considered running. */
const runningSessionIds = new Set<string>();
/**
 * Settings alter the next request envelope. Never abort an active stream just
 * to refresh that envelope; discard its cached runtime after it completes.
 */
const pendingAgentInvalidation = new Set<string>();
const artifactRegistry = new Map<string, { path: string; mimeType: string; size: number; created: number }>();
const uploadRegistry = new Map<string, { sessionId: string; name: string; mime: string; kind: string; size: number; received: number; partPath: string; created: number }>();

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
interface SessionJob {
  id: string;
  sessionId: string;
  kind: 'turn' | 'tool';
  /** Tool-call ID for tool jobs; turn jobs use their own stable job ID. */
  toolId?: string;
  toolName?: string;
  title: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  success?: boolean;
  outputPreview?: string;
}

function loadJobs(): SessionJob[] {
  try {
    const parsed = new JsonStore<unknown>(JOBS_FILE, () => []).loadSync();
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveJobs(jobs: SessionJob[]): void {
  // Retain a useful recent audit without making the desktop state file unbounded.
  new JsonStore<SessionJob[]>(JOBS_FILE, () => []).saveSync(jobs.slice(-500));
}
function updateJob(sessionId: string, toolId: string, mutate: (job: SessionJob) => void): SessionJob | undefined {
  const jobs = loadJobs();
  const job = [...jobs].reverse().find((item) => item.sessionId === sessionId && item.toolId === toolId);
  if (!job) return undefined;
  mutate(job);
  saveJobs(jobs);
  return job;
}
function updateJobById(jobId: string, mutate: (job: SessionJob) => void): SessionJob | undefined {
  const jobs = loadJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return undefined;
  mutate(job);
  saveJobs(jobs);
  return job;
}
function createTurnJob(sessionId: string, message: string): SessionJob {
  const jobs = loadJobs();
  const prompt = String(message || '').trim().replace(/\s+/g, ' ');
  const job: SessionJob = {
    id: `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    kind: 'turn',
    title: prompt ? `AI 回复：${prompt.slice(0, 72)}` : 'AI 正在处理附件',
    status: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
  };
  jobs.push(job);
  saveJobs(jobs);
  return job;
}
function createToolJob(sessionId: string, toolId: string, toolName: string, args: Record<string, unknown>): SessionJob {
  const jobs = loadJobs();
  const title = typeof args.tool_title === 'string' && args.tool_title.trim()
    ? args.tool_title.trim()
    : `${toolName}: ${typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command.slice(0, 72) : '等待执行'}`;
  const job: SessionJob = { id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, sessionId, kind: 'tool', toolId, toolName, title, status: 'queued', createdAt: Date.now() };
  jobs.push(job);
  saveJobs(jobs);
  return job;
}
function cancelLiveJobs(sessionId: string): void {
  const jobs = loadJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.sessionId === sessionId && (job.status === 'queued' || job.status === 'running')) {
      job.status = 'cancelled'; job.finishedAt = Date.now(); changed = true;
    }
  }
  if (changed) saveJobs(jobs);
}

function getOrCreateAgent(sessionId: string): AgentRuntime | null {
  let agent = agentCache.get(sessionId);
  if (agent) return agent;

  const profile = profileForSession(sessionId);
  if (!profile || !profile.apiKey) return null;

  const session = loadSessionStore().sessions.find((item) => item.id === sessionId);
  const useFastMode = session?.fastModeEnabled === true && profileSupportsFastMode(profile);
  const provider = ProviderFactory.create({
    type: profile.provider as ProviderType,
    name: profile.provider,
    model: profile.model,
    apiKey: profile.apiKey,
    baseURL: profile.baseURL || undefined,
    thinkingLevel: getThinkingLevel(),
    fastMode: useFastMode,
    apiMode: profile.apiMode === 'responses' ? 'responses' : 'chat_completions',
  });

  // Tools run in the opened project (OpenCode-style); fall back to app workspace
  const projectRoot = getProjectRoot();
  const toolCwd = projectRoot || WORKSPACE_DIR;
  skillStore.reload();
  const skillsDir = skillStore.getSkillsDir();
  const config: Omit<AgentRuntimeConfig, 'sessionId'> = {
    provider,
    workspaceDir: toolCwd,
    memoryDir: MEMORY_DIR,
    memoryEnabled: true,
    // The context policy must reserve against the route's actual output cap.
    maxTokens: profile.maxOutputTokens || 64000,
    hasProject: !!projectRoot,
    projectName: projectRoot ? path.basename(projectRoot) : null,
    skillFragment: skillStore.skillPromptFragment(),
    systemSkillFragment: skillStore.systemPromptFragment(),
    skillsDir,
    soul: soulStore.load(),
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
    contextWindow: effectiveContextWindow(profile, profile.contextCompactionLimit ?? getContextCompactionLimit()),
    permissionResolver: (request: PermissionRequest) => permissionBroker.request(request),
    permissionMode: getPermissionMode(),
  };
  agent = new AgentRuntime({ ...config, sessionId, auditDir: path.join(WORKSPACE_DIR, '.iexa-audit'), traceDir: TRACES_DIR });
  agentCache.set(sessionId, agent);
  return agent;
}

function cancelSessionAgent(sessionId: string, dispose = true): void {
  pendingAgentInvalidation.delete(sessionId);
  const agent = agentCache.get(sessionId);
  if (agent) {
    agent.cancel();
    if (dispose) agentCache.delete(sessionId);
  }
  permissionBroker.cancelSession(sessionId);
}

function invalidateAgentForNextTurn(sessionId: string): void {
  if (runningSessionIds.has(sessionId)) {
    pendingAgentInvalidation.add(sessionId);
    return;
  }
  agentCache.delete(sessionId);
}

function invalidateAllAgentsForNextTurn(): void {
  for (const sessionId of agentCache.keys()) invalidateAgentForNextTurn(sessionId);
}

function finishPendingAgentInvalidation(sessionId: string): void {
  if (!pendingAgentInvalidation.delete(sessionId)) return;
  agentCache.delete(sessionId);
}

function clearPermissionSubscription(sessionId: string): void {
  const unsubscribe = permissionSubscriptions.get(sessionId);
  if (unsubscribe) {
    unsubscribe();
    permissionSubscriptions.delete(sessionId);
  }
}

// Helper: persist chat messages after a turn
function saveSessionMessages(
  sessionId: string,
  existingMessages: ChatMessage[],
  userMsg: ChatMessage,
  assistantText: string,
  toolCalls: { id: string; name: string; args: Record<string, unknown>; result?: { output: string; success: boolean; todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>; fileChange?: NonNullable<import('./providers/types').ToolExecutionResult['fileChange']>; artifacts?: NonNullable<import('./providers/types').ToolExecutionResult['artifacts']> } }[],
  usage: { inputTokens: number; outputTokens: number } | undefined,
): void {
  const deliverables = toolCalls
    .filter((call) => call.result?.success && call.result.fileChange?.path)
    .map((call) => ({
      path: call.result!.fileChange!.path,
      absolutePath: call.result!.fileChange!.absolutePath,
      added: call.result!.fileChange!.added,
      removed: call.result!.fileChange!.removed,
    }))
    .filter((file, index, files) => files.findIndex((item) => (item.absolutePath || item.path) === (file.absolutePath || file.path)) === index);
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: assistantText,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    deliverables: deliverables.length > 0 ? deliverables : undefined,
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
    configureApiResponse(res);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (await handleWebDAVRoute(req, res, url, {
      workspaceDir: WORKSPACE_DIR, sessionsDir: SESSIONS_DIR, settingsFile: SETTINGS_FILE, sessionsStoreFile: SESSIONS_FILE,
      maskPassword: maskKey, loadConfig, saveConfig, testConnection, syncAll,
      listConflicts: listSyncConflicts, previewConflict: previewSyncConflict, resolveConflict: resolveSyncConflict,
    })) return;

    if (await handleRuntimeRoute(req, res, url, {
      agents: agentCache, permissionBroker, permissionPayload,
      getPermissionMode, normalizePermissionMode,
      setPermissionMode: (mode) => { const settings = loadSettings(); settings.permissionMode = mode; saveSettings(settings); },
      loadJobs, readTraces: (sessionId, limit) => new TraceStore(TRACES_DIR).read(sessionId, limit),
      cancelSession: cancelSessionAgent, clearRunningSession: (sessionId) => runningSessionIds.delete(sessionId), cancelLiveJobs,
    })) return;

    // =====================================================================
    // System info
    // =====================================================================
    if (url.pathname === '/api/system' && req.method === 'GET') {
      jsonReply(res, 200, getSystemInfo());
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
        const initialProfile = activeProfile();
        const session: Session = {
          id: 'sess_' + Date.now(),
          title: '新会话',
          titleSource: 'default',
          titleGenAttempts: 0,
          created: Date.now(),
          updated: Date.now(),
          messageCount: 0,
          modelBinding: initialProfile ? modelBindingForProfile(initialProfile) : undefined,
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
        const session = loadSessionStore().sessions.find((item) => item.id === sid);
        jsonReply(res, 200, { messages: msgs, session });
        return;
      }

      // Explicitly switch only this conversation's route. Existing in-flight
      // work must finish/cancel before changing the AgentLoop provider.
      if (req.method === 'PUT' && url.pathname.endsWith('/model')) {
        const sessionId = url.pathname.split('/').slice(-2, -1)[0] || '';
        try {
          const { profileId } = JSON.parse(await readBody(req));
          const settings = loadSettings();
          const profile = settings.profiles.find((item) => item.id === profileId);
          const store = loadSessionStore();
          const session = store.sessions.find((item) => item.id === sessionId);
          if (!profile || !session) { jsonReply(res, 404, { error: '会话或模型不存在。' }); return; }
          if (runningSessionIds.has(sessionId)) { jsonReply(res, 409, { error: '请等待当前会话任务结束后再切换模型。' }); return; }
          // Drop only this idle cached AgentLoop: its next turn rehydrates under
          // the newly selected per-session profile and context capacity.
          agentCache.delete(sessionId);
          session.modelBinding = modelBindingForProfile(profile);
          session.updated = Date.now();
          saveSessionStore(store);
          jsonReply(res, 200, { ok: true, session });
        } catch { jsonReply(res, 400, { error: '无效的模型切换请求。' }); }
        return;
      }

      // Toggle the real Codex Fast wire mode only for profiles that opted in
      // to service_tier: priority compatibility. The AgentLoop is recreated so
      // the next HTTP request cannot reuse a provider with stale mode state.
      if (req.method === 'PUT' && url.pathname.endsWith('/fast')) {
        const sessionId = url.pathname.split('/').slice(-2, -1)[0] || '';
        try {
          const { enabled } = JSON.parse(await readBody(req));
          const store = loadSessionStore();
          const session = store.sessions.find((item) => item.id === sessionId);
          const profile = profileForSession(sessionId);
          if (!session || !profile) { jsonReply(res, 404, { error: '会话或模型不存在。' }); return; }
          if (runningSessionIds.has(sessionId)) { jsonReply(res, 409, { error: '请等待当前会话任务结束后再切换 Fast 模式。' }); return; }
          if (enabled === true && !profileSupportsFastMode(profile)) {
            jsonReply(res, 400, { error: '当前模型端点未声明支持 Fast（service_tier: priority）。' }); return;
          }
          session.fastModeEnabled = enabled === true;
          session.updated = Date.now();
          agentCache.delete(sessionId);
          saveSessionStore(store);
          jsonReply(res, 200, { ok: true, enabled: session.fastModeEnabled, session });
        } catch { jsonReply(res, 400, { error: '无效的 Fast 模式请求。' }); }
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
    // Chunked attachment uploads
    // =====================================================================
    if (url.pathname === '/api/uploads/init' && req.method === 'POST') {
      try {
        const parsed = JSON.parse(await readBody(req, 1_000_000) || '{}');
        const sessionId = String(parsed.sessionId || '').trim();
        const name = sanitizeFileName(String(parsed.name || 'file'));
        const mime = String(parsed.mime || 'application/octet-stream');
        const kind = ['image', 'text', 'file'].includes(String(parsed.kind)) ? String(parsed.kind) : 'file';
        const size = Number(parsed.size);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !Number.isSafeInteger(size) || size <= MAX_ATTACHMENT_BYTES || size > MAX_UPLOAD_BYTES) {
          jsonReply(res, 400, { error: `分块上传文件大小需大于 8 MB 且不超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB。` });
          return;
        }
        const uploadId = `upl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const uploadDir = path.join(WORKSPACE_DIR, 'uploads', sessionId, '.chunks');
        fs.mkdirSync(uploadDir, { recursive: true });
        const partPath = path.join(uploadDir, `${uploadId}.part`);
        fs.writeFileSync(partPath, Buffer.alloc(0));
        uploadRegistry.set(uploadId, { sessionId, name, mime, kind, size, received: 0, partPath, created: Date.now() });
        jsonReply(res, 200, { uploadId, chunkBytes: MAX_UPLOAD_CHUNK_BYTES });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message || '上传初始化失败。' });
      }
      return;
    }

    if (url.pathname === '/api/uploads/chunk' && req.method === 'POST') {
      try {
        const uploadId = String(url.searchParams.get('uploadId') || '');
        const upload = uploadRegistry.get(uploadId);
        const offset = Number(url.searchParams.get('offset') || '0');
        if (!upload || Date.now() - upload.created > 2 * 60 * 60 * 1000) throw new Error('上传已过期或不存在。');
        if (!Number.isSafeInteger(offset) || offset !== upload.received) throw new Error(`分块偏移错误，期望 ${upload.received}。`);
        // Leave a small transport margin; enforce the actual decoded chunk
        // size after collection so chunked transfer framing never trips the
        // body reader at the exact 4 MB boundary.
        const chunk = await readRawBody(req, MAX_UPLOAD_CHUNK_BYTES + 64 * 1024);
        if (chunk.length > MAX_UPLOAD_CHUNK_BYTES) throw new Error(`上传分块过大（上限 ${MAX_UPLOAD_CHUNK_BYTES} 字节）。`);
        if (upload.received + chunk.length > upload.size) throw new Error('分块超出文件声明大小。');
        fs.appendFileSync(upload.partPath, chunk);
        upload.received += chunk.length;
        jsonReply(res, 200, { received: upload.received, size: upload.size });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message || '上传分块失败。' });
      }
      return;
    }

    if (url.pathname === '/api/uploads/complete' && req.method === 'POST') {
      try {
        const parsed = JSON.parse(await readBody(req, 1_000_000) || '{}');
        const uploadId = String(parsed.uploadId || '');
        const upload = uploadRegistry.get(uploadId);
        if (!upload) throw new Error('上传已过期或不存在。');
        if (upload.received !== upload.size) throw new Error(`文件尚未上传完整（${upload.received}/${upload.size}）。`);
        const stamp = Date.now().toString(36);
        const destName = `${stamp}_${upload.name}`;
        const destDir = path.join(WORKSPACE_DIR, 'uploads', upload.sessionId);
        const dest = path.join(destDir, destName);
        fs.renameSync(upload.partPath, dest);
        uploadRegistry.delete(uploadId);
        const savedPath = path.join('uploads', upload.sessionId, destName).replace(/\\/g, '/');
        jsonReply(res, 200, { savedPath, name: upload.name, mime: upload.mime, kind: upload.kind, size: upload.size });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message || '上传完成失败。' });
      }
      return;
    }

    // =====================================================================
    // Chat API
    // =====================================================================
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      // Attachments are base64 encoded in the JSON envelope, so chat needs a
      // larger body budget than ordinary settings routes. Per-file and total
      // decoded-byte limits below keep this bounded.
      const body = await readBody(req, MAX_CHAT_BODY_BYTES);
      let requestSessionId = '';
      try {
        const parsed = JSON.parse(body);
        const message: string = parsed.message || '';
        const sessionId: string = parsed.sessionId || '';
        requestSessionId = sessionId;
        const rawAttachments: IncomingAttachment[] = Array.isArray(parsed.attachments) ? parsed.attachments : [];
        if (!message && rawAttachments.length === 0) throw new Error('message required');
        if (!sessionId) throw new Error('sessionId required');

        const profile = profileForSession(sessionId);
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
        // Auto-inject recent memories into durable context (跨会话记忆)
        const recentMemories = loadRecentMemories(5);
        const memorySection = recentMemories
          ? `

<memory-log>
${recentMemories}
</memory-log>`
          : '';
        agent.setSessionContext(durableContext + memorySection);
        // Restore Codex-style compaction summary (survives restarts)
        const persistedSummary = loadSessionSummary(sessionId);
        if (persistedSummary) {
          agent.setCompactorSummary(persistedSummary);
        }
        if (needHydrate) {
          // Prior turns from disk → model remembers after reopen / process restart
          agent.seedHistoryFromChat(persistedMessages);
        }
        const visionProfile = configuredVisionProfile(profile.id);
        if (visionProfile && !profileLikelySupportsVision(profile)) {
          agent.registerDynamicTool({
            name: 'read_image',
            description: `Use the configured vision model ${visionProfile.name} to inspect an image file. It returns a factual description and OCR text for this text-only model.`,
            parameters: {
              path: { type: 'string', description: 'Absolute image path shown in the attachment note or workspace.' },
              prompt: { type: 'string', description: 'Optional specific image question.' },
            }, required: ['path'], propertyOrdering: ['path', 'prompt'],
          }, async (args) => {
            try {
              const source = path.resolve(String(args.path || ''));
              const allowedRoots = [WORKSPACE_DIR, getProjectRoot()].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
              if (!allowedRoots.some((root) => { const relative = path.relative(root, source); return !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new Error('图片路径不在当前工作区或项目中。');
              const mimeType = imageMimeType(source);
              if (!mimeType || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('未找到可识别的图片文件。');
              if (fs.statSync(source).size > 10 * 1024 * 1024) throw new Error('图片超过 10 MB。');
              const output = await visionFallback.describe({ ...visionProfile, type: visionProfile.provider as ProviderType, displayName: visionProfile.name }, fs.readFileSync(source), mimeType, String(args.prompt || ''));
              return { output, success: true };
            } catch (error) { return { output: `图片识别失败：${(error as Error).message}`, success: false }; }
          });
        }
        const mcpBindings = activeMcpAgentBindings();
        for (const binding of mcpBindings) {
          agent.registerDynamicTool({
            name: binding.name,
            description: `${binding.description}。arguments_json 必须是传给该 MCP 工具的 JSON 对象字符串。`,
            parameters: { arguments_json: { type: 'string', description: 'JSON object arguments for this MCP tool.' } },
            required: ['arguments_json'],
            propertyOrdering: ['arguments_json'],
          }, async (args) => {
            try {
              const raw = String(args.arguments_json || '{}');
              const parsed = JSON.parse(raw);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments_json 必须是 JSON 对象。');
              const result = await mcpManager.callTool(binding.serverId, binding.toolName, parsed as Record<string, unknown>);
              return { output: typeof result === 'string' ? result : JSON.stringify(result, null, 2), success: true };
            } catch (error) {
              return { output: `MCP 工具调用失败：${(error as Error).message}`, success: false };
            }
          });
        }
        const tools = [...makeAgentTools(true), ...(visionProfile && !profileLikelySupportsVision(profile) ? [{
          name: 'read_image', description: `Use the configured vision model ${visionProfile.name} to inspect an image file. It returns factual description and OCR text.`,
          parameters: { path: { type: 'string' as const, description: 'Absolute image file path.' }, prompt: { type: 'string' as const, description: 'Optional image question.' } },
          required: ['path'], propertyOrdering: ['path', 'prompt'],
        }] : []), ...mcpBindings.map((binding) => ({
          name: binding.name,
          description: `${binding.description}。arguments_json 必须是传给该 MCP 工具的 JSON 对象字符串。`,
          parameters: { arguments_json: { type: 'string' as const, description: 'JSON object arguments for this MCP tool.' } },
          required: ['arguments_json'], propertyOrdering: ['arguments_json'],
        }))];

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

        let totalAttachmentBytes = 0;
        for (const raw of rawAttachments.slice(0, MAX_ATTACHMENTS)) {
          const safeName = sanitizeFileName(raw.name || 'file');
          const kind = (raw.kind === 'image' || raw.kind === 'text' || raw.kind === 'file')
            ? raw.kind
            : (raw.mime || '').startsWith('image/') ? 'image'
              : raw.text != null ? 'text' : 'file';
          const mime = raw.mime || (kind === 'image' ? 'image/png' : kind === 'text' ? 'text/plain' : 'application/octet-stream');

          let data: Buffer | undefined;
          let text = raw.text;
          let previewUrl: string | undefined;
          let savedPath: string | undefined = typeof raw.savedPath === 'string' ? raw.savedPath.replace(/\\/g, '/') : undefined;
          let savedStat: fs.Stats | undefined;

          if (savedPath) {
            const candidate = path.resolve(WORKSPACE_DIR, savedPath);
            const uploadRoot = path.resolve(WORKSPACE_DIR, 'uploads', sessionId);
            const relative = path.relative(uploadRoot, candidate);
            if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(candidate)) throw new Error(`上传文件不存在：${safeName}`);
            savedStat = fs.statSync(candidate);
            if (!savedStat.isFile() || savedStat.size > MAX_UPLOAD_BYTES) throw new Error(`上传文件大小或类型无效：${safeName}`);
            if (kind === 'image') {
              previewUrl = `/api/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(path.basename(candidate))}`;
              if (savedStat.size <= 10 * 1024 * 1024) data = fs.readFileSync(candidate);
            }
          }

          if (!savedPath && raw.dataUrl && typeof raw.dataUrl === 'string') {
            const m = raw.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
            if (m) {
              data = Buffer.from(m[2], 'base64');
              if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB：${safeName}`);
              if (kind === 'image' && raw.dataUrl.length < 200000) {
                previewUrl = raw.dataUrl;
              }
            }
          }
          const attachmentBytes = savedStat?.size ?? data?.length ?? (text == null ? 0 : Buffer.byteLength(text, 'utf8'));
          const attachmentLimit = savedPath ? MAX_UPLOAD_BYTES : MAX_ATTACHMENT_BYTES;
          if (attachmentBytes > attachmentLimit) throw new Error(`附件超过 ${attachmentLimit / (1024 * 1024)} MB：${safeName}`);
          totalAttachmentBytes += attachmentBytes;
          if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`附件总大小超过 ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB`);

          // Persist inline attachments to workspace so agent tools can open the path.
          if (!savedPath) try {
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

          // Text-only active models receive a stable local image path and can
          // call read_image, which delegates pixels to the configured vision
          // profile. Native vision models retain the direct image bytes.
          const directImageData = kind === 'image' && !profileLikelySupportsVision(profile) && configuredVisionProfile(profile.id)
            ? undefined
            : data;
          agentAttachments.push({ name: safeName, mime, kind, data: directImageData, text: savedPath && kind === 'text' ? undefined : text, savedPath });
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

        // A chat turn is a real background task even when no tool is used.
        // This makes the task center useful for ordinary model-only replies too.
        const turnJob = createTurnJob(sessionId, message);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        // Disable Nagle so tiny SSE frames (tool_start) leave the socket immediately.
        try { (res.socket as any)?.setNoDelay?.(true); } catch { /* ignore */ }
        clearPermissionSubscription(sessionId);
        permissionSubscriptions.set(sessionId, permissionBroker.subscribe(sessionId, (pending) => {
          if (!res.writableEnded) sendSSE(res, 'permission_required', permissionPayload(pending));
        }));
        // AgentLoop reports context after it has assembled the complete model
        // envelope (system prompt, tools, durable context and history). A
        // server-side visible-text estimate would undercount this request.
        sendSSE(res, 'job', turnJob);

        // This session now owns a live turn; the model route cannot change
        // until a terminal callback clears this fence.
        runningSessionIds.add(sessionId);

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
            const job = createToolJob(sessionId, id, name, args);
            sendSSE(res, 'tool_complete', { id, name, args });
            sendSSE(res, 'job', job);
          },
          onToolExecutionStart: (id) => {
            const job = updateJob(sessionId, id, (item) => { item.status = 'running'; item.startedAt = Date.now(); });
            if (job) sendSSE(res, 'job', job);
          },
          onToolResult: (id, r) => {
            const entry = assistantToolCalls.find((tc) => tc.id === id);
            const artifacts = (r.artifacts || []).map((artifact) => {
              const artifactId = `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
              const absolute = path.resolve(artifact.path);
              artifactRegistry.set(artifactId, { path: absolute, mimeType: artifact.mimeType, size: artifact.size, created: Date.now() });
              return { ...artifact, path: absolute, url: `/api/artifacts/${artifactId}` };
            });
            if (entry) entry.result = { output: r.output, success: r.success, todos: r.todos, fileChange: r.fileChange, artifacts };
            const job = updateJob(sessionId, id, (item) => {
              item.status = r.success ? 'completed' : 'failed'; item.success = r.success; item.finishedAt = Date.now();
              item.outputPreview = String(r.output || '').replace(/\s+/g, ' ').slice(0, 320);
            });
            if (job) sendSSE(res, 'job', job);
            sendSSE(res, 'tool_result', {
              id, output: r.output, success: r.success,
              todos: r.todos,
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
            clearPermissionSubscription(sessionId);
            runningSessionIds.delete(sessionId);
            finishPendingAgentInvalidation(sessionId);
            const job = updateJobById(turnJob.id, (item) => { item.status = 'failed'; item.success = false; item.finishedAt = Date.now(); item.outputPreview = String(e || '').slice(0, 320); });
            if (job) sendSSE(res, 'job', job);
            sendSSE(res, 'error', { message: e });
            saveSessionMessages(sessionId, existingMessages, userMsg, assistantFullText, assistantToolCalls, lastUsage);
            titleJob = maybeAiTitle().finally(() => { try { res.end(); } catch { /* */ } });
          },
          onDone: (sr) => {
            clearPermissionSubscription(sessionId);
            runningSessionIds.delete(sessionId);
            finishPendingAgentInvalidation(sessionId);
            const job = updateJobById(turnJob.id, (item) => { item.status = 'completed'; item.success = true; item.finishedAt = Date.now(); item.outputPreview = assistantFullText.replace(/\s+/g, ' ').slice(0, 320) || '模型已完成回复'; });
            if (job) sendSSE(res, 'job', job);
            saveSessionMessages(sessionId, existingMessages, userMsg, assistantFullText, assistantToolCalls, lastUsage);
            // Unlock UI first (iOS generates title async in background Task)
            sendSSE(res, 'done', { stopReason: sr });
            titleJob = maybeAiTitle().finally(() => {
              try { res.end(); } catch { /* */ }
            });
          },
          onCancelled: () => {
            clearPermissionSubscription(sessionId);
            runningSessionIds.delete(sessionId);
            finishPendingAgentInvalidation(sessionId);
            const job = updateJobById(turnJob.id, (item) => { item.status = 'cancelled'; item.finishedAt = Date.now(); });
            if (job) sendSSE(res, 'job', job);
            cancelLiveJobs(sessionId);
            sendSSE(res, 'cancelled', {});
            res.end();
            saveSessionMessages(sessionId, existingMessages, userMsg, assistantFullText, assistantToolCalls, lastUsage);
          },
        };
        await agent.run({ message, tools, callbacks: cb, attachments: agentAttachments });
        clearPermissionSubscription(sessionId);
        if (titleJob) await titleJob;
      } catch (err: unknown) {
        clearPermissionSubscription(requestSessionId);
        if (!res.headersSent) jsonReply(res, 500, { error: (err as Error).message });
      }
      return;
    }

    // =====================================================================
    // Fetch models from a custom OpenAI-compatible endpoint
    // =====================================================================
    if (url.pathname === '/api/profiles/fetch-models' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { baseURL, apiKey, profileId } = JSON.parse(body);
        const existingProfile = typeof profileId === 'string'
          ? loadSettings().profiles.find((profile) => profile.id === profileId)
          : undefined;
        const effectiveApiKey = typeof apiKey === 'string' && apiKey.trim()
          ? apiKey.trim()
          : existingProfile?.apiKey;
        if (!baseURL || !effectiveApiKey) {
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
          headers: { 'Authorization': `Bearer ${effectiveApiKey}`, 'Accept': 'application/json' },
          timeout: 20000,
        }, (r: http.IncomingMessage) => {
          let data = '';
          r.on('data', (c: Buffer) => data += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              // Extract id + context_window + max_completion_tokens from API response.
              const rawItems = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
              const models: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }> = [];
              for (const item of rawItems) {
                if (!item?.id) continue;
                const ctx = typeof item.context_window === 'number' && item.context_window > 0 ? item.context_window : undefined;
                const maxOut = typeof item.max_completion_tokens === 'number' && item.max_completion_tokens > 0 ? item.max_completion_tokens : undefined;
                models.push({ id: item.id, contextWindow: ctx, maxOutputTokens: maxOut });
              }
              if (models.length === 0) {
                jsonReply(res, 404, { error: '未找到可用模型。' });
                return;
              }
              jsonReply(res, 200, { models });
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
          supportsFastMode: profileSupportsFastMode(p),
        }));
        jsonReply(res, 200, {
          profiles: masked,
          activeProfileId: s.activeProfileId,
          thinkingLevel: normalizeThinkingLevel(s.thinkingLevel),
          contextCompactionLimit: normalizeContextCompactionLimit(s.contextCompactionLimit) ?? null,
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const profile: ModelProfile = JSON.parse(body);
          if (!profile.id) profile.id = 'p_' + Date.now();
          if (!profile.name) profile.name = profile.model || '未命名';
          if (profile.contextWindow != null) {
            const cw = Number(profile.contextWindow);
            profile.contextWindow = Number.isFinite(cw) && cw > 0 ? Math.floor(cw) : undefined;
          }
          if (profile.maxOutputTokens != null) {
            const mo = Number(profile.maxOutputTokens);
            profile.maxOutputTokens = Number.isFinite(mo) && mo > 0 ? Math.floor(mo) : undefined;
          }
          profile.fastModeSupported = profile.fastModeSupported === true;
          profile.apiMode = profile.apiMode === 'responses' ? 'responses' : 'chat_completions';
          const s = loadSettings();
          const idx = s.profiles.findIndex(p => p.id === profile.id);
          if (idx >= 0) {
            // Editing a profile never requires exposing or resubmitting its saved key.
            if (!profile.apiKey?.trim()) profile.apiKey = s.profiles[idx].apiKey;
            s.profiles[idx] = profile;
          }
          else s.profiles.push(profile);
          if (!s.activeProfileId) s.activeProfileId = profile.id;
          saveSettings(s);
          // A profile owns the request envelope (Chat vs Responses) and Fast
          // capability. Drop only idle agents bound to it so their next turn
          // reconstructs the provider from the newly persisted contract.
          const sessions = loadSessionStore().sessions;
          for (const session of sessions) {
            if (session.modelBinding?.profileId === profile.id && !runningSessionIds.has(session.id)) {
              agentCache.delete(session.id);
            }
          }
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
            invalidateAllAgentsForNextTurn();
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
      if (s.visionProfileId === id) s.visionProfileId = undefined;
      saveSettings(s);
      jsonReply(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/vision-profile') {
      if (req.method === 'GET') {
        const settings = loadSettings();
        jsonReply(res, 200, { visionProfileId: settings.visionProfileId || '', profiles: settings.profiles.map((profile) => ({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, eligible: profileLikelySupportsVision(profile) })) });
        return;
      }
      if (req.method === 'PUT') {
        try {
          const body = JSON.parse(await readBody(req) || '{}');
          const id = String(body.visionProfileId || '');
          const settings = loadSettings();
          if (id && !settings.profiles.some((profile) => profile.id === id)) throw new Error('请选择已配置的模型。');
          settings.visionProfileId = id || undefined;
          saveSettings(settings);
          invalidateAllAgentsForNextTurn();
          jsonReply(res, 200, { ok: true, visionProfileId: settings.visionProfileId || '' });
        } catch (error) { jsonReply(res, 400, { error: (error as Error).message }); }
        return;
      }
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
          invalidateAllAgentsForNextTurn();
          jsonReply(res, 200, { ok: true, thinkingLevel: level });
        } catch {
          jsonReply(res, 400, { error: '无效的 JSON' });
        }
        return;
      }
    }

    // =====================================================================
    // Context compaction ceiling (auto / 128K / 256K / 384K / 768K / 1M)
    // =====================================================================
    if (url.pathname === '/api/context-compaction') {
      if (req.method === 'GET') {
        jsonReply(res, 200, { contextCompactionLimit: getContextCompactionLimit() ?? null });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        try {
          const parsed = JSON.parse(body);
          const limit = saveContextCompactionLimit(parsed.contextCompactionLimit ?? parsed.limit);
          jsonReply(res, 200, { ok: true, contextCompactionLimit: limit ?? null });
        } catch {
          jsonReply(res, 400, { error: '无效的 JSON' });
        }
        return;
      }
    }

    // =====================================================================
    // SOUL.md — persistent assistant identity and personality
    // =====================================================================
    if (url.pathname === '/api/soul') {
      if (req.method === 'GET') {
        const soul = soulStore.ensureExists();
        const limit = checkSoulBodyLimit(soul.body);
        jsonReply(res, 200, {
          metadata: soul.metadata,
          body: soul.body,
          tokenCount: limit.count,
          tokenLimit: limit.limit,
          path: soulStore.filePath,
        });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
          const metadataInput = body.metadata && typeof body.metadata === 'object'
            ? body.metadata as Record<string, unknown>
            : body;
          const current = soulStore.load();
          const metadata = normalizeSoulMetadata({
            name: typeof metadataInput.name === 'string' ? metadataInput.name : current.metadata.name,
            style: typeof metadataInput.style === 'string' ? metadataInput.style : current.metadata.style,
            lang: typeof metadataInput.lang === 'string' ? metadataInput.lang : current.metadata.lang,
          });
          const soul = soulStore.save({ metadata, body: typeof body.body === 'string' ? body.body : current.body });
          const limit = checkSoulBodyLimit(soul.body);
          // Cached agents retain their prompt envelope. Rebuild before the
          // next turn so a saved identity takes effect globally at once.
          invalidateAllAgentsForNextTurn();
          jsonReply(res, 200, { ok: true, metadata: soul.metadata, body: soul.body, tokenCount: limit.count, tokenLimit: limit.limit, path: soulStore.filePath });
        } catch (error) {
          jsonReply(res, 400, { error: (error as Error).message || '灵魂配置保存失败。' });
        }
        return;
      }
    }

    if (url.pathname === '/api/soul/restore' && (req.method === 'POST' || req.method === 'PUT')) {
      try {
        const soul = soulStore.restoreDefault();
        invalidateAllAgentsForNextTurn();
        jsonReply(res, 200, { ok: true, metadata: soul.metadata, body: soul.body, tokenCount: 0, tokenLimit: checkSoulBodyLimit(soul.body).limit, path: soulStore.filePath });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message || '恢复默认灵魂失败。' });
      }
      return;
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
        invalidateAllAgentsForNextTurn();
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
          if (typeof data.systemPrompt === 'boolean') {
            skillStore.setSystemPrompt(id, data.systemPrompt);
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
        invalidateAllAgentsForNextTurn();
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
          invalidateAllAgentsForNextTurn();
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
    // Persistent terminal sessions for the project workbench
    // =====================================================================
    if (url.pathname === '/api/terminal/sessions' && req.method === 'GET') {
      jsonReply(res, 200, { sessions: terminalManager.list() });
      return;
    }

    if (url.pathname === '/api/terminal/sessions' && req.method === 'POST') {
      const projectRoot = getProjectRoot() || WORKSPACE_DIR;
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        jsonReply(res, 201, { session: terminalManager.create(projectRoot, body.shell) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (url.pathname.startsWith('/api/terminal/sessions/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[3] || '';
      const action = parts[4] || '';
      try {
        if (!id) throw new Error('终端会话 ID 无效。');
        if (!action && req.method === 'GET') {
          const after = Number(url.searchParams.get('after') || '0');
          jsonReply(res, 200, terminalManager.output(id, after));
          return;
        }
        if ((action === 'input' || action === 'execute') && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          terminalManager.write(id, action === 'input' ? String(body.input || '') : String(body.command || ''), action === 'execute');
          jsonReply(res, 200, { ok: true });
          return;
        }
        if (action === 'resize' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          terminalManager.resize(id, Number(body.cols), Number(body.rows));
          jsonReply(res, 200, { ok: true });
          return;
        }
        if (action === 'terminate' && req.method === 'POST') {
          terminalManager.terminate(id);
          jsonReply(res, 200, { ok: true });
          return;
        }
        jsonReply(res, 404, { error: '终端接口不存在' });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    // =====================================================================
    // MCP server catalog and desktop-side tool calls
    // =====================================================================
    if (url.pathname === '/api/mcp/servers' && req.method === 'GET') {
      jsonReply(res, 200, { servers: mcpManager.list() });
      return;
    }

    if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        jsonReply(res, 201, { server: mcpManager.add({
          name: String(body.name || ''), transport: body.transport === 'http' ? 'http' : 'stdio', command: body.command,
          args: Array.isArray(body.args) ? body.args : [], url: body.url, enabled: body.enabled !== false,
        }) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (url.pathname.startsWith('/api/mcp/servers/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[3] || '';
      const action = parts[4] || '';
      try {
        if (!id) throw new Error('MCP Server ID 无效。');
        if (!action && req.method === 'DELETE') { mcpManager.remove(id); jsonReply(res, 200, { ok: true }); return; }
        if (action === 'connect' && req.method === 'POST') { jsonReply(res, 200, { server: await mcpManager.connect(id) }); return; }
        if (action === 'disconnect' && req.method === 'POST') { jsonReply(res, 200, { server: mcpManager.disconnect(id) }); return; }
        if (action === 'call' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const result = await mcpManager.callTool(id, String(body.name || ''), body.arguments && typeof body.arguments === 'object' ? body.arguments : {});
          jsonReply(res, 200, { result }); return;
        }
        if (action === 'resource' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const result = await mcpManager.readResource(id, String(body.uri || ''));
          jsonReply(res, 200, { result }); return;
        }
        jsonReply(res, 404, { error: 'MCP 接口不存在' });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    // =====================================================================
    // Project workbench: structured Git status/diff plus bounded text search
    // =====================================================================
    if (url.pathname === '/api/git/status' && req.method === 'GET') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      jsonReply(res, 200, await gitService.status(projectRoot));
      return;
    }

    if (url.pathname === '/api/git/diff' && req.method === 'GET') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      try {
        const target = url.searchParams.get('path') || undefined;
        const staged = url.searchParams.get('staged') === '1';
        jsonReply(res, 200, await gitService.diff(projectRoot, target, staged));
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (url.pathname === '/api/git/branches' && req.method === 'GET') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      try {
        jsonReply(res, 200, { branches: await gitService.branches(projectRoot) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (url.pathname === '/api/git/log' && req.method === 'GET') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      try {
        jsonReply(res, 200, { entries: await gitService.log(projectRoot, Number(url.searchParams.get('limit') || 12)) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if ((url.pathname === '/api/git/stage' || url.pathname === '/api/git/unstage' || url.pathname === '/api/git/restore') && req.method === 'POST') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const paths = Array.isArray(body.paths) ? body.paths.filter((value: unknown): value is string => typeof value === 'string') : [];
        if (url.pathname.endsWith('/stage')) await gitService.stage(projectRoot, paths);
        else if (url.pathname.endsWith('/unstage')) await gitService.unstage(projectRoot, paths);
        else await gitService.restore(projectRoot, paths);
        jsonReply(res, 200, await gitService.status(projectRoot));
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (['/api/git/stage-all', '/api/git/switch', '/api/git/create-branch', '/api/git/commit', '/api/git/pull', '/api/git/push'].includes(url.pathname) && req.method === 'POST') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        if (url.pathname.endsWith('/stage-all')) await gitService.stageAll(projectRoot);
        if (url.pathname.endsWith('/switch')) await gitService.switchBranch(projectRoot, String(body.branch || ''));
        if (url.pathname.endsWith('/create-branch')) await gitService.createBranch(projectRoot, String(body.branch || ''));
        if (url.pathname.endsWith('/commit')) await gitService.commit(projectRoot, String(body.message || ''));
        if (url.pathname.endsWith('/pull')) await gitService.pull(projectRoot);
        if (url.pathname.endsWith('/push')) await gitService.push(projectRoot);
        jsonReply(res, 200, { status: await gitService.status(projectRoot) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (url.pathname === '/api/fs/search' && req.method === 'GET') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) {
        jsonReply(res, 400, { error: '尚未打开项目' });
        return;
      }
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length < 2) {
        jsonReply(res, 200, { query, results: [], scanned: false });
        return;
      }
      const requestedLimit = Number(url.searchParams.get('limit') || '100');
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 100;
      jsonReply(res, 200, { query, results: searchProjectText(projectRoot, query, limit), scanned: true });
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
