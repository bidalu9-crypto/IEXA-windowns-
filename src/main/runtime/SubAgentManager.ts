import { randomUUID, createHash } from 'crypto';
import * as path from 'path';
import { JsonStore } from '../persistence/JsonStore';
import { AgentLoopCallbacks, AgentToolDefinition, ToolExecutionResult } from '../providers/types';
import { TranscriptRecorder } from '../session/TranscriptRecorder';
import { PermissionMode } from '../security/PermissionManager';
import { ToolExecutionStatus } from './ToolLifecycle';
import { ToolDefinition } from './ToolRegistry';

type Status = 'idle' | 'queued' | 'running' | 'awaiting_approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'closed';
export interface ChildMessage { role: string; content: string; thinking?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown>; executionStatus?: ToolExecutionStatus; result?: { output: string; success: boolean; executionStatus?: ToolExecutionStatus } }>; transcript?: ReturnType<TranscriptRecorder['snapshot']>; }
export interface SubAgentRecord {
  id: string; parentId: string; rootSessionId: string; nickname: string; depth: number; status: Status;
  revision: number; createdAt: number; updatedAt: number; prompt: string; context: string;
  model: string; workspaceDir: string; isolation: 'shared'; messages: ChildMessage[];
  output: string; error?: string; pendingInputs: string[]; inputTokens: number; outputTokens: number;
}
export type SubAgentSummary = Omit<SubAgentRecord, 'messages' | 'context' | 'pendingInputs'> & { pendingCount: number };
export interface ChildRuntime {
  initialize(): Promise<void>; cancel(): void; setPermissionMode(mode: PermissionMode): void;
  run(request: { message: string; tools: AgentToolDefinition[]; callbacks: AgentLoopCallbacks }): Promise<void>;
  toolDefinitions(): AgentToolDefinition[]; seedHistoryFromChat(messages: ChildMessage[]): void;
  setSessionContext(context: string): void; contextSnapshot(): string;
}
interface Entry { record: SubAgentRecord; runtime?: ChildRuntime; work?: Promise<void>; closing: boolean; stopping: boolean; }
export interface SubAgentOptions {
  rootSessionId: string; directory: string; model: string; workspaceDir: string;
  factory: (record: SubAgentRecord, manager: SubAgentManager) => ChildRuntime;
  rootContext: () => string; onChange?: (agent: SubAgentSummary) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  maxAgents?: number; maxDepth?: number;
}
const busy = new Set<Status>(['queued', 'running', 'awaiting_approval', 'cancelling']);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** One ownership tree per root session. No external execution resumes on load. */
export class SubAgentManager {
  private readonly entries = new Map<string, Entry>();
  private readonly store: JsonStore<{ version: 1; agents: SubAgentRecord[] }>;
  private readonly listeners = new Set<() => void>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private storageError?: string;
  constructor(private readonly options: SubAgentOptions) {
    this.store = new JsonStore(SubAgentManager.storePath(options.directory, options.rootSessionId), () => ({ version: 1, agents: [] }));
    for (const record of SubAgentManager.validateRecords(this.store.loadSync(), options.rootSessionId)) {
      if (!record || record.rootSessionId !== options.rootSessionId || typeof record.id !== 'string') continue;
      if (busy.has(record.status)) {
        record.status = 'interrupted'; record.error = '进程已重启；上次任务已中断，未自动重跑。'; record.pendingInputs = []; record.revision++; record.updatedAt = Date.now();
      }
      this.entries.set(record.id, { record, closing: false, stopping: false });
    }
    if (this.entries.size) this.persist();
  }
  static storePath(directory: string, rootSessionId: string): string {
    return path.join(directory, createHash('sha256').update(rootSessionId).digest('hex') + '.json');
  }
  static read(directory: string, rootSessionId: string): SubAgentRecord[] {
    const store = new JsonStore<{ version: 1; agents: SubAgentRecord[] }>(this.storePath(directory, rootSessionId), () => ({ version: 1, agents: [] }));
    return this.validateRecords(store.loadSync(), rootSessionId).map(record => busy.has(record.status) ? { ...record, status: 'interrupted' as Status, error: '进程已重启；未自动重跑。', pendingInputs: [] } : record);
  }
  private static validateRecords(value: { version: 1; agents: SubAgentRecord[] }, root: string): SubAgentRecord[] {
    const invalid = () => { throw new Error('子代理存档结构异常，原文件已保留。'); };
    if (!value || value.version !== 1 || !Array.isArray(value.agents) || value.agents.length > 256) return invalid();
    const ids = new Map<string, SubAgentRecord>();
    for (const record of value.agents) {
      if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || record.id === root ||
        record.rootSessionId !== root || typeof record.parentId !== 'string' || !Number.isSafeInteger(record.depth) || record.depth < 1 || record.depth > 32 ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.nickname !== 'string' ||
        typeof record.model !== 'string' || typeof record.workspaceDir !== 'string' || !path.isAbsolute(record.workspaceDir) ||
        typeof record.output !== 'string' || typeof record.context !== 'string' || !Array.isArray(record.messages) ||
        !Array.isArray(record.pendingInputs) || record.pendingInputs.some(input => typeof input !== 'string') ||
        !['idle','queued','running','awaiting_approval','cancelling','completed','failed','cancelled','interrupted','closed'].includes(record.status)) return invalid();
      ids.set(record.id, record);
    }
    for (const record of ids.values()) {
      const parent = ids.get(record.parentId);
      if (record.parentId === root ? record.depth !== 1 : !parent || parent.depth + 1 !== record.depth) return invalid();
    }
    return value.agents;
  }
  static summary(record: SubAgentRecord): SubAgentSummary {
    const { messages, context, pendingInputs, ...summary } = record;
    return { ...copy(summary), output: summary.output.slice(-6000), pendingCount: pendingInputs.length };
  }
  list(): SubAgentSummary[] { return [...this.entries.values()].map(entry => SubAgentManager.summary(entry.record)); }
  detail(id: string): SubAgentRecord { return copy(this.require(id).record); }
  hasActiveWork(): boolean { return [...this.entries.values()].some(entry => !!entry.work); }
  private require(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new Error('Unknown sub-agent.'); return entry; }
  private owned(owner: string, id: string): Entry {
    const entry = this.require(id);
    if (entry.record.parentId !== owner) throw new Error('This sub-agent belongs to another parent.');
    return entry;
  }
  private persist(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.storageError) return;
    try { this.store.saveSync({ version: 1, agents: [...this.entries.values()].map(entry => entry.record) }); }
    catch (error) {
      // A full/read-only disk must not crash an unobserved timer or continue work
      // whose state cannot be recorded. Preserve the last atomic snapshot.
      this.storageError = `子代理记录保存失败：${(error as Error).message}`; this.stopping = true;
      for (const entry of this.entries.values()) {
        entry.record.pendingInputs = []; entry.record.error = this.storageError;
        if (entry.work || busy.has(entry.record.status)) entry.record.status = 'failed';
        entry.runtime?.cancel(); entry.record.revision++;
        try { this.options.onChange?.(SubAgentManager.summary(entry.record)); } catch { /* Keep stopping on UI errors. */ }
      }
    }
  }
  private changed(entry: Entry, immediate = true): void {
    if (this.storageError) { entry.record.error = this.storageError; if (entry.record.status !== 'closed') entry.record.status = 'failed'; }
    entry.record.updatedAt = Date.now(); entry.record.revision++;
    if (immediate) this.persist();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.persist(); }, 120);
    try { this.options.onChange?.(SubAgentManager.summary(entry.record)); } catch { /* Disconnected UI is not execution state. */ }
    for (const listener of this.listeners) listener();
  }
  private message(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 64000) throw new Error('message must contain 1–64000 characters.');
    return value.trim();
  }
  private requireOpenParent(owner: string): void {
    if (owner === this.options.rootSessionId) return;
    const parent = this.require(owner);
    if (parent.closing || parent.stopping || parent.record.status === 'closed') throw new Error('Resume the parent agent first.');
    this.requireOpenParent(parent.record.parentId);
  }
  private requireWritable(): void { if (this.storageError) throw new Error(this.storageError); }
  private canOpen(): void {
    this.requireWritable();
    if (this.stopping) throw new Error('Parent cancellation is settling.');
    if ([...this.entries.values()].filter(entry => entry.record.status !== 'closed').length >= (this.options.maxAgents ?? 6)) throw new Error('Sub-agent limit reached; close an existing agent first.');
  }
  spawn(owner: string, message: string, forkContext = false, nickname = ''): SubAgentSummary {
    this.canOpen(); this.requireOpenParent(owner); message = this.message(message);
    const parent = owner === this.options.rootSessionId ? undefined : this.require(owner);
    if (parent && (parent.closing || parent.stopping || parent.record.status === 'closed')) throw new Error('Parent is closing.');
    const depth = parent ? parent.record.depth + 1 : 1;
    if (depth > (this.options.maxDepth ?? 3)) throw new Error('Sub-agent nesting limit reached.');
    if (this.entries.size >= 256) throw new Error('Session sub-agent record limit reached.');
    const context = forkContext ? (parent?.runtime?.contextSnapshot() ?? this.options.rootContext()).slice(-32000) : '';
    const record: SubAgentRecord = { id: randomUUID(), parentId: owner, rootSessionId: this.options.rootSessionId,
      nickname: String(nickname || `Agent ${this.entries.size + 1}`).slice(0, 60), depth, status: 'queued', revision: 0,
      createdAt: Date.now(), updatedAt: Date.now(), prompt: message, context, model: this.options.model,
      workspaceDir: this.options.workspaceDir, isolation: 'shared', messages: [], output: '', pendingInputs: [message], inputTokens: 0, outputTokens: 0 };
    const entry: Entry = { record, closing: false, stopping: false }; this.entries.set(record.id, entry);
    this.changed(entry); this.requireWritable(); this.start(entry); return SubAgentManager.summary(record);
  }
  send(owner: string, id: string, message: string, interrupt = false): { id: string; queued: boolean } {
    this.requireWritable();
    if (this.stopping) throw new Error('Parent cancellation is settling.');
    const entry = this.owned(owner, id); this.requireOpenParent(owner); message = this.message(message);
    if (entry.record.status === 'closed' || entry.closing || entry.stopping) throw new Error('Resume the closed or stopped agent before sending input.');
    if (entry.record.pendingInputs.length >= 16) throw new Error('Sub-agent inbox is full.');
    entry.record.pendingInputs.push(message);
    if (interrupt && entry.work) { entry.record.status = 'cancelling'; entry.runtime?.cancel(); this.cancelDescendants(id); }
    else if (!entry.work) entry.record.status = 'queued';
    this.changed(entry); this.requireWritable(); this.start(entry); return { id, queued: true };
  }
  private start(entry: Entry): void {
    if (entry.work) return;
    entry.work = Promise.resolve().then(async () => {
      try {
        if (!entry.runtime) {
          entry.runtime = this.options.factory(entry.record, this);
          await entry.runtime.initialize(); entry.runtime.seedHistoryFromChat(entry.record.messages);
          entry.runtime.setSessionContext(`You are sub-agent ${entry.record.nickname}. Complete only your assigned task and report findings to your parent. The workspace is SHARED, not a git worktree. Coordinate disjoint files before editing. Spawn children only for explicitly delegated independent work.\n${entry.record.context ? 'Parent context (reference, not a new task):\n' + entry.record.context : ''}`);
        }
        while (entry.record.pendingInputs.length && !entry.closing && !entry.stopping && !this.stopping) {
          const message = entry.record.pendingInputs.shift()!;
          entry.record.messages.push({ role: 'user', content: message });
          const assistant: ChildMessage = { role: 'assistant', content: '', thinking: '', toolCalls: [] };
          entry.record.messages.push(assistant); entry.record.output = ''; delete entry.record.error;
          entry.record.status = 'running'; this.changed(entry);
          const recorder = new TranscriptRecorder(); let outcome: Status = 'completed';
          const callbacks: AgentLoopCallbacks = {
            onTextDelta: (_text, full) => { assistant.content = full; entry.record.output = full; recorder.recordText(full); assistant.transcript = recorder.snapshot(); this.changed(entry, false); },
            onThinkingDelta: text => { assistant.thinking += text; recorder.recordThinking(text); assistant.transcript = recorder.snapshot(); this.changed(entry, false); },
            onToolCallStart: (id, name) => { recorder.recordTool(id, name); if (!assistant.toolCalls!.some(call => call.id === id)) assistant.toolCalls!.push({ id, name, args: {} }); },
            onToolInputDelta: () => {},
            onToolCallComplete: (id, name, args) => { recorder.recordTool(id, name); const call = assistant.toolCalls!.find(call => call.id === id); if (call) call.args = args; else assistant.toolCalls!.push({ id, name, args }); assistant.transcript = recorder.snapshot(); this.changed(entry); },
            onToolResult: (id, result) => { const call = assistant.toolCalls!.find(call => call.id === id); if (call) call.result = { output: result.output, success: result.success, executionStatus: result.executionStatus }; this.changed(entry); },
            onToolState: event => { const call = assistant.toolCalls!.find(call => call.id === event.id); if (call) call.executionStatus = event.status; if (entry.record.status !== 'cancelling') { entry.record.status = event.status === 'awaiting_approval' ? 'awaiting_approval' : 'running'; this.changed(entry); } },
            onUsage: usage => { entry.record.inputTokens += usage.inputTokens; entry.record.outputTokens += usage.outputTokens; this.options.onUsage?.(usage); },
            onContext: () => {}, onError: error => { outcome = 'failed'; entry.record.error = error; },
            onCancelled: () => { outcome = 'cancelled'; }, onDone: () => {},
          };
          try { await entry.runtime.run({ message, tools: entry.runtime.toolDefinitions(), callbacks }); }
          catch (error) { outcome = 'failed'; entry.record.error = String((error as Error).message || error); }
          recorder.finish((outcome as Status) === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed'); assistant.transcript = recorder.snapshot();
          entry.record.status = outcome; this.changed(entry);
        }
      } catch (error) { entry.record.status = 'failed'; entry.record.error = String((error as Error).message || error); entry.record.pendingInputs = []; this.changed(entry); }
    }).finally(() => {
      entry.work = undefined;
      if (entry.record.status === 'cancelling') { entry.record.status = 'cancelled'; this.changed(entry); }
      const stopped = entry.stopping; entry.stopping = false;
      for (const listener of this.listeners) listener();
      if (entry.record.pendingInputs.length && !entry.closing && !stopped && !this.stopping) this.start(entry);
    });
  }
  async wait(owner: string, ids: string[], timeoutMs = 30000, signal?: AbortSignal): Promise<{ agents: SubAgentSummary[]; timedOut: boolean }> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 32) throw new Error('ids must contain 1–32 agent IDs.');
    const entries = [...new Set(ids)].map(id => this.owned(owner, id));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000) throw new Error('timeout_ms must be between 0 and 300000.');
    const settled = () => entries.filter(entry => !entry.work && !busy.has(entry.record.status));
    if (!settled().length && !signal?.aborted) await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener('abort', cleanup); resolve(); };
      const check = () => { if (settled().length) cleanup(); };
      this.listeners.add(check); signal?.addEventListener('abort', cleanup, { once: true }); timer = setTimeout(cleanup, timeoutMs); check();
      if (signal?.aborted) cleanup();
    });
    if (signal?.aborted) throw new Error('Agent wait cancelled.');
    const result = settled(); return { agents: result.map(entry => SubAgentManager.summary(entry.record)), timedOut: !result.length };
  }
  private descendants(owner: string): Entry[] {
    const children = [...this.entries.values()].filter(entry => entry.record.parentId === owner);
    return children.flatMap(entry => [entry, ...this.descendants(entry.record.id)]);
  }
  cancelDescendants(owner: string): void {
    for (const entry of this.descendants(owner)) {
      entry.record.pendingInputs = []; entry.stopping = !!entry.work;
      if (entry.work) { entry.record.status = 'cancelling'; entry.runtime?.cancel(); this.changed(entry); }
    }
  }
  async settleDescendants(owner: string): Promise<void> { await Promise.all(this.descendants(owner).map(entry => entry.work)); }
  cancelAll(): void { this.stopping = true; this.cancelDescendants(this.options.rootSessionId); }
  async settleAll(): Promise<void> { await this.settleDescendants(this.options.rootSessionId); this.stopping = false; this.persist(); }
  async close(owner: string, id: string): Promise<SubAgentSummary & { previousStatus: Status }> {
    const entry = this.owned(owner, id); const previousStatus = entry.record.status; const entries = [entry, ...this.descendants(id)];
    for (const item of entries) { item.closing = true; item.record.pendingInputs = []; if (item.work) { item.record.status = 'cancelling'; item.runtime?.cancel(); this.changed(item); } }
    await Promise.all(entries.map(item => item.work));
    for (const item of entries.reverse()) { item.runtime = undefined; item.record.status = 'closed'; item.closing = false; this.changed(item); }
    return { ...SubAgentManager.summary(entry.record), previousStatus };
  }
  resume(owner: string, id: string): SubAgentSummary {
    this.requireWritable();
    const entry = this.owned(owner, id); this.requireOpenParent(owner);
    if (entry.closing || entry.stopping || this.stopping) throw new Error('Agent cleanup is in progress.');
    if (entry.record.status === 'closed') { this.canOpen(); entry.record.status = 'idle'; this.changed(entry); }
    else if (entry.record.status === 'interrupted') { entry.record.status = 'idle'; this.changed(entry); }
    return SubAgentManager.summary(entry.record);
  }
  setPermissionMode(mode: PermissionMode): void { for (const entry of this.entries.values()) entry.runtime?.setPermissionMode(mode); }
  definitions(owner: string): ToolDefinition[] {
    const definition = (name: string, description: string, parameters: AgentToolDefinition['parameters'], required: string[], action: (args: any, signal: AbortSignal) => unknown | Promise<unknown>): ToolDefinition => ({
      name, description, parameters, required, risk: 'low', parallelSafe: false, cancellable: true, requiresApproval: false,
      execute: async (args, context): Promise<ToolExecutionResult> => {
        if (context.signal.aborted) throw new Error('Agent operation cancelled.');
        const result = await action(args, context.signal); this.requireWritable(); return { success: true, output: JSON.stringify(result) };
      },
    });
    const id = { type: 'string' as const, description: 'ID of a direct child created by this agent.' };
    const message = { type: 'string' as const, description: 'Concrete bounded task or follow-up input.' };
    return [
      definition('spawn_agent', 'Start an independent child agent asynchronously. Same model, inherited permissions, shared workspace (not worktree). Up to 6 open children across the tree and depth 3. Use for explicitly delegated independent tasks with disjoint file ownership; returns ID, not a finished result.', { message, fork_context: { type: 'boolean', description: 'Copy bounded parent context as reference.' }, nickname: { type: 'string', description: 'Short display name.' } }, ['message'], args => this.spawn(owner, args.message, args.fork_context === true, args.nickname)),
      definition('send_input', 'Send input to an existing direct child. Queued by default; interrupt cancels current execution and waits for cleanup before processing new input.', { id, message, interrupt: { type: 'boolean', description: 'Interrupt the current task before processing this input.' } }, ['id', 'message'], args => this.send(owner, args.id, args.message, args.interrupt === true)),
      definition('wait_agent', 'Wait until at least one listed child settles or timeout. A timeout does not cancel children. Check returned status and output before reporting success.', { ids: { type: 'array', description: 'Direct child IDs.', items: id }, timeout_ms: { type: 'integer', minimum: 0, maximum: 300000, description: '0–300000 milliseconds, default 30000.' } }, ['ids'], (args, signal) => this.wait(owner, args.ids, args.timeout_ms ?? 30000, signal)),
      definition('close_agent', 'Cancel and close a child and all its descendants, awaiting real cleanup. Releases open-agent slots and retains history.', { id }, ['id'], args => this.close(owner, args.id)),
      definition('resume_agent', 'Reopen a closed child retaining conversation history. Does not automatically repeat interrupted work; use send_input for the next task.', { id }, ['id'], args => this.resume(owner, args.id)),
    ];
  }
}
