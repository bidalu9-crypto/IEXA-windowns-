import * as path from 'path';
import { ProjectInstructions } from '../agent/ProjectInstructions';
import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';
import { ShellExecutor, FileTools, MemoryTools, BrowserFetch, WebSearch, buildMediaDisplayResult } from '../tools/ToolExecutors';
import { SearchTools } from '../tools/SearchTools';
import { PathSandbox, PathPolicy } from '../security/PathSandbox';
import { PermissionManager, PermissionMode } from '../security/PermissionManager';
import { BudgetManager } from './BudgetManager';
import { ToolDefinition, ToolExecutionContext, ToolRegistry, canonicalToolName } from './ToolRegistry';
import { ToolScheduler } from './ToolScheduler';
import { ToolLifecycle, ToolExecutionStatus } from './ToolLifecycle';
import { LoopDetector } from './LoopDetector';
import { ArtifactStore } from '../context/ArtifactStore';
import { CommandPolicy } from '../tools/shell/CommandPolicy';
import { DesktopAgent } from '../tools/DesktopAgent';
import { makeAgentTools } from '../tools/ToolDefinitions';
import { QuestionResolver, normalizeAskUserArgs, formatQuestionAnswers } from './QuestionBroker';
import { HookSpec, runHooks } from './HookRunner';
import { ShellSessionTools } from '../tools/ShellSessionTools';
import { GoalStore } from '../agent/GoalStore';

export interface JobSummary {
  id: string; toolId?: string; toolName?: string; title: string; status: string;
  createdAt: number; finishedAt?: number; success?: boolean; preview: string;
}
export interface JobBridge {
  list(sessionId: string, limit: number, tool?: string): JobSummary[];
  output(sessionId: string, jobId: string): { job: JobSummary; output: string; recorded: boolean } | null;
}

export interface ToolRuntimeConfig { workspaceDir: string; memoryDir: string; memoryEnabled?: boolean; auditDir?: string; permissionResolver?: ConstructorParameters<typeof PermissionManager>[1]; permissionMode?: PermissionMode; budget?: BudgetManager; desktopCaptureFrames?: boolean; pathMode?: 'workspace' | 'selected-roots'; selectedRoots?: readonly string[]; questionResolver?: QuestionResolver; hooks?: () => HookSpec[]; shellSessions?: ShellSessionTools; jobBridge?: JobBridge; goalStore?: GoalStore; }
const risk: Record<string, ToolDefinition['risk']> = { project_instructions: 'low', todo_write: 'low', ask_user: 'low', shell_execute: 'high', shell_session: 'high', job_list: 'low', job_output: 'low', goal: 'low', file_read: 'low', file_write: 'medium', file_edit: 'medium', grep: 'low', glob: 'low', browser_fetch: 'low', web_search: 'low', display_file: 'medium', memory_write: 'medium', memory_get: 'low' };

export class ToolRuntime {
  readonly registry = new ToolRegistry();
  private readonly scheduler = new ToolScheduler();
  private readonly sandbox = new PathSandbox();
  private readonly permissions: PermissionManager;
  private readonly budget: BudgetManager;
  private readonly shell: ShellExecutor;
  private readonly files = new FileTools(() => this.pathPolicy());
  private permissionMode: PermissionMode;
  private readonly memory: MemoryTools;
  private readonly browser = new BrowserFetch();
  private readonly webSearch = new WebSearch();
  private readonly search = new SearchTools();
  private readonly desktop: DesktopAgent;
  private readonly loopDetector = new LoopDetector();
  private readonly commandPolicy = new CommandPolicy();
  private readonly artifacts: ArtifactStore;
  private allowedTools: Set<string> | null = null;
  private lifecycle = new ToolLifecycle();
  private activeExecutions = 0;
  private readonly executions = new Map<string, { fingerprint: string; result: Promise<ToolExecutionResult> }>();

  constructor(private readonly config: ToolRuntimeConfig) {
    this.permissionMode = config.permissionMode || 'risk';
    this.permissions = new PermissionManager(config.auditDir || path.join(config.workspaceDir, '.iexa-audit'), config.permissionResolver, config.permissionMode || 'risk');
    this.budget = config.budget || new BudgetManager();
    this.shell = new ShellExecutor(config.workspaceDir);
    this.memory = new MemoryTools(config.memoryDir);
    this.desktop = new DesktopAgent(path.resolve(config.workspaceDir, '..'), config.desktopCaptureFrames === true, path.join(config.auditDir || path.join(config.workspaceDir, '.iexa-audit'), 'desktop'));
    this.artifacts = new ArtifactStore(path.join(config.workspaceDir, '.iexa-artifacts'));
  }
  async initialize(): Promise<void> { await this.memory.initialize(); }
  grantPermission(sessionId: string, toolName: string): void { this.permissions.grant(sessionId, toolName); }
  setPermissionMode(mode: PermissionMode): void { this.permissionMode = mode; this.permissions.setMode(mode); }
  private pathPolicy(): Omit<PathPolicy, 'workspaceDir'> { return { permissionMode: this.permissionMode, mode: this.config.pathMode || 'workspace', roots: this.config.selectedRoots }; }
  isParallelSafe(name: string): boolean { return this.registry.get(name)?.parallelSafe === true; }
  definitions(): AgentToolDefinition[] { return this.registry.list().map(({ execute: _execute, risk: _risk, parallelSafe: _parallelSafe, cancellable: _cancellable, requiresApproval: _approval, timeoutMs: _timeout, filesystemAccess: _fs, networkAccess: _net, ...definition }) => definition); }
  async execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    // Alias resolution happens before validation and fingerprinting so `edit`
    // and `file_edit` share permissions, dedupe and execution semantics.
    name = canonicalToolName(name);
    // Validate before fingerprinting/caching so malformed optional values cannot
    // collapse to the same JSON fingerprint as an omitted, valid argument.
    let repairs: string[] = [];
    try { repairs = this.registry.validate(name, args); }
    catch (error) { return { output: (error as Error).message || 'Invalid tool arguments.', success: false, executionStatus: 'failed' }; }
    // Retransmission of the same call ID must not execute a write/command twice.
    // Clone separately from the canonical fingerprint: JSON round-tripping used to
    // silently turn NaN/Infinity into null before schema validation.
    let snapshot: Record<string, unknown>;
    let fingerprint: string;
    try {
      snapshot = structuredClone(args);
      fingerprint = JSON.stringify([name, snapshot], (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Tool arguments must contain only finite numbers.');
        return value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
      });
    } catch (error) {
      return { output: `Invalid tool arguments: ${(error as Error).message}`, success: false, executionStatus: 'failed' };
    }
    const key = JSON.stringify([context.sessionId, context.toolCallId]);
    const existing = this.executions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { output: 'Tool call ID was reused with different arguments. No second execution was performed.', success: false, executionStatus: 'failed' };
      return existing.result;
    }
    if (this.executions.size >= 4096) return { output: 'Tool execution ledger limit reached.', success: false, executionStatus: 'failed' };
    this.activeExecutions++;
    const result = Promise.resolve()
      .then(() => this.executeOnce(name, snapshot, context))
      // Say what changed: a clamped value is still a request the caller should
      // understand, and the note rides along with the cached result.
      .then((value) => (repairs.length
        ? { ...value, output: `${value.output}\n\n[arguments adjusted: ${repairs.join('; ')}]` }
        : value))
      .finally(() => { this.activeExecutions--; });
    this.executions.set(key, { fingerprint, result });
    return result;
  }
  private async executeOnce(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let current: ToolExecutionStatus | undefined;
    const emit = (status: ToolExecutionStatus) => {
      if (status === current) return;
      const event = this.lifecycle.transition(context.sessionId, context.toolCallId, name, status);
      current = status;
      try { context.onToolState?.(event); } catch { /* Observers cannot change tool execution. */ }
      return event;
    };
    emit('queued');
    const onCancellation = () => { if (current === 'queued' || current === 'awaiting_approval' || current === 'running') emit('cancelling'); };
    context.signal.addEventListener('abort', onCancellation, { once: true });
    let result: ToolExecutionResult;
    try {
      if (context.signal.aborted) throw new Error('Tool cancelled before execution.');
      if (this.allowedTools && !this.allowedTools.has(name)) throw new Error(`Tool ${name} is not available for this client permission level.`);
      this.loopDetector.record(name, args);
      const tool = this.registry.get(name)!;
      const authorizedTool: ToolDefinition = name === 'shell_execute'
        ? { ...tool, risk: this.commandPolicy.classify(String(args.command || '')) as ToolDefinition['risk'], requiresApproval: true }
        : name === 'shell_session'
          ? ['read', 'list', 'close'].includes(String(args.action || ''))
            ? { ...tool, risk: 'low', requiresApproval: false }
            : { ...tool, risk: this.commandPolicy.classify(String(args.command || '')) as ToolDefinition['risk'], requiresApproval: true }
        : name === 'desktop_control' && !['list_windows','observe','frame','session_state','find_element','read_focused','wait','wait_change'].includes(String(args.action || 'observe'))
          ? { ...tool, requiresApproval: true }
          : tool;
      const permissions = name === 'shell_execute'
        ? new PermissionManager(this.config.auditDir || path.join(this.config.workspaceDir, '.iexa-audit'), this.config.permissionResolver, this.permissionMode)
        : this.permissions;
      await permissions.authorize({ sessionId: context.sessionId, tool: authorizedTool, args, signal: context.signal, toolCallId: context.toolCallId, runId: this.lifecycle.runId,
        onAwaitingApproval: () => emit('awaiting_approval') });
      if (context.signal.aborted) throw new Error('Tool cancelled after approval.');
      this.budget.recordTool();
      const hookSpecs = this.config.hooks?.() || [];
      let blockedByHook: ToolExecutionResult | undefined;
      if (hookSpecs.length) {
        const pre = await runHooks(hookSpecs, { phase: 'preToolUse', tool: name, args, sessionId: context.sessionId }, this.config.workspaceDir, context.signal);
        if (pre.block) blockedByHook = { output: `Hook 阻止了 ${name}：${pre.reason || '未说明原因'}`, success: false, executionStatus: 'denied' };
      }
      if (!blockedByHook) emit('running');
      result = blockedByHook || await this.scheduler.execute(tool, args, { ...context, onCancellation });
      if (hookSpecs.length && !blockedByHook) {
        try {
          await runHooks(hookSpecs, {
            phase: 'postToolUse', tool: name, args, sessionId: context.sessionId,
            result: { success: result.success, output: result.output, executionStatus: result.executionStatus },
          }, this.config.workspaceDir, context.signal);
        } catch { /* a hook failure never changes a completed tool result */ }
      }
    } catch (error) {
      result = { output: (error as Error).message || 'Tool execution failed.', success: false,
        executionStatus: (error as { code?: string }).code === 'PERMISSION_DENIED' ? 'denied' : 'failed' };
    } finally { context.signal.removeEventListener('abort', onCancellation); }
    if (result.timedOut) result = { ...result, success: false, executionStatus: 'timed_out' };
    else if (context.signal.aborted || result.cancelled) result = { ...result, success: false, cancelled: true, executionStatus: 'cancelled' };
    else result.executionStatus = result.success ? 'completed' : result.executionStatus === 'denied' ? 'denied' : 'failed';
    // An optional output attachment failing does not undo an already successful command.
    if (result.output.length > 24_000) {
      try {
        const artifact = await this.artifacts.put(result.output);
        result.artifacts = [...(result.artifacts || []), { kind: 'file', path: artifact.path, mimeType: 'text/plain', size: artifact.size }];
      } catch (error) { result.metadata = { ...result.metadata, artifactError: (error as Error).message }; }
    }
    const terminal = emit(result.executionStatus!);
    result.durationMs ??= terminal?.durationMs ?? 0;
    return result;
  }
  getToolExecutions() { return this.lifecycle.snapshot(); }
  getBudget(): ReturnType<BudgetManager['snapshot']> { return this.budget.snapshot(); }
  /** ask_user: render an interactive card and resolve once the user answers (or the wait ends). */
  private async askUser(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!this.config.questionResolver) return { output: 'ask_user 不可用：当前客户端没有交互界面，无法展示提问卡片。请直接改用普通文本向用户提问。', success: false };
    let normalized;
    try { normalized = normalizeAskUserArgs(args); }
    catch (error) { return { output: (error as Error).message || 'ask_user 参数无效。', success: false }; }
    const answers = await this.config.questionResolver({
      sessionId: context.sessionId, toolCallId: context.toolCallId, runId: this.lifecycle.runId,
      title: normalized.title, questions: normalized.questions, signal: context.signal,
    });
    if (answers === null) return { output: '提问未完成：用户关闭了提问卡片或本轮已取消，没有收到回答。不要重复发起同一提问；如果仍需要答案，请简要说明原因，或改用普通文本询问。', success: false };
    return { output: formatQuestionAnswers(normalized.title, normalized.questions, answers), success: true, summary: '用户已回答提问' };
  }
  beginRun(allowedTools?: Iterable<string>): void {
    if (this.activeExecutions) throw new Error('Previous tool executions are still settling; wait before starting another run.');
    this.executions.clear(); this.desktop.resetControl(); this.lifecycle = new ToolLifecycle();
    this.allowedTools = allowedTools ? new Set(allowedTools) : null;
    this.budget.reset(); this.loopDetector.reset();
  }
  beginTurn(): void { this.budget.beginTurn(); }
  recordInputTokens(tokens: number): void { this.budget.recordInputTokens(tokens); }
  registerDynamicTool(definition: AgentToolDefinition, execute: ToolDefinition['execute'], options: Partial<ToolDefinition> = {}): void {
    if (this.registry.has(definition.name)) return;
    this.registry.register({ ...definition, risk: 'medium', parallelSafe: false, cancellable: true, requiresApproval: true, ...options, execute });
  }

  registerDefaults(onSkillRead?: (p: string) => void, onSkillWrite?: (p: string) => void): void {
    const add = (definition: AgentToolDefinition, execute: ToolDefinition['execute'], options: Partial<ToolDefinition> = {}) => this.registry.register({ ...definition, risk: options.risk || risk[definition.name] || 'medium', parallelSafe: options.parallelSafe ?? false, cancellable: options.cancellable ?? false, requiresApproval: options.requiresApproval ?? ((options.risk || risk[definition.name]) === 'high'), ...options, execute });
    const todo = (args: Record<string, unknown>): ToolExecutionResult => {
      const raw = Array.isArray(args.todos) ? args.todos : null; if (!raw || raw.length < 1 || raw.length > 24) return { output: 'Error: todos must contain between 1 and 24 items.', success: false };
      const seen = new Set<string>(); let inProgress = 0; const todos: NonNullable<ToolExecutionResult['todos']> = [];
      for (const item of raw) { if (!item || typeof item !== 'object') return { output: 'Error: every todo must be an object.', success: false }; const content = String((item as Record<string, unknown>).content || '').trim(); const status = String((item as Record<string, unknown>).status || ''); if (!content || content.length > 240 || !['pending', 'in_progress', 'completed'].includes(status)) return { output: 'Error: invalid todo item.', success: false }; if (seen.has(content.toLowerCase())) return { output: 'Error: duplicate todo content.', success: false }; seen.add(content.toLowerCase()); if (status === 'in_progress') inProgress++; todos.push({ content, status: status as NonNullable<ToolExecutionResult['todos']>[number]['status'] }); }
      if (inProgress > 1) return { output: 'Error: at most one todo may be in_progress.', success: false }; const completed = todos.filter((t) => t.status === 'completed').length; const active = todos.filter((t) => t.status === 'in_progress').length; return { output: `Todo plan updated: ${todos.length - completed - active} pending, ${active} in progress, ${completed} completed.`, success: true, todos };
    };
    const surface = { shellSession: !!this.config.shellSessions, jobs: !!this.config.jobBridge, goal: !!this.config.goalStore };
    for (const definition of makeAgentTools(this.config.memoryEnabled !== false, surface)) {
      add(definition, async (args, context) => {
        if (definition.name === 'desktop_control') return this.desktop.execute(args, context.signal, {
          owner: context.sessionId, operationId: `${this.lifecycle.runId}:${context.toolCallId}`,
          onEvent: desktop => { try { context.onToolState?.(this.lifecycle.progress(context.sessionId, context.toolCallId, desktop)); } catch {} },
        });
        if (definition.name === 'todo_write') return todo(args);
        if (definition.name === 'ask_user') return this.askUser(args, context);
        if (definition.name === 'shell_execute') {
          const requestedShell = ['auto', 'cmd', 'powershell', 'pwsh'].includes(String(args.shell || 'auto'))
            ? String(args.shell || 'auto') as 'auto' | 'cmd' | 'powershell' | 'pwsh'
            : 'auto';
          return this.shell.execute(String(args.command || ''), Number(args.timeout) || 900, context.signal, requestedShell);
        }
        if (definition.name === 'project_instructions') {
          const result = await new ProjectInstructions(this.config.workspaceDir).resolve(String(args.path || '.'), args.kind === 'directory' ? 'directory' : 'file');
          return { output: ProjectInstructions.format(result), success: result.warnings.length === 0 };
        }
        if (definition.name === 'web_search') return this.webSearch.search(String(args.query || ''), Number(args.limit) || 8, Number(args.recency_days) || undefined, context.signal);
        if (definition.name === 'browser_fetch') return this.browser.fetch(String(args.url || ''), Number(args.max_length) || 25000, context.signal);
        if (definition.name === 'memory_write') return this.memory.writeMemory(String(args.content || ''));
        if (definition.name === 'memory_get') return this.memory.getMemory(String(args.keywords || ''), Number(args.limit) || 20);
        if (definition.name === 'grep') return this.search.grep(args, this.config.workspaceDir, this.pathPolicy(), context.signal);
        if (definition.name === 'glob') return this.search.glob(args, this.config.workspaceDir, this.pathPolicy(), context.signal);
        if (definition.name === 'shell_session') return this.config.shellSessions!.execute(String(args.action || 'list'), args, context.sessionId, context.signal, context.workspaceDir);
        if (definition.name === 'job_list') return this.listJobs(args, context.sessionId);
        if (definition.name === 'job_output') return this.jobOutput(args, context.sessionId);
        if (definition.name === 'goal') return this.goal(args, context.sessionId);
        const filePath = String(args.path || ''); const resolved = await this.sandbox.resolve(filePath, { ...this.pathPolicy(), workspaceDir: this.config.workspaceDir, allowMissing: definition.name === 'file_write' });
        if (definition.name === 'file_read') { const result = await this.files.readFile(resolved.path, this.config.workspaceDir, { offset: args.offset ? Number(args.offset) : undefined, lines: args.lines ? Number(args.lines) : undefined, maxLength: args.max_length ? Number(args.max_length) : undefined, direction: args.direction as 'head' | 'tail' | undefined }); if (result.success) onSkillRead?.(resolved.path); return result; }
        if (definition.name === 'file_write') { const result = await this.files.writeFile(resolved.path, String(args.content || ''), this.config.workspaceDir, { append: args.append === true, createDirs: args.create_dirs === true }); if (result.success) onSkillWrite?.(resolved.path); return result; }
        if (definition.name === 'file_edit') { const result = await this.files.editFile(resolved.path, String(args.old_string || ''), String(args.new_string || ''), this.config.workspaceDir, args.replace_all === true); if (result.success) onSkillWrite?.(resolved.path); return result; }
        return buildMediaDisplayResult(resolved.path, this.config.workspaceDir, this.pathPolicy());
      }, { risk: definition.name === 'desktop_control' ? 'medium' : risk[definition.name], parallelSafe: definition.name === 'project_instructions' || definition.name === 'file_read' || definition.name === 'memory_get' || definition.name === 'browser_fetch' || definition.name === 'web_search' || definition.name === 'grep' || definition.name === 'glob' || definition.name === 'job_list' || definition.name === 'job_output', cancellable: definition.name === 'browser_fetch' || definition.name === 'web_search' || definition.name === 'shell_execute' || definition.name === 'shell_session' || definition.name === 'desktop_control' || definition.name === 'ask_user' || definition.name === 'grep' || definition.name === 'glob', requiresApproval: definition.name === 'desktop_control' ? false : risk[definition.name] === 'high' });
    }
  }

  private listJobs(args: Record<string, unknown>, sessionId: string): ToolExecutionResult {
    const bridge = this.config.jobBridge!;
    const limit = Math.min(Math.max(1, Number(args.limit) || 12), 50);
    const jobs = bridge.list(sessionId, limit, String(args.tool || '').trim() || undefined);
    if (!jobs.length) return { output: '(本对话还没有任务记录)', success: true };
    const rows = jobs.map(job => {
      const duration = job.finishedAt && job.createdAt ? ((job.finishedAt - job.createdAt) / 1000).toFixed(1) + 's' : '—';
      const callId = job.toolId && job.toolId !== job.id ? ` · ${job.toolId}` : '';
      return `- ${job.id}${callId} · ${job.toolName || job.title} · ${job.status} · ${duration} · ${job.preview || '(无预览)'}`;
    });
    return { output: rows.join('\n'), success: true };
  }

  private jobOutput(args: Record<string, unknown>, sessionId: string): ToolExecutionResult {
    const jobId = String(args.job_id || '').trim();
    if (!jobId) return { output: 'job_id 不能为空；先用 job_list 查任务 id。', success: false };
    const found = this.config.jobBridge!.output(sessionId, jobId);
    if (!found) return { output: `没有找到任务 ${jobId}（只支持本对话的任务）。先用 job_list 确认 id。`, success: false };
    if (!found.recorded) {
      return {
        output: `任务 ${found.job.id}（${found.job.toolName || found.job.title}，${found.job.status}）的完整输出未被保留（应用重启或缓存已淘汰）。\n可用预览：\n${found.job.preview || '(无)'}`,
        success: false,
      };
    }
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const maxLength = Math.min(Math.max(1, Math.floor(Number(args.max_length) || 20_000)), 120_000);
    const slice = found.output.slice(offset, offset + maxLength);
    const remaining = found.output.length - (offset + slice.length);
    const trailer = remaining > 0 ? `\n\n[... 还有 ${remaining} 字符；用 offset=${offset + slice.length} 继续读取 ...]` : '';
    return { output: `${slice || '(空输出)'}${trailer}`, success: true };
  }

  private goal(args: Record<string, unknown>, sessionId: string): ToolExecutionResult {
    const store = this.config.goalStore!;
    const action = String(args.action || 'get');
    if (action === 'get') {
      const record = store.get(sessionId);
      return { output: record ? store.format(record) : '(当前对话没有设置目标)', success: true };
    }
    if (action === 'set') {
      const objective = String(args.objective || '').trim();
      if (!objective) return { output: 'action=set 需要 objective。', success: false };
      const record = store.set(sessionId, objective, String(args.done_when || ''));
      return { output: `目标已记录（每轮自动注入，压缩后仍保留）：\n${store.format(record)}`, success: true };
    }
    if (action === 'update') {
      const status = String(args.status || '');
      if (status && !['active', 'done', 'blocked'].includes(status)) return { output: 'status 只能是 active / done / blocked。', success: false };
      if (!store.get(sessionId)) return { output: '还没有目标，先用 action=set 建立。', success: false };
      const record = store.update(sessionId, {
        ...(status ? { status: status as 'active' | 'done' | 'blocked' } : {}),
        ...(args.note ? { note: String(args.note) } : {}),
        ...(args.done_when !== undefined ? { doneWhen: String(args.done_when) } : {}),
      });
      return { output: `目标已更新：\n${store.format(record!)}`, success: true };
    }
    if (action === 'clear') {
      return { output: store.clear(sessionId) ? '目标已清除。' : '(当前对话没有设置目标)', success: true };
    }
    return { output: `未知 action: ${action}。可用 set / update / get / clear。`, success: false };
  }
}
