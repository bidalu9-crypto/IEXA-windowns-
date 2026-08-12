// =============================================================================
// IEXA PC - OpenAI Provider
// Mirrors iOS OpenAIProvider.swift + OpenAIAgentProvider.swift
// Uses OpenAI Chat Completions API with SSE streaming + tool calls
// =============================================================================

import { AgentMessage, AgentToolDefinition, AgentStreamEvent, AgentStopReason, LLMUsage, ProviderConfig } from './types';
import { fetchWithRetry, readWithTimeout } from './stream-utils';

export class OpenAIProvider {
  readonly name: string;
  readonly model: string;
  private apiKey: string;
  private baseURL: string;
  private thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly defaultMaxTokens: number = 64000;

  constructor(config: ProviderConfig) {
    this.name = config.name || 'openai';
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || 'https://api.openai.com';
    this.thinkingLevel = config.thinkingLevel || 'medium';
  }

  async *streamMessage(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens: number = 64000,
  ): AsyncGenerator<AgentStreamEvent> {
    const openaiMessages = this.convertMessages(messages, systemPrompt);
    const openaiTools = this.convertTools(tools);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // iOS-style thinking / reasoning effort for OpenAI-compatible APIs
    // (o-series, GPT-5, Grok reasoning, many Chinese reverse proxies)
    this.applyThinkingLevel(body);

    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    // Normalize base URL
    let apiURL = this.baseURL;
    if (!apiURL.endsWith('/v1')) {
      apiURL = apiURL.replace(/\/+$/, '') + '/v1';
    }

    const response = await fetchWithRetry(`${apiURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
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
    let startedText = false;
    // Wait for the terminal [DONE]/stream close: usage may arrive after the
    // chunk that contains finish_reason.
    let pendingStopReason: AgentStopReason | null = null;

    // Track tool calls by index
    const toolCalls: Map<number, { id: string; name: string; args: string; started: boolean }> = new Map();

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
            yield { type: 'done', stopReason: pendingStopReason || 'endTurn' };
            return;
          }

          try {
            const event = JSON.parse(data);

            // OpenAI-compatible APIs commonly put cumulative usage in the final
            // SSE frame with an empty `choices` array. Process usage before
            // ignoring non-content frames so it reaches the persistent ledger.
            if (event.usage) {
              inputTokens = event.usage.prompt_tokens || event.usage.input_tokens || 0;
              outputTokens = event.usage.completion_tokens || event.usage.output_tokens || 0;
              yield { type: 'usage', usage: { inputTokens, outputTokens } };
            }

            const choice = event.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta || {};

            // Handle tool calls — emit contentBlockStart ASAP so UI shows a live step
            // (mirrors iOS ToolCapsule / contentBlockStart.toolUse behaviour).
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCalls.has(idx)) {
                  const provisionalId = tc.id || ('openai_tool_' + idx + '_' + Date.now());
                  toolCalls.set(idx, {
                    id: provisionalId,
                    name: tc.function?.name || '',
                    args: '',
                    started: false,
                  });
                }
                const entry = toolCalls.get(idx)!;
                // Freeze id after the live step is created so UI can bind continuously.
                if (tc.id && !entry.started) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;

                // Fire start once we know the tool name
                if (!entry.started && entry.name) {
                  entry.started = true;
                  yield {
                    type: 'contentBlockStart',
                    block: { type: 'toolUse', id: entry.id, name: entry.name },
                  };
                }

                if (tc.function?.arguments) {
                  entry.args += tc.function.arguments;
                  if (!entry.started && entry.name) {
                    entry.started = true;
                    yield {
                      type: 'contentBlockStart',
                      block: { type: 'toolUse', id: entry.id, name: entry.name },
                    };
                  }
                  if (entry.name) {
                    yield {
                      type: 'toolInputDelta',
                      name: entry.name,
                      accumulated: entry.args,
                      id: entry.id,
                    };
                  }
                }
              }
            }

            // Reasoning / thinking deltas (OpenAI o-series, DeepSeek-R1, Grok, proxies)
            const reasoningText =
              (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
              (typeof delta.reasoning === 'string' && delta.reasoning) ||
              (typeof delta.thinking === 'string' && delta.thinking) ||
              '';
            // Some OpenAI-compatible gateways emit reasoning_content even when
            // their disable flag is ignored. "off" is a local hard boundary:
            // never forward that stream to the application/UI.
            if (reasoningText && this.thinkingLevel !== 'off') {
              yield { type: 'thinkingDelta', text: reasoningText };
            }

            // Handle text content
            if (delta.content) {
              if (!startedText) {
                startedText = true;
                yield { type: 'contentBlockStart', block: { type: 'text' } };
              }
              yield { type: 'textDelta', text: delta.content };
            }

            // Handle finish
            if (choice.finish_reason) {
              if (choice.finish_reason === 'tool_calls') {
                // Emit toolCallComplete for each completed tool call
                for (const [, entry] of toolCalls) {
                  if (entry.id && entry.name) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(entry.args); } catch { /* partial JSON */ }
                    yield { type: 'toolCallComplete', id: entry.id, name: entry.name, args };
                  }
                }
              }

              // Do not end the generator here. With `include_usage`, many
              // OpenAI-compatible APIs send usage in the following empty-choice
              // SSE frame. It is handled above before this stream terminates.
              pendingStopReason = 'endTurn';
              if (choice.finish_reason === 'tool_calls') pendingStopReason = 'toolUse';
              else if (choice.finish_reason === 'length') pendingStopReason = 'maxTokens';
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      // Gracefully handle providers that close the stream without [DONE].
      if (pendingStopReason) yield { type: 'done', stopReason: pendingStopReason };
    } finally {
      reader.releaseLock();
    }
  }

  private convertMessages(
    messages: AgentMessage[],
    systemPrompt: string,
  ): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    // System message
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        const contentParts: Record<string, unknown>[] = [];
        const toolResults: Array<{ tool_call_id: string; role: 'tool'; content: string }> = [];

        for (const part of msg.parts) {
          if (part.type === 'text') {
            contentParts.push({ type: 'text', text: part.text });
          } else if (part.type === 'toolResult') {
            toolResults.push({
              role: 'tool',
              tool_call_id: part.id,
              content: part.content,
            });
          } else if (part.type === 'imageData') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.mimeType};base64,${part.data.toString('base64')}`,
              },
            });
          }
        }

        if (contentParts.length > 0) {
          result.push({ role: 'user', content: contentParts });
        }

        for (const tr of toolResults) {
          result.push(tr);
        }
      } else if (msg.role === 'assistant') {
        // Build assistant message with potential tool_calls
        const contentParts: string[] = [];
        const toolCalls: Record<string, unknown>[] = [];

        for (const part of msg.parts) {
          if (part.type === 'text') {
            contentParts.push(part.text);
          } else if (part.type === 'toolUse') {
            toolCalls.push({
              id: part.id,
              type: 'function',
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input),
              },
            });
          }
        }

        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: contentParts.join('') || null,
        };

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }

        result.push(assistantMsg);
      }
    }

    return result;
  }

  private applyThinkingLevel(body: Record<string, unknown>): void {
    const level = this.thinkingLevel || 'medium';
    const model = (this.model || '').toLowerCase();
    const provider = (this.name || '').toLowerCase();

    // Only attach effort params on models/providers that actually reason.
    // Avoid breaking plain GPT-4 / chat models that reject unknown fields.
    const isReasoningModel =
      /^o[1-9]/.test(model) ||
      model.includes('gpt-5') ||
      model.includes('o3') ||
      model.includes('o4-mini') ||
      model.includes('reason') ||
      model.includes('thinking') ||
      model.includes('r1') ||
      model.includes('grok') ||
      model.includes('qwq') ||
      model.includes('deepseek') ||
      provider === 'xai' ||
      provider === 'deepseek';

    if (!isReasoningModel) return;

    const budgetMap: Record<string, number> = {
      off: 0,
      low: 1024,
      medium: 8192,
      high: 16384,
      xhigh: 32768,
      max: 32768,
      ultra: 32768,
    };
    const budget = budgetMap[level] ?? 8192;

    if (level === 'off') {
      if (model.includes('deepseek') || model.includes('r1') || model.includes('think') || provider === 'deepseek') {
        // DeepSeek-compatible Chat Completions gateways use this field. Do not
        // attach a positive reasoning_effort in the off state.
        body.enable_thinking = false;
      } else {
        body.reasoning_effort = 'none';
      }
      return;
    }

    // OpenAI / xAI / many gateways
    // iOS uses seven local levels; Ultra is a client label and maps to max on wire.
    body.reasoning_effort = level === 'ultra' || level === 'max' ? 'max' : level; // low | medium | high | xhigh | max

    // DeepSeek-R1 style proxies
    if (model.includes('deepseek') || model.includes('r1') || model.includes('think') || provider === 'deepseek') {
      body.enable_thinking = true;
      body.thinking_budget = budget;
    }
  }

  private convertTools(tools: AgentToolDefinition[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
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
      },
    }));
  }
}
