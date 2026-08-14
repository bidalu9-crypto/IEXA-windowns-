// =============================================================================
// IEXA PC - Agent Loop
// Mirrors iOS AIChatViewModel.runAgentLoop()
// =============================================================================

import * as path from 'path';
import {
  AgentMessage,
  AgentContentPart,
  AgentStreamEvent,
  AgentStopReason,
  AgentToolDefinition,
  AgentLoopCallbacks,
  ToolExecutionResult,
  LLMUsage,
} from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';
import { ShellExecutor, FileTools, MemoryTools, BrowserFetch, buildMediaDisplayResult } from '../tools/ToolExecutors';
import { buildSystemPrompt } from './SystemPrompt';
import { ContextCompactor, contextWindowForModel } from './ContextCompactor';

const MAX_AGENT_TURNS = 200;
/** Keep tool evidence useful without letting build logs dominate context. */
const MAX_TOOL_RESULT_CHARS = 15000;
const TOOL_RESULT_COMPACT_AT = 12000;

function compactToolResultForContext(output: string): string {
  if (output.length <= TOOL_RESULT_COMPACT_AT) return output;
  const head = output.slice(0, 4200);
  const tail = output.slice(-4200);
  // Preserve a central diagnostic region when a compiler/runtime reported one.
  const signal = /(?:error|failed|exception|traceback|warn|错误|失败)/i;
  const middleAt = output.search(signal);
  const middle = middleAt >= 0
    ? output.slice(Math.max(0, middleAt - 900), Math.min(output.length, middleAt + 1700))
    : output.slice(Math.max(0, Math.floor(output.length / 2) - 900), Math.floor(output.length / 2) + 1700);
  return `${head}

[... tool output compacted: ${output.length.toLocaleString()} chars total; head + diagnostic/middle + tail retained ...]

${middle}

[... end of compacted tool output ...]

${tail}`;
}

export interface AgentLoopConfig {
  provider: LLMProvider;
  workspaceDir: string;
  memoryDir: string;
  memoryEnabled: boolean;
  maxTokens?: number;
  /** True when workspaceDir is a user-opened project folder. */
  hasProject?: boolean;
  projectName?: string | null;
  /** Optional skill catalog for system prompt. */
  skillFragment?: string | null;
  /** Full body of explicitly trusted application-level skills. */
  systemSkillFragment?: string | null;
  /** Absolute skills directory for authoring instructions. */
  skillsDir?: string | null;
  /** API-reported context window (from /v1/models), overrides model-name guessing. */
  contextWindow?: number;
  /** Called when model file_reads a skill SKILL.md */
  onSkillRead?: (resolvedPath: string) => void;
  /** Called after model writes/edits a path under skills/ */
  onSkillWrite?: (resolvedPath: string) => void;
}

export class AgentLoop {
  private config: AgentLoopConfig;
  private shell: ShellExecutor;
  private files: FileTools;
  private memory: MemoryTools;
  private browser: BrowserFetch;
  private agentHistory: AgentMessage[] = [];
  private isCancelled = false;
  private callbacks: AgentLoopCallbacks | null = null;
  /** Durable per-session anchors supplied by the server after rehydration. */
  private sessionContext = '';
  /** Codex-style compaction engine; kept as a field so the server can persist the summary. */
  private compactor: ContextCompactor | null = null;
  /** Summary can be loaded from disk before run() creates a request compactor. */
  private pendingCompactorSummary = '';
  /** Restored checkpoints must become model-visible once, not once per turn. */
  private restoredSummaryInjected = false;

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.shell = new ShellExecutor(config.workspaceDir);
    this.files = new FileTools();
    this.memory = new MemoryTools(config.memoryDir);
    this.browser = new BrowserFetch();
  }

  async initialize(): Promise<void> {
    await this.memory.initialize();
  }

  cancel(): void {
    this.isCancelled = true;
  }

  reset(): void {
    this.agentHistory = [];
    this.isCancelled = false;
  }

  setSessionContext(context: string | null | undefined): void {
    this.sessionContext = typeof context === 'string' ? context.trim() : '';
  }

  /** Current Codex-style compaction summary (persisted across restarts). */
  getCompactorSummary(): string {
    return this.compactor ? this.compactor.getSummary() : '';
  }

  /** Restore a persisted compaction summary after restart. */
  setCompactorSummary(summary: string | null | undefined): void {
    this.pendingCompactorSummary = typeof summary === 'string' ? summary.trim() : '';
    if (this.compactor && this.pendingCompactorSummary) {
      this.compactor.setSummary(this.pendingCompactorSummary);
    }
  }

  /**
   * Rehydrate conversational context from saved chat messages (disk).
   * Text-only pairs — avoids tool_use without tool_result protocol errors.
   */
  seedHistoryFromChat(
    msgs: Array<{
      role: string;
      content?: string;
      attachments?: Array<{ name?: string; savedPath?: string; mime?: string }>;
      toolCalls?: Array<{
        id: string;
        name: string;
        args?: Record<string, unknown>;
        result?: { output?: string; success?: boolean };
      }>;
    }>,
  ): void {
    this.agentHistory = [];
    for (const m of msgs) {
      const text = (m.content || '').trim();
      if (m.role === 'user') {
        const attachmentNotes = (m.attachments || [])
          .map((a) => `[Previously attached file: ${a.name || 'file'}${a.savedPath ? ` -> ${a.savedPath}` : ''}${a.mime ? ` (${a.mime})` : ''}]`)
          .join('\n');
        const combined = [text, attachmentNotes].filter(Boolean).join('\n\n');
        if (!combined) continue;
        this.agentHistory.push({
          role: 'user',
          parts: [{ type: 'text', text: combined }],
        });
      } else if (m.role === 'assistant') {
        const toolParts: AgentContentPart[] = (m.toolCalls || [])
          .filter((tc) => tc.id && tc.name)
          .map((tc) => ({ type: 'toolUse' as const, id: tc.id, name: tc.name, input: tc.args || {} }));
        // Saved tool results are restored as the following user message. This
        // keeps provider tool protocols valid while retaining URLs, paths and
        // parsed output that are absent from the assistant's visible text.
        const results = (m.toolCalls || []).filter((tc) => tc.id && tc.name && tc.result);
        if (toolParts.length > 0) {
          this.agentHistory.push({ role: 'assistant', parts: toolParts });
        }
        if (results.length > 0) {
          this.agentHistory.push({
            role: 'user',
            parts: results.map((tc) => ({
              type: 'toolResult' as const,
              id: tc.id,
              name: tc.name,
              content: String(tc.result?.output || '').substring(0, MAX_TOOL_RESULT_CHARS),
              isError: tc.result?.success === false,
            })),
          });
        }
        if (text) {
          this.agentHistory.push({ role: 'assistant', parts: [{ type: 'text', text }] });
        }
      }
    }
  }

  getHistoryLength(): number {
    return this.agentHistory.length;
  }

  async run(
    userMessage: string,
    tools: AgentToolDefinition[],
    callbacks: AgentLoopCallbacks,
    attachments?: Array<{
      name: string;
      mime: string;
      kind: 'image' | 'text' | 'file';
      data?: Buffer;
      text?: string;
      savedPath?: string;
    }>,
  ): Promise<void> {
    this.callbacks = callbacks;
    this.isCancelled = false;

    // Build user message parts (text + optional images / file notes)
    const parts: AgentContentPart[] = [];
    let text = userMessage || '';

    if (attachments && attachments.length > 0) {
      const notes: string[] = [];
      for (const att of attachments) {
        if (att.kind === 'image' && att.data) {
          parts.push({ type: 'imageData', data: att.data, mimeType: att.mime || 'image/png' });
          notes.push(`[Image attached: ${att.name}${att.savedPath ? ` → saved as ${att.savedPath}` : ''}]`);
        } else if (att.kind === 'text' && att.text != null) {
          const clipped = att.text.length > 80000
            ? att.text.substring(0, 80000) + '\n\n... (truncated)'
            : att.text;
          notes.push(
            `[Attached file: ${att.name}${att.savedPath ? ` → ${att.savedPath}` : ''}]\n` +
            '```\n' + clipped + '\n```'
          );
        } else {
          notes.push(
            `[Attached binary file: ${att.name}` +
            `${att.savedPath ? ` → saved to workspace as ${att.savedPath}` : ''}` +
            ` (${att.mime || 'application/octet-stream'})]`
          );
        }
      }
      if (notes.length) {
        text = (text ? text + '\n\n' : '') + notes.join('\n\n');
      }
    }

    if (text) {
      parts.unshift({ type: 'text', text });
    } else if (parts.length === 0) {
      parts.push({ type: 'text', text: '' });
    }

    // A persisted checkpoint must be model-visible after restart, just as a
    // Harness compaction checkpoint replaces an older conversation surface.
    // Prepend it once to the next user message, preserving valid role order.
    if (this.pendingCompactorSummary && !this.restoredSummaryInjected) {
      const checkpoint = `<context-summary>\n${this.pendingCompactorSummary}\n</context-summary>\n\nRestored context checkpoint; continue directly from the request below.\n\n`;
      const firstText = parts.find((part): part is Extract<AgentContentPart, { type: 'text' }> => part.type === 'text');
      if (firstText) firstText.text = checkpoint + firstText.text;
      else parts.unshift({ type: 'text', text: checkpoint });
      this.restoredSummaryInjected = true;
    }

    // Add user message to history
    const userMsg: AgentMessage = {
      role: 'user',
      parts,
    };
    this.agentHistory.push(userMsg);

    const baseSystemPrompt = buildSystemPrompt({
      memoryEnabled: this.config.memoryEnabled,
      workspaceDir: this.config.workspaceDir,
      hasProject: !!this.config.hasProject,
      projectName: this.config.projectName || null,
      skillFragment: this.config.skillFragment || null,
      systemSkillFragment: this.config.systemSkillFragment || null,
      skillsDir: this.config.skillsDir || null,
    });
    const systemPrompt = this.sessionContext
      ? `${baseSystemPrompt}\n\n<durable-session-context>\n${this.sessionContext}\n</durable-session-context>`
      : baseSystemPrompt;
    const contextWindow = this.config.contextWindow != null
      ? this.config.contextWindow
      : contextWindowForModel(this.config.provider.model, this.config.provider.name);
    const compactor = new ContextCompactor(
      this.config.provider,
      contextWindow,
      tools,
      systemPrompt,
      this.config.maxTokens || this.config.provider.defaultMaxTokens,
    );
    this.compactor = compactor;
    if (this.pendingCompactorSummary) compactor.setSummary(this.pendingCompactorSummary);
    let turnCount = 0;
    let streamRetryAttempt = 0;
    let contextOverflowRetryAttempt = 0;
    const retryDelays = [2000, 5000, 10000];

    while (turnCount < MAX_AGENT_TURNS && !this.isCancelled) {
      turnCount++;

      // Build messages for this turn
      // iOS-style capacity guard: summarize old history before a request while
      // retaining the last three user turns as verbatim live anchors.
      try {
        this.agentHistory = await compactor.compactIfNeeded(this.agentHistory, (status) => callbacks.onContext(status));
      } catch (error: unknown) {
        const err = error as Error;
        if (this.isRetryableStreamError(err) && streamRetryAttempt < retryDelays.length && !this.isCancelled) {
          const delayMs = retryDelays[streamRetryAttempt++];
          callbacks.onRetry?.(streamRetryAttempt, delayMs, err.message || 'context compaction interrupted');
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        callbacks.onError(err.message || 'Context compaction failed');
        return;
      }
      const messages = [...this.agentHistory];

      try {
        // Stream from provider
        let assistantText = '';
        const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        let stopReason: AgentStopReason = 'endTurn';
        let usage: LLMUsage | undefined;

        const stream = this.config.provider.streamMessage(
          messages,
          systemPrompt,
          tools,
          this.config.maxTokens || 64000,
        );

        for await (const event of stream) {
          if (this.isCancelled) {
            callbacks.onCancelled();
            return;
          }

          switch (event.type) {
            case 'contentBlockStart':
              if (event.block.type === 'toolUse') {
                callbacks.onToolCallStart(event.block.id, event.block.name);
              }
              break;

            case 'textDelta':
              assistantText += event.text;
              callbacks.onTextDelta(event.text, assistantText);
              break;

            case 'thinkingDelta':
              callbacks.onThinkingDelta(event.text);
              break;

            case 'toolInputDelta':
              callbacks.onToolInputDelta(event.name, event.accumulated, event.id);
              break;

            case 'toolCallComplete':
              toolCalls.push({
                id: event.id,
                name: event.name,
                args: event.args,
              });
              callbacks.onToolCallComplete(event.id, event.name, event.args);
              break;

            case 'usage':
              usage = event.usage;
              callbacks.onUsage(event.usage);
              compactor.recordProviderUsage(event.usage.inputTokens);
              callbacks.onContext(compactor.status(this.agentHistory));
              break;

            case 'done':
              stopReason = event.stopReason;
              break;
          }
        }
        // A complete provider turn succeeded; transient retry budget is reset.
        streamRetryAttempt = 0;

        // Build assistant message
        const assistantParts: AgentContentPart[] = [];
        if (assistantText) {
          assistantParts.push({ type: 'text', text: assistantText });
        }
        for (const tc of toolCalls) {
          assistantParts.push({
            type: 'toolUse',
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }

        const assistantMsg: AgentMessage = {
          role: 'assistant',
          parts: assistantParts,
        };
        this.agentHistory.push(assistantMsg);

        // If no tool calls, we're done
        if (toolCalls.length === 0 || stopReason === 'endTurn') {
          callbacks.onDone(stopReason);
          return;
        }

        // Execute tools
        const toolResults: AgentContentPart[] = [];
        for (const tc of toolCalls) {
          if (this.isCancelled) {
            callbacks.onCancelled();
            return;
          }

          callbacks.onToolExecutionStart?.(tc.id, tc.name, tc.args);
          const result = await this.executeTool(tc.name, tc.args);
          callbacks.onToolResult(tc.id, result);

          toolResults.push({
            type: 'toolResult',
            id: tc.id,
            name: tc.name,
            content: compactToolResultForContext(result.output).substring(0, MAX_TOOL_RESULT_CHARS),
            isError: !result.success,
            imageData: result.imageData,
            imageMimeType: result.imageMimeType,
          });
        }

        // Add tool results as a user message to history
        this.agentHistory.push({
          role: 'user',
          parts: toolResults,
        });

        // If stop reason is not toolUse, break
        if (stopReason !== 'toolUse') {
          callbacks.onDone(stopReason);
          return;
        }

        // Otherwise continue loop for next model response
      } catch (error: unknown) {
        const err = error as Error;
        // Harness-style overflow recovery: only retry after a successful,
        // model-visible replacement has reduced the current history.
        if (this.isContextWindowExceededError(err) && contextOverflowRetryAttempt < 1 && !this.isCancelled) {
          const beforeHistory = this.agentHistory;
          try {
            const compacted = await compactor.compactForOverflow(beforeHistory, (status) => callbacks.onContext(status));
            if (compacted !== beforeHistory) {
              this.agentHistory = compacted;
              contextOverflowRetryAttempt++;
              callbacks.onRetry?.(contextOverflowRetryAttempt, 0, '上下文超限，已压缩历史后重试');
              continue;
            }
          } catch (compactionError: unknown) {
            callbacks.onError((compactionError as Error).message || '上下文超限后的压缩恢复失败');
            return;
          }
        }
        if (this.isRetryableStreamError(err) && streamRetryAttempt < retryDelays.length && !this.isCancelled) {
          const delayMs = retryDelays[streamRetryAttempt++];
          callbacks.onRetry?.(streamRetryAttempt, delayMs, err.message || 'stream interrupted');
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        callbacks.onError(err.message || 'Unknown error in agent loop');
        return;
      }
    }

    // Max turns reached
    if (turnCount >= MAX_AGENT_TURNS) {
      callbacks.onError(`Reached maximum agent turns (${MAX_AGENT_TURNS}). The task may be too complex.`);
    }
  }

  private isContextWindowExceededError(error: Error): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    return /context.{0,48}(length|window|limit|exceed)|maximum.{0,48}context|too many tokens|prompt is too long/.test(message);
  }

  private isRetryableStreamError(error: Error): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    if (this.isContextWindowExceededError(error) || /\b(401|403|404|400|422)\b/.test(message)) return false;
    return /\b(408|425|429|500|502|503|504|529)\b/.test(message) ||
      /timeout|timed out|network|fetch failed|socket|econn|reset|aborted|stream idle|no response body|premature|overload|temporar|quota_exceeded/.test(message);
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    switch (name) {
      case 'todo_write': {
        const raw = Array.isArray(args.todos) ? args.todos : null;
        if (!raw) return { output: 'Error: todos must be an array.', success: false };
        if (raw.length === 0 || raw.length > 24) {
          return { output: 'Error: todos must contain between 1 and 24 items.', success: false };
        }
        const seen = new Set<string>();
        const todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> = [];
        let inProgress = 0;
        for (const item of raw) {
          if (!item || typeof item !== 'object') return { output: 'Error: every todo must be an object.', success: false };
          const content = String((item as Record<string, unknown>).content || '').trim();
          const status = String((item as Record<string, unknown>).status || '');
          if (!content || content.length > 240) return { output: 'Error: todo content must be 1-240 characters.', success: false };
          if (!['pending', 'in_progress', 'completed'].includes(status)) {
            return { output: 'Error: todo status must be pending, in_progress, or completed.', success: false };
          }
          const key = content.toLocaleLowerCase();
          if (seen.has(key)) return { output: `Error: duplicate todo content: ${content}`, success: false };
          seen.add(key);
          if (status === 'in_progress') inProgress++;
          todos.push({ content, status: status as 'pending' | 'in_progress' | 'completed' });
        }
        if (inProgress > 1) return { output: 'Error: at most one todo may be in_progress.', success: false };
        const completed = todos.filter((todo) => todo.status === 'completed').length;
        const active = todos.filter((todo) => todo.status === 'in_progress').length;
        return {
          output: `Todo plan updated: ${todos.length - completed - active} pending, ${active} in progress, ${completed} completed.`,
          success: true,
          todos,
        };
      }

      case 'shell_execute': {
        const command = String(args.command || '');
        const timeout = Number(args.timeout) || 900;
        return await this.shell.execute(command, timeout);
      }

      case 'file_read': {
        const filePath = String(args.path || '');
        const result = await this.files.readFile(filePath, this.config.workspaceDir, {
          offset: args.offset ? Number(args.offset) : undefined,
          lines: args.lines ? Number(args.lines) : undefined,
          maxLength: args.max_length ? Number(args.max_length) : undefined,
          direction: (args.direction as 'head' | 'tail') || undefined,
        });
        // iOS: track skill use when model loads SKILL.md
        if (result.success && this.config.onSkillRead) {
          try {
            const resolved = path.isAbsolute(filePath)
              ? filePath
              : path.resolve(this.config.workspaceDir, filePath);
            this.config.onSkillRead(resolved);
          } catch { /* */ }
        }
        return result;
      }

      case 'file_write': {
        const filePath = String(args.path || '');
        const content = String(args.content || '');
        const resolvedWrite = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(this.config.workspaceDir, filePath);
        const isSkillPath = !!(this.config.skillsDir &&
          path.resolve(resolvedWrite).toLowerCase().replace(/\\/g, '/').startsWith(
            path.resolve(this.config.skillsDir).toLowerCase().replace(/\\/g, '/'),
          ));
        const result = await this.files.writeFile(filePath, content, this.config.workspaceDir, {
          append: args.append === true,
          createDirs: args.create_dirs === true || isSkillPath,
        });
        if (result.success && this.config.onSkillWrite) {
          try { this.config.onSkillWrite(resolvedWrite); } catch { /* */ }
        }
        return result;
      }

      case 'file_edit': {
        const filePath = String(args.path || '');
        const oldString = String(args.old_string || '');
        const newString = String(args.new_string || '');
        const replaceAll = args.replace_all === true;
        const result = await this.files.editFile(filePath, oldString, newString, this.config.workspaceDir, replaceAll);
        if (result.success && this.config.onSkillWrite) {
          try {
            const resolved = path.isAbsolute(filePath)
              ? filePath
              : path.resolve(this.config.workspaceDir, filePath);
            this.config.onSkillWrite(resolved);
          } catch { /* */ }
        }
        return result;
      }

      case 'browser_fetch': {
        const url = String(args.url || '');
        const maxLength = Number(args.max_length) || 25000;
        return await this.browser.fetch(url, maxLength);
      }

      case 'display_file': {
        const filePath = String(args.path || '');
        return await buildMediaDisplayResult(filePath, this.config.workspaceDir);
      }

      case 'memory_write': {
        const content = String(args.content || '');
        return await this.memory.writeMemory(content);
      }

      case 'memory_get': {
        const keywords = String(args.keywords || '');
        const limit = Number(args.limit) || 20;
        return await this.memory.getMemory(keywords, limit);
      }

      default:
        return {
          output: `Unknown tool: ${name}`,
          success: false,
        };
    }
  }
}
