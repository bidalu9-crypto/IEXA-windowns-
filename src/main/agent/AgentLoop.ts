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
import { ToolRuntime } from '../runtime/ToolRuntime';
import { buildSystemPrompt } from './SystemPrompt';
import { ContextCompactor, contextWindowForModel, estimateMessageTokens } from './ContextCompactor';
import { ContextManager } from '../context/ContextManager';
import { RetryManager } from '../runtime/RetryManager';

/** Keep live tool evidence useful without letting build logs dominate context. */
const MAX_TOOL_RESULT_CHARS = 2400;
const TOOL_RESULT_COMPACT_AT = 1800;
/** Restart recovery is a bounded working set; full records stay in session JSON. */
const MAX_REHYDRATED_HISTORY_TOKENS = 24000;
const MAX_REHYDRATED_TEXT_CHARS = 6000;
const MAX_REHYDRATED_TOOL_RESULTS_PER_TURN = 16;

function compactToolResultForContext(output: string): string {
  if (output.length <= TOOL_RESULT_COMPACT_AT) return output;
  const marker = `[... tool output compacted: ${output.length.toLocaleString()} chars total ...]`;
  const available = Math.max(240, MAX_TOOL_RESULT_CHARS - marker.length - 24);
  const headSize = Math.floor(available * 0.42);
  const tailSize = Math.floor(available * 0.30);
  const middleSize = Math.max(120, available - headSize - tailSize);
  const head = output.slice(0, headSize);
  const tail = output.slice(-tailSize);
  // Preserve a central diagnostic region when a compiler/runtime reported one.
  const signal = /(?:error|failed|exception|traceback|warn|错误|失败)/i;
  const middleAt = output.search(signal);
  const middle = middleAt >= 0
    ? output.slice(Math.max(0, middleAt - Math.floor(middleSize / 3)), Math.min(output.length, middleAt + middleSize))
    : output.slice(Math.max(0, Math.floor(output.length / 2) - Math.floor(middleSize / 2)), Math.floor(output.length / 2) + Math.floor(middleSize / 2));
  return `${head}

${marker}

${middle}

[... end compacted output ...]

${tail}`.slice(0, MAX_TOOL_RESULT_CHARS);
}

function clipHistoryText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `\n\n[... historical text compacted from ${text.length.toLocaleString()} chars ...]\n\n`;
  const available = Math.max(160, limit - marker.length);
  const head = Math.ceil(available * 0.7);
  return (text.slice(0, head) + marker + text.slice(-(available - head))).slice(0, limit);
}

export interface AgentLoopConfig {
  sessionId: string;
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
  /** Runtime is the exclusive execution path for all agent tools. */
  toolRuntime: ToolRuntime;
  getAbortSignal: () => AbortSignal | undefined;
}

export class AgentLoop {
  private config: AgentLoopConfig;
  private agentHistory: AgentMessage[] = [];
  private isCancelled = false;
  private callbacks: AgentLoopCallbacks | null = null;
  /** Durable per-session anchors supplied by the server after rehydration. */
  private sessionContext = '';
  /** Codex-style compaction engine; kept as a field so the server can persist the summary. */
  private compactor: ContextManager | null = null;
  /** Summary can be loaded from disk before run() creates a request compactor. */
  private pendingCompactorSummary = '';
  private readonly retryManager = new RetryManager();
  /** Restored checkpoints must become model-visible once, not once per turn. */
  private restoredSummaryInjected = false;

  constructor(config: AgentLoopConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    await this.config.toolRuntime.initialize();
  }

  cancel(): void {
    this.isCancelled = true;
  }

  private get isAborted(): boolean { return this.isCancelled || this.config.getAbortSignal()?.aborted === true; }

  reset(): void {
    this.agentHistory = [];
    this.isCancelled = false;
  }

  setSessionContext(context: string | null | undefined): void {
    this.sessionContext = typeof context === 'string' ? context.trim() : '';
  }

  /** Current Codex-style compaction summary (persisted across restarts). */
  getCompactorSummary(): string {
    return this.compactor ? this.compactor.summary() : '';
  }

  /** Restore a persisted compaction summary after restart. */
  setCompactorSummary(summary: string | null | undefined): void {
    this.pendingCompactorSummary = typeof summary === 'string' ? summary.trim() : '';
    if (this.compactor && this.pendingCompactorSummary) {
      this.compactor.restoreSummary(this.pendingCompactorSummary);
    }
  }

  /**
   * Rehydrate a compact working set from saved chat messages. The on-disk
   * transcript remains lossless for the renderer, while the provider gets
   * only recent, protocol-valid evidence within a fixed token budget.
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
    const turns: typeof msgs[] = [];
    let currentTurn: typeof msgs = [];
    for (const message of msgs) {
      if (message.role === 'user' && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(message);
    }
    if (currentTurn.length > 0) turns.push(currentTurn);

    let retainedTokens = 0;
    for (let index = turns.length - 1; index >= 0; index--) {
      const hydrated = this.hydrateSavedTurn(turns[index]);
      if (hydrated.length === 0) continue;
      const turnTokens = estimateMessageTokens(hydrated);
      if (retainedTokens > 0 && retainedTokens + turnTokens > MAX_REHYDRATED_HISTORY_TOKENS) break;
      this.agentHistory.unshift(...hydrated);
      retainedTokens += turnTokens;
    }
  }

  private hydrateSavedTurn(
    messages: Array<{
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
  ): AgentMessage[] {
    const hydrated: AgentMessage[] = [];
    for (const m of messages) {
      const text = (m.content || '').trim();
      if (m.role === 'user') {
        const attachmentNotes = (m.attachments || [])
          .map((a) => `[Previously attached file: ${a.name || 'file'}${a.savedPath ? ` -> ${a.savedPath}` : ''}${a.mime ? ` (${a.mime})` : ''}]`)
          .join('\n');
        const combined = clipHistoryText([text, attachmentNotes].filter(Boolean).join('\n\n'), MAX_REHYDRATED_TEXT_CHARS);
        if (!combined) continue;
        hydrated.push({
          role: 'user',
          parts: [{ type: 'text', text: combined }],
        });
      } else if (m.role === 'assistant') {
        // Retain the newest completed calls from a saved turn. Keeping a call
        // always means keeping its paired result, which preserves provider
        // tool protocol while avoiding replaying an unbounded task trace.
        const completedCalls = (m.toolCalls || [])
          .filter((tc) => tc.id && tc.name && tc.result)
          .slice(-MAX_REHYDRATED_TOOL_RESULTS_PER_TURN);
        const toolParts: AgentContentPart[] = completedCalls
          .map((tc) => ({ type: 'toolUse' as const, id: tc.id, name: tc.name, input: tc.args || {} }));
        if (toolParts.length > 0) {
          hydrated.push({ role: 'assistant', parts: toolParts });
        }
        if (completedCalls.length > 0) {
          hydrated.push({
            role: 'user',
            parts: completedCalls.map((tc) => ({
              type: 'toolResult' as const,
              id: tc.id,
              name: tc.name,
              content: compactToolResultForContext(String(tc.result?.output || '')),
              isError: tc.result?.success === false,
            })),
          });
        }
        if (text) {
          hydrated.push({
            role: 'assistant',
            parts: [{ type: 'text', text: clipHistoryText(text, MAX_REHYDRATED_TEXT_CHARS) }],
          });
        }
      }
    }
    return hydrated;
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
    const compactor = new ContextManager(
      this.config.provider,
      contextWindow,
      tools,
      systemPrompt,
      this.config.maxTokens || this.config.provider.defaultMaxTokens,
    );
    this.compactor = compactor;
    if (this.pendingCompactorSummary) compactor.restoreSummary(this.pendingCompactorSummary);
    let turnCount = 0;
    let streamRetryAttempt = 0;
    let contextOverflowRetryAttempt = 0;
    const retryDelays = [2000, 5000, 10000];

    const maxTurns = this.config.toolRuntime.getBudget().maxTurns;
    while (turnCount < maxTurns && !this.isAborted) {
      turnCount++;
      try { this.config.toolRuntime.beginTurn(); callbacks.onTurnStart?.(turnCount); } catch (error: unknown) { callbacks.onError((error as Error).message); return; }

      // Build messages for this turn
      // iOS-style capacity guard: summarize old history before a request while
      // retaining the last three user turns as verbatim live anchors.
      try {
        this.agentHistory = await compactor.compact(this.agentHistory, (status) => callbacks.onContext(status));
      } catch (error: unknown) {
        const err = error as Error;
        if (this.retryManager.isRetryable(err) && streamRetryAttempt < retryDelays.length && !this.isCancelled) {
          const delayMs = retryDelays[streamRetryAttempt++];
          callbacks.onRetry?.(streamRetryAttempt, delayMs, err.message || 'context compaction interrupted');
          await this.retryManager.sleep(delayMs, this.config.getAbortSignal());
          if (this.isAborted) { callbacks.onCancelled(); return; }
          continue;
        }
        callbacks.onError(err.message || 'Context compaction failed');
        return;
      }
      const messages = [...this.agentHistory];

      try {
        // Stream from provider
        let assistantText = '';
        const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; parseError?: string }> = [];
        let reasoningContent = '';
        let stopReason: AgentStopReason = 'endTurn';
        let usage: LLMUsage | undefined;

        const stream = this.config.provider.streamMessage(
          messages,
          systemPrompt,
          tools,
          this.config.maxTokens || 64000,
          this.config.getAbortSignal(),
        );

        for await (const event of stream) {
          if (this.isAborted) {
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

            case 'reasoningContent':
              reasoningContent += event.content;
              break;

            case 'toolInputDelta':
              callbacks.onToolInputDelta(event.name, event.accumulated, event.id);
              break;

            case 'toolCallComplete':
              toolCalls.push({
                id: event.id,
                name: event.name,
                args: event.args,
                parseError: event.parseError,
              });
              callbacks.onToolCallComplete(event.id, event.name, event.args);
              break;

            case 'usage':
              usage = event.usage;
              callbacks.onUsage(event.usage);
              compactor.recordInputTokens(event.usage.inputTokens);
              this.config.toolRuntime.recordInputTokens(event.usage.inputTokens);
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
          ...(reasoningContent ? { reasoningContent } : {}),
        };
        this.agentHistory.push(assistantMsg);

        // A provider may report `stop`/`endTurn` even when it emitted a
        // function call (notably Gemini and several OpenAI-compatible relays).
        // The presence of a complete call is the authoritative execution
        // signal; do not silently discard it based on stopReason.
        if (toolCalls.length === 0) {
          callbacks.onDone(stopReason);
          return;
        }

        // Execute tools
        const toolResults: AgentContentPart[] = [];
        let toolIndex = 0;
        while (toolIndex < toolCalls.length) {
          if (this.isAborted) {
            callbacks.onCancelled();
            return;
          }
          const first = toolCalls[toolIndex];
          let batchEnd = toolIndex;
          if (this.config.toolRuntime.isParallelSafe(first.name)) {
            while (batchEnd < toolCalls.length && this.config.toolRuntime.isParallelSafe(toolCalls[batchEnd].name)) batchEnd++;
          } else {
            batchEnd++;
          }
          const batch = toolCalls.slice(toolIndex, batchEnd);
          const batchResults = await Promise.all(batch.map(async (tc) => {
            callbacks.onToolExecutionStart?.(tc.id, tc.name, tc.args);
            const result = tc.parseError
              ? { output: `Tool arguments could not be parsed: ${tc.parseError}. The tool was not executed.`, success: false }
              : await this.executeTool(tc.id, tc.name, tc.args);
            callbacks.onToolResult(tc.id, result);
            return { tc, result };
          }));
          for (const { tc, result } of batchResults) {
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
          toolIndex += batch.length;
        }

        // Add tool results as a user message to history
        this.agentHistory.push({
          role: 'user',
          parts: toolResults,
        });

        // Continue so the model can inspect tool results even when the
        // provider used a non-standard stop reason alongside the call.
      } catch (error: unknown) {
        const err = error as Error;
        if (this.isAborted) {
          callbacks.onCancelled();
          return;
        }
        // Harness-style overflow recovery: only retry after a successful,
        // model-visible replacement has reduced the current history.
        if (this.isContextWindowExceededError(err) && contextOverflowRetryAttempt < 1 && !this.isCancelled) {
          const beforeHistory = this.agentHistory;
          try {
            const compacted = await compactor.recover(beforeHistory, (status) => callbacks.onContext(status));
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
        if (this.retryManager.isRetryable(err) && streamRetryAttempt < retryDelays.length && !this.isCancelled) {
          const delayMs = retryDelays[streamRetryAttempt++];
          callbacks.onRetry?.(streamRetryAttempt, delayMs, err.message || 'stream interrupted');
          await this.retryManager.sleep(delayMs, this.config.getAbortSignal());
          if (this.isAborted) { callbacks.onCancelled(); return; }
          continue;
        }
        callbacks.onError(err.message || 'Unknown error in agent loop');
        return;
      }
    }

    // Max turns reached
    if (turnCount >= maxTurns) {
      callbacks.onError(`Reached maximum agent turns (${maxTurns}). The task may be too complex.`);
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
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const signal = this.config.getAbortSignal();
    if (!signal) return { output: 'Tool runtime is not active.', success: false };
    try { return await this.config.toolRuntime.execute(name, args, { signal, sessionId: this.config.sessionId, toolCallId: id, workspaceDir: this.config.workspaceDir }); }
    catch (error: unknown) { return { output: (error as Error).message || 'Tool execution failed.', success: false }; }
  }
}
