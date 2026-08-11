// =============================================================================
// IEXA PC - Anthropic Provider
// Mirrors iOS AnthropicAgentProvider.swift + AnthropicProvider.swift
// Uses Anthropic Messages API with SSE streaming
// =============================================================================

import { AgentMessage, AgentToolDefinition, AgentStreamEvent, AgentStopReason, LLMUsage, ProviderConfig } from './types';
import { fetchWithRetry, readWithTimeout } from './stream-utils';

export class AnthropicProvider {
  readonly name: string;
  readonly model: string;
  private apiKey: string;
  private baseURL: string;
  private thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly defaultMaxTokens: number = 64000;

  constructor(config: ProviderConfig) {
    this.name = 'anthropic';
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || 'https://api.anthropic.com';
    this.thinkingLevel = config.thinkingLevel || 'medium';
  }

  async *streamMessage(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens: number = 64000,
  ): AsyncGenerator<AgentStreamEvent> {
    const anthropicMessages = this.convertMessages(messages);
    const anthropicTools = this.convertTools(tools);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      tools: anthropicTools,
    };

    if (systemPrompt) {
      body.system = [{ type: 'text', text: systemPrompt }];
    }

    // Extended thinking (iOS-style levels → budget_tokens)
    const thinkingBudgets: Record<string, number> = {
      off: 0,
      low: 4096,
      medium: 8192,
      high: 16384,
      xhigh: 32768,
      max: 32768,
      ultra: 32768,
    };
    const thinkBudget = thinkingBudgets[this.thinkingLevel] ?? 8000;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024-04-04',
    };
    if (thinkBudget > 0) {
      // budget must be < max_tokens
      const budget = Math.min(thinkBudget, Math.max(1024, maxTokens - 1));
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Ensure max_tokens > budget_tokens
      if (typeof body.max_tokens === 'number' && (body.max_tokens as number) <= budget) {
        body.max_tokens = budget + 4096;
      }
      headers['anthropic-beta'] = 'tools-2024-04-04,interleaved-thinking-2025-05-14';
    }

    const response = await fetchWithRetry(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolId: string | null = null;
    let currentToolName: string | null = null;
    let currentToolArgs = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await readWithTimeout(reader);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);

          if (data === '[DONE]') {
            yield { type: 'done', stopReason: 'endTurn' as AgentStopReason };
            return;
          }

          try {
            const event = JSON.parse(data);

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
                } else if (delta.type === 'thinking_delta') {
                  yield { type: 'thinkingDelta', text: delta.thinking };
                }
                break;
              }

              case 'content_block_stop': {
                // Finalize tool_use so AgentLoop can execute it (iOS toolCallComplete).
                if (currentToolId && currentToolName) {
                  let args: Record<string, unknown> = {};
                  try { args = currentToolArgs ? JSON.parse(currentToolArgs) : {}; } catch { /* partial */ }
                  yield {
                    type: 'toolCallComplete',
                    id: currentToolId,
                    name: currentToolName,
                    args,
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
                const stopReason = event.delta?.stop_reason || 'end_turn';

                let agentStopReason: AgentStopReason = 'endTurn';
                if (stopReason === 'tool_use') agentStopReason = 'toolUse';
                else if (stopReason === 'max_tokens') agentStopReason = 'maxTokens';
                else if (stopReason === 'refusal') agentStopReason = 'refusal';

                yield {
                  type: 'usage',
                  usage: { inputTokens, outputTokens },
                };
                yield { type: 'done', stopReason: agentStopReason };
                return;
              }

              case 'error': {
                throw new Error(`Anthropic error: ${event.error?.message || 'Unknown error'}`);
              }
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue; // Skip unparseable lines
            throw e;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private convertMessages(messages: AgentMessage[]): Record<string, unknown>[] {
    return messages.map((msg) => {
      const content: Record<string, unknown>[] = [];

      // Collect tool results for batch injection
      const toolResults: Array<{
        tool_use_id: string;
        type: 'tool_result';
        content: string;
        is_error?: boolean;
      }> = [];

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
          toolResults.push({
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

      // Add tool results to content
      for (const tr of toolResults) {
        const tc: Record<string, unknown> = { ...tr };
        content.push(tc);
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
            {
              type: param.type,
              description: param.description,
              ...(param.enumValues ? { enum: param.enumValues } : {}),
            },
          ])
        ),
        required: tool.required,
      },
    }));
  }
}
