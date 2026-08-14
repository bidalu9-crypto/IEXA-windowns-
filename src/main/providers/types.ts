// =============================================================================
// IEXA PC - Core Types
// Mirrors iOS AgentProvider.swift + LLMTypes.swift + ChatModels.swift
// =============================================================================

// MARK: - Agent Messages

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, AgentToolParam>;
  required: string[];
  propertyOrdering?: string[];
}

export interface AgentToolParam {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  enumValues?: string[];
}

export type AgentContentPart =
  | { type: 'text'; text: string }
  | { type: 'toolUse'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'toolResult'; id: string; name: string; content: string; isError: boolean; imageData?: Buffer; imageMimeType?: string; pageURL?: string }
  | { type: 'imageData'; data: Buffer; mimeType: string };

export interface AgentMessage {
  role: 'user' | 'assistant';
  parts: AgentContentPart[];
  isInterrupted?: boolean;
  reasoningContent?: string;
}

export type AgentStopReason = 'endTurn' | 'toolUse' | 'maxTokens' | 'refusal';

// MARK: - Stream Events

export type AgentStreamEvent =
  | { type: 'contentBlockStart'; block: { type: 'text' } | { type: 'toolUse'; id: string; name: string } }
  | { type: 'textDelta'; text: string }
  | { type: 'toolInputDelta'; name: string; accumulated: string; id?: string }
  | { type: 'toolCallComplete'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'reasoningContent'; content: string }
  | { type: 'usage'; usage: LLMUsage }
  | { type: 'done'; stopReason: AgentStopReason };

/** Context capacity state emitted before/after each model request. */
export interface ContextUsage {
  contextWindow: number;
  usedTokens: number;
  estimated: boolean;
  compactThreshold: number;
  state: 'ok' | 'near-limit' | 'compacting' | 'compacted' | 'exhausted';
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

// MARK: - Tool Execution

export interface ToolExecutionResult {
  output: string;
  exitCode?: number;
  success: boolean;
  toolTitle?: string;
  imageData?: Buffer;
  imageMimeType?: string;
  pageURL?: string;
  timedOut?: boolean;
  /** Structured artifact metadata for Codex-style UI rendering. */
  fileChange?: {
    path: string;
    before: string;
    after: string;
    added: number;
    removed: number;
  };
  artifacts?: Array<{
    kind: 'image' | 'audio' | 'video' | 'file';
    path: string;
    mimeType: string;
    size: number;
    url?: string;
  }>;
}

// MARK: - Provider Configuration

export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'xai' | 'deepseek' | 'custom';

export interface ProviderConfig {
  type: ProviderType;
  name: string;
  apiKey: string;
  baseURL?: string;
  model: string;
  maxTokens?: number;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

// MARK: - Agent Loop Types

export interface StreamResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  stopReason: AgentStopReason;
  usage?: LLMUsage;
  reasoningContent?: string;
}

export interface AgentLoopCallbacks {
  onTextDelta: (text: string, fullText: string) => void;
  onThinkingDelta: (text: string) => void;
  onToolCallStart: (id: string, name: string) => void;
  onToolInputDelta: (name: string, accumulated: string, id?: string) => void;
  onToolCallComplete: (id: string, name: string, args: Record<string, unknown>) => void;
  /** Model has finished emitting the call and the executor is about to start it. */
  onToolExecutionStart?: (id: string, name: string, args: Record<string, unknown>) => void;
  onToolResult: (id: string, result: ToolExecutionResult) => void;
  /** A transient provider/stream failure is being retried on the same model. */
  onRetry?: (attempt: number, delayMs: number, error: string) => void;
  onUsage: (usage: LLMUsage) => void;
  onContext: (context: ContextUsage) => void;
  onError: (error: string) => void;
  onDone: (stopReason: AgentStopReason) => void;
  onCancelled: () => void;
}
