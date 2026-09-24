import { readDiagnosticResponse } from '../encoding/DiagnosticDecoder';
import { ProviderError } from './ProviderError';
// =============================================================================
// IEXA PC - Anthropic Provider
// Mirrors iOS AnthropicAgentProvider.swift + AnthropicProvider.swift
// Uses Anthropic Messages API with SSE streaming
// =============================================================================

import { AgentMessage, AgentToolDefinition, AgentStreamEvent, AgentStopReason, LLMUsage, ProviderConfig, toolParamSchema } from './types';
import { fetchWithRetry, readSSEFrames } from './stream-utils';

export class AnthropicProvider {
  readonly name: string;
  readonly model: string;
  private apiKey: string;
  private userAgent?: string;
  private baseURL: string;
  private thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly defaultMaxTokens: number = 64000;

  constructor(config: ProviderConfig) {
    this.name = 'anthropic';
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.userAgent = config.userAgent;
    this.baseURL = (config.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.thinkingLevel = config.thinkingLevel || 'medium';
  }

  async *streamMessage(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens: number = 64000,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    const anthropicMessages = this.convertMessages(messages);
    const anthropicTools = this.convertTools(tools);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      tools: anthropicTools,
      stream: true,
    };

    if (systemPrompt) {
      body.system = [{ type: 'text', text: systemPrompt }];
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
    // Claude 4.6+ and 5.x use adaptive thinking; the old budget_tokens
    // option is incompatible with these models. No beta header is required
    // for the GA Messages API or tool use.
    const model = this.model.toLowerCase();
    const adaptive = /^claude-(?:opus|sonnet)-(?:[5-9](?:-|$)|4-(?:[6-9]|[1-9][0-9])(?:-|$))/.test(model);
    if (adaptive) {
      const opus55 = /^claude-opus-5-5(?:-|$)/.test(model);
      const xhighSupported = /^claude-(?:opus-(?:[5-9]|4-[7-9])|sonnet-[5-9])(?:-|$)/.test(model);
      // Opus 5.5 thinking is always on. `off` selects its lowest effort;
      // omitting the thinking field uses the model's adaptive default.
      if (!opus55 && this.thinkingLevel !== 'off') body.thinking = { type: 'adaptive' };
      if (opus55 || this.thinkingLevel !== 'off') {
        const effort = this.thinkingLevel === 'off' || this.thinkingLevel === 'low' ? 'low'
          : this.thinkingLevel === 'medium' ? 'medium'
            : this.thinkingLevel === 'xhigh' ? (xhighSupported ? 'xhigh' : 'high')
              : this.thinkingLevel === 'max' || this.thinkingLevel === 'ultra' ? 'max' : 'high';
        body.output_config = { effort };
      }
    } else if (this.thinkingLevel !== 'off') {
      const budgets: Record<string, number> = {
        low: 4096, medium: 8192, high: 16384,
        xhigh: 32768, max: 32768, ultra: 32768,
      };
      // Legacy extended thinking requires budget_tokens >= 1024 and
      // strictly less than max_tokens; do not silently exceed the caller's cap.
      const budget = Math.min(budgets[this.thinkingLevel], maxTokens - 1);
      if (budget >= 1024) body.thinking = { type: 'enabled', budget_tokens: budget };
    }

    const endpoint = /\/v1\/messages$/i.test(this.baseURL) ? this.baseURL
      : /\/v1$/i.test(this.baseURL) ? `${this.baseURL}/messages` : `${this.baseURL}/v1/messages`;
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      userAgent: this.userAgent,
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await readDiagnosticResponse(response);
      throw ProviderError.http(response.status, errorText, 'Anthropic');
    }

    // Some Anthropic-compatible gateways return a complete Messages JSON
    // response even when stream:true was requested. Accept valid responses,
    // while surfacing JSON error payloads instead of a misleading SSE EOF.
    if (/application\/json/i.test(response.headers.get('content-type') || '')) {
      const raw = await readDiagnosticResponse(response);
      let message: any;
      try { message = JSON.parse(raw); } catch {
        throw new ProviderError('INVALID_RESPONSE', 'Anthropic endpoint returned malformed JSON', false);
      }
      ProviderError.throwIfErrorFrame(message);
      if (message.type !== 'message' || !Array.isArray(message.content)) {
        throw new ProviderError('INVALID_RESPONSE', 'Anthropic endpoint returned JSON instead of a Messages response', false);
      }
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          yield { type: 'textDelta', text: block.text };
        } else if (block.type === 'thinking') {
          if (block.thinking && this.thinkingLevel !== 'off') yield { type: 'thinkingDelta', text: block.thinking };
          if (block.thinking) yield { type: 'reasoningContent', content: block.thinking };
          if (block.signature) yield { type: 'thinkingBlockComplete', block: { type: 'thinking', thinking: block.thinking || '', signature: block.signature } };
        } else if (block.type === 'redacted_thinking' && block.data) {
          yield { type: 'thinkingBlockComplete', block: { type: 'redacted_thinking', data: block.data } };
        } else if (block.type === 'tool_use') {
          yield { type: 'toolCallComplete', id: block.id, name: block.name, args: block.input || {} };
        }
      }
      yield { type: 'usage', usage: { inputTokens: message.usage?.input_tokens || 0, outputTokens: message.usage?.output_tokens || 0 } };
      yield { type: 'done', stopReason: message.stop_reason === 'tool_use' ? 'toolUse'
        : message.stop_reason === 'max_tokens' ? 'maxTokens'
          : message.stop_reason === 'refusal' ? 'refusal' : 'endTurn' };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let currentToolId: string | null = null;
    let currentToolName: string | null = null;
    let currentToolArgs = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningContent = '';
    let emittedReasoningContent = false;
    let currentThinking: { thinking: string; signature: string } | null = null;
    let stopReason: AgentStopReason = 'endTurn';

    try {
      for await (const frame of readSSEFrames(reader, signal)) {
          const data = frame.data;

          if (data === '[DONE]') {
            yield { type: 'done', stopReason: 'endTurn' as AgentStopReason };
            return;
          }

          try {
            const event = JSON.parse(data);
            ProviderError.throwIfErrorFrame(event, frame.event);

            switch (event.type) {
              case 'message_start':
                if (event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens || 0;
                  outputTokens = event.message.usage.output_tokens || 0;
                }
                break;

              case 'content_block_start': {
                const block = event.content_block;
                if (block.type === 'text') {
                  yield { type: 'contentBlockStart', block: { type: 'text' } };
                } else if (block.type === 'thinking') {
                  currentThinking = { thinking: block.thinking || '', signature: block.signature || '' };
                } else if (block.type === 'redacted_thinking') {
                  if (block.data) yield { type: 'thinkingBlockComplete', block: { type: 'redacted_thinking', data: block.data } };
                } else if (block.type === 'tool_use') {
                  currentToolId = block.id;
                  currentToolName = block.name;
                  currentToolArgs = '';
                  yield { type: 'contentBlockStart', block: { type: 'toolUse', id: block.id, name: block.name } };
                }
                break;
              }

              case 'content_block_delta': {
                const delta = event.delta;
                if (delta.type === 'text_delta') {
                  yield { type: 'textDelta', text: delta.text };
                } else if (delta.type === 'input_json_delta') {
                  currentToolArgs += delta.partial_json || '';
                  yield {
                    type: 'toolInputDelta',
                    name: currentToolName || '',
                    accumulated: currentToolArgs,
                    id: currentToolId || undefined,
                  };
                } else if (delta.type === 'signature_delta') {
                  if (currentThinking) currentThinking.signature += delta.signature || '';
                } else if (delta.type === 'thinking_delta' && this.thinkingLevel !== 'off') {
                  if (currentThinking) currentThinking.thinking += delta.thinking || '';
                  reasoningContent += delta.thinking || '';
                  yield { type: 'thinkingDelta', text: delta.thinking };
                } else if (delta.type === 'thinking_delta') {
                  if (currentThinking) currentThinking.thinking += delta.thinking || '';
                  reasoningContent += delta.thinking || '';
                }
                break;
              }

              case 'content_block_stop': {
                if (currentThinking) {
                  if (currentThinking.signature) {
                    yield { type: 'thinkingBlockComplete', block: { type: 'thinking', ...currentThinking } };
                  }
                  currentThinking = null;
                }
                // Finalize tool_use so AgentLoop can execute it (iOS toolCallComplete).
                if (currentToolId && currentToolName) {
                  let args: Record<string, unknown> = {};
                  let parseError: string | undefined;
                  try {
                    const parsed = currentToolArgs ? JSON.parse(currentToolArgs) : {};
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be a JSON object');
                    args = parsed as Record<string, unknown>;
                  } catch (error: unknown) {
                    parseError = (error as Error).message || 'invalid JSON';
                  }
                  yield {
                    type: 'toolCallComplete',
                    id: currentToolId,
                    name: currentToolName,
                    args,
                    ...(parseError ? { parseError } : {}),
                  };
                }
                currentToolId = null;
                currentToolName = null;
                currentToolArgs = '';
                break;
              }

              case 'message_delta': {
                if (event.usage) {
                  outputTokens = event.usage.output_tokens || outputTokens;
                }
                const reason = event.delta?.stop_reason || 'end_turn';
                if (reason === 'tool_use') stopReason = 'toolUse';
                else if (reason === 'max_tokens') stopReason = 'maxTokens';
                else if (reason === 'refusal') stopReason = 'refusal';

                yield {
                  type: 'usage',
                  usage: { inputTokens, outputTokens },
                };
                if (reasoningContent && !emittedReasoningContent) {
                  emittedReasoningContent = true;
                  yield { type: 'reasoningContent', content: reasoningContent };
                }
                break;
              }

              case 'message_stop':
                yield { type: 'done', stopReason };
                return;

              case 'error': {
                throw new Error(`Anthropic error: ${event.error?.message || 'Unknown error'}`);
              }
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue; // Skip unparseable lines
            throw e;
          }
      }
      throw new ProviderError('STREAM_TERMINATED', 'Provider stream terminated before completion', true);
    } finally {
      reader.releaseLock();
    }
  }

  private convertMessages(messages: AgentMessage[]): Record<string, unknown>[] {
    return messages.map((msg) => {
      // Anthropic requires the exact signed thinking blocks before tool_use
      // when returning tool results in an extended-thinking conversation.
      const content: Record<string, unknown>[] = msg.role === 'assistant'
        ? [...(msg.thinkingBlocks || [])] : [];

      for (const part of msg.parts) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'toolUse') {
          content.push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.input,
          });
        } else if (part.type === 'toolResult') {
          content.push({
            type: 'tool_result' as const,
            tool_use_id: part.id,
            content: part.content,
            is_error: part.isError,
          });
        } else if (part.type === 'imageData') {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mimeType,
              data: part.data.toString('base64'),
            },
          });
        }
      }

      return {
        role: msg.role,
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      };
    });
  }

  private convertTools(tools: AgentToolDefinition[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, param]) => [
            key,
            toolParamSchema(param),
          ])
        ),
        required: tool.required,
      },
    }));
  }
}
