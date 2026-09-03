import * as path from 'path';
import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';
import { ShellExecutor, FileTools, MemoryTools, BrowserFetch, buildMediaDisplayResult } from '../tools/ToolExecutors';
import { PathSandbox } from '../security/PathSandbox';
import { NetworkPolicy } from '../security/NetworkPolicy';
import { PermissionManager, PermissionMode } from '../security/PermissionManager';
import { BudgetManager } from './BudgetManager';
import { ToolDefinition, ToolExecutionContext, ToolRegistry } from './ToolRegistry';
import { ToolScheduler } from './ToolScheduler';
import { LoopDetector } from './LoopDetector';
import { ArtifactStore } from '../context/ArtifactStore';
import { CommandPolicy } from '../tools/shell/CommandPolicy';
import { makeAgentTools } from '../tools/ToolDefinitions';

export interface ToolRuntimeConfig { workspaceDir: string; memoryDir: string; memoryEnabled?: boolean; auditDir?: string; permissionResolver?: ConstructorParameters<typeof PermissionManager>[1]; permissionMode?: PermissionMode; budget?: BudgetManager; }
const risk: Record<string, ToolDefinition['risk']> = { todo_write: 'low', shell_execute: 'high', file_read: 'low', file_write: 'medium', file_edit: 'medium', browser_fetch: 'low', display_file: 'medium', memory_write: 'medium', memory_get: 'low' };

export class ToolRuntime {
  readonly registry = new ToolRegistry();
  private readonly scheduler = new ToolScheduler();
  private readonly sandbox = new PathSandbox();
  private readonly network = new NetworkPolicy();
  private readonly permissions: PermissionManager;
  private readonly budget: BudgetManager;
  private readonly shell: ShellExecutor;
  private readonly files = new FileTools();
  private readonly memory: MemoryTools;
  private readonly browser = new BrowserFetch();
  private readonly loopDetector = new LoopDetector();
  private readonly commandPolicy = new CommandPolicy();
  private readonly artifacts: ArtifactStore;

  constructor(private readonly config: ToolRuntimeConfig) {
    this.permissions = new PermissionManager(config.auditDir || path.join(config.workspaceDir, '.iexa-audit'), config.permissionResolver, config.permissionMode || 'risk');
    this.budget = config.budget || new BudgetManager();
    this.shell = new ShellExecutor(config.workspaceDir);
    this.memory = new MemoryTools(config.memoryDir);
    this.artifacts = new ArtifactStore(path.join(config.workspaceDir, '.iexa-artifacts'));
  }
  async initialize(): Promise<void> { await this.memory.initialize(); }
  grantPermission(sessionId: string, toolName: string): void { this.permissions.grant(sessionId, toolName); }
  setPermissionMode(mode: PermissionMode): void { this.permissions.setMode(mode); }
  isParallelSafe(name: string): boolean { return this.registry.get(name)?.parallelSafe === true; }
  definitions(): AgentToolDefinition[] { return this.registry.list().map(({ execute: _execute, risk: _risk, parallelSafe: _parallelSafe, cancellable: _cancellable, requiresApproval: _approval, timeoutMs: _timeout, filesystemAccess: _fs, networkAccess: _net, ...definition }) => definition); }
  async execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.registry.validate(name, args); this.loopDetector.record(name, args); const tool = this.registry.get(name)!;
    // Ordinary workspace commands (pwd, git status, tests, file listing, ...)
    // remain usable without a modal approval. System-level commands retain the
    // high-risk permission gate declared by CommandPolicy.
    const authorizedTool = name === 'shell_execute'
      ? { ...tool, risk: this.commandPolicy.classify(String(args.command || '')), requiresApproval: this.commandPolicy.classify(String(args.command || '')) === 'high' }
      : tool;
    await this.permissions.authorize({ sessionId: context.sessionId, tool: authorizedTool, args }); this.budget.recordTool();
    let result: ToolExecutionResult;
    try {
      result = await this.scheduler.execute(tool, args, context);
    } catch (error: unknown) {
      return { output: (error as Error).message || 'Tool execution failed.', success: false };
    }
    // The agent loop compacts its own model-facing copy. Keep the execution
    // result intact for the live UI, session history, scrolling and copying.
    // A downloadable artifact remains useful for external editors, but it no
    // longer replaces most of the visible result with an 8,000-char preview.
    if (result.output.length > 24_000) {
      const artifact = await this.artifacts.put(result.output);
      return {
        ...result,
        artifacts: [...(result.artifacts || []), { kind: 'file', path: artifact.path, mimeType: 'text/plain', size: artifact.size }],
      };
    }
    return result;
  }
  getBudget(): ReturnType<BudgetManager['snapshot']> { return this.budget.snapshot(); }
  beginRun(): void { this.budget.reset(); this.loopDetector.reset(); }
  beginTurn(): void { this.budget.beginTurn(); }
  recordInputTokens(tokens: number): void { this.budget.recordInputTokens(tokens); }
  registerDynamicTool(definition: AgentToolDefinition, execute: ToolDefinition['execute']): void {
    if (this.registry.has(definition.name)) return;
    this.registry.register({ ...definition, risk: 'medium', parallelSafe: false, cancellable: true, requiresApproval: true, execute });
  }

  registerDefaults(onSkillRead?: (p: string) => void, onSkillWrite?: (p: string) => void): void {
    const add = (definition: AgentToolDefinition, execute: ToolDefinition['execute'], options: Partial<ToolDefinition> = {}) => this.registry.register({ ...definition, risk: options.risk || risk[definition.name] || 'medium', parallelSafe: options.parallelSafe ?? false, cancellable: options.cancellable ?? false, requiresApproval: options.requiresApproval ?? ((options.risk || risk[definition.name]) === 'high'), ...options, execute });
    const todo = (args: Record<string, unknown>): ToolExecutionResult => {
      const raw = Array.isArray(args.todos) ? args.todos : null; if (!raw || raw.length < 1 || raw.length > 24) return { output: 'Error: todos must contain between 1 and 24 items.', success: false };
      const seen = new Set<string>(); let inProgress = 0; const todos: NonNullable<ToolExecutionResult['todos']> = [];
      for (const item of raw) { if (!item || typeof item !== 'object') return { output: 'Error: every todo must be an object.', success: false }; const content = String((item as Record<string, unknown>).content || '').trim(); const status = String((item as Record<string, unknown>).status || ''); if (!content || content.length > 240 || !['pending', 'in_progress', 'completed'].includes(status)) return { output: 'Error: invalid todo item.', success: false }; if (seen.has(content.toLowerCase())) return { output: 'Error: duplicate todo content.', success: false }; seen.add(content.toLowerCase()); if (status === 'in_progress') inProgress++; todos.push({ content, status: status as NonNullable<ToolExecutionResult['todos']>[number]['status'] }); }
      if (inProgress > 1) return { output: 'Error: at most one todo may be in_progress.', success: false }; const completed = todos.filter((t) => t.status === 'completed').length; const active = todos.filter((t) => t.status === 'in_progress').length; return { output: `Todo plan updated: ${todos.length - completed - active} pending, ${active} in progress, ${completed} completed.`, success: true, todos };
    };
    for (const definition of makeAgentTools(this.config.memoryEnabled !== false)) {
      add(definition, async (args, context) => {
        if (definition.name === 'todo_write') return todo(args);
        if (definition.name === 'shell_execute') return this.shell.execute(String(args.command || ''), Number(args.timeout) || 900, context.signal);
        if (definition.name === 'browser_fetch') { const url = await this.network.assertAllowed(String(args.url || '')); return this.browser.fetch(url.toString(), Number(args.max_length) || 25000, context.signal); }
        if (definition.name === 'memory_write') return this.memory.writeMemory(String(args.content || ''));
        if (definition.name === 'memory_get') return this.memory.getMemory(String(args.keywords || ''), Number(args.limit) || 20);
        const filePath = String(args.path || ''); const resolved = await this.sandbox.resolve(filePath, { workspaceDir: this.config.workspaceDir, allowMissing: definition.name === 'file_write' });
        if (definition.name === 'file_read') { const result = await this.files.readFile(resolved.path, this.config.workspaceDir, { offset: args.offset ? Number(args.offset) : undefined, lines: args.lines ? Number(args.lines) : undefined, maxLength: args.max_length ? Number(args.max_length) : undefined, direction: args.direction as 'head' | 'tail' | undefined }); if (result.success) onSkillRead?.(resolved.path); return result; }
        if (definition.name === 'file_write') { const result = await this.files.writeFile(resolved.path, String(args.content || ''), this.config.workspaceDir, { append: args.append === true, createDirs: args.create_dirs === true }); if (result.success) onSkillWrite?.(resolved.path); return result; }
        if (definition.name === 'file_edit') { const result = await this.files.editFile(resolved.path, String(args.old_string || ''), String(args.new_string || ''), this.config.workspaceDir, args.replace_all === true); if (result.success) onSkillWrite?.(resolved.path); return result; }
        return buildMediaDisplayResult(resolved.path, this.config.workspaceDir);
      }, { risk: risk[definition.name], parallelSafe: definition.name === 'file_read' || definition.name === 'memory_get' || definition.name === 'browser_fetch', cancellable: definition.name === 'shell_execute', requiresApproval: risk[definition.name] === 'high' });
    }
  }
}
