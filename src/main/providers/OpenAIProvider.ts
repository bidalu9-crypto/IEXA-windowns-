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
  /** True only after server-side model/endpoint capability validation. */
  private fastMode: boolean;
  private apiMode: 'chat_completions' | 'responses';
  readonly defaultMaxTokens: number = 64000;

  constructor(config: ProviderConfig) {
    this.name = config.name || 'openai';
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || 'https://api.openai.com';
    this.thinkingLevel = config.thinkingLevel || 'medium';
    this.fastMode = config.fastMode === true;
    this.apiMode = config.apiMode === 'responses' ? 'responses' : 'chat_completions';
  }

  async *streamMessage(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens: number = 64000,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    if (this.apiMode === 'responses') {
      yield* this.streamResponses(messages, systemPrompt, tools, maxTokens, signal);
      return;
    }
    yield* this.streamChatCompletions(messages, systemPrompt, tools, maxTokens, signal);
  }

  private async *streamChatCompletions(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens: number = 64000,
    signal?: AbortSignal,
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

    // Codex CLI Fast Mode uses the real wire value `priority`, not `fast`.
    // It is injected only when the session profile explicitly declared endpoint
    // support; unsupported gateways must reject it visibly rather than silently
    // pretending the request ran in Fast mode.
    if (this.fastMode) body.service_tier = 'priority';

    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    // Normalize base URL
    const apiURL = this.apiBaseURL();

    const response = await fetchWithRetry(`${apiURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (this.fastMode && /service[_ ]?tier|priority|tier/i.test(errorText)) {
        throw new Error(`Fast 模式请求被当前模型端点拒绝（service_tier: priority）：${errorText}`);
      }
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

  /** OpenAI Responses API (/v1/responses) serializer + SSE parser.
   * This is a separate wire protocol, not a renamed Chat Completions route. */
  private async *streamResponses(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens: number,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: this.convertResponsesInput(messages),
      stream: true,
      store: false,
      parallel_tool_calls: true,
    };
    if (systemPrompt) body.instructions = systemPrompt;
    if (maxTokens > 0) body.max_output_tokens = maxTokens;
    if (this.fastMode) body.service_tier = 'priority';
    this.applyResponsesThinkingLevel(body);

    const responseTools = this.convertResponsesTools(tools);
    if (responseTools.length) {
      body.tools = responseTools;
      body.tool_choice = 'auto';
    }

    const response = await fetchWithRetry(`${this.apiBaseURL()}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (this.fastMode && /service[_ ]?tier|priority|tier/i.test(errorText)) {
        throw new Error(`Fast 模式请求被当前模型端点拒绝（service_tier: priority）：${errorText}`);
      }
      throw new Error(`OpenAI Responses API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    let startedText = false;
    let emittedDone = false;
    // A completed reasoning item repeats the entire summary after streaming
    // deltas. Retain this flag to use it only as a fallback, not duplicate UI.
    let sawReasoningDelta = false;
    const calls = new Map<string, { id: string; callId: string; name: string; args: string; started: boolean; completed: boolean }>();

    const ensureCall = (item: Record<string, unknown>): { id: string; callId: string; name: string; args: string; started: boolean; completed: boolean } => {
      const id = String(item.item_id || item.id || item.call_id || `response_call_${calls.size}_${Date.now()}`);
      let call = calls.get(id);
      if (!call) {
        call = { id, callId: String(item.call_id || id), name: String(item.name || ''), args: '', started: false, completed: false };
        calls.set(id, call);
      }
      if (typeof item.call_id === 'string') call.callId = item.call_id;
      if (typeof item.name === 'string') call.name = item.name;
      return call;
    };
    const finishCall = async function* (call: { id: string; callId: string; name: string; args: string; started: boolean; completed: boolean }): AsyncGenerator<AgentStreamEvent> {
      if (call.completed || !call.name) return;
      call.completed = true;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.args || '{}'); } catch { /* keep partial stream survivable */ }
      // callId is the Responses protocol link; preserve it as the tool ID for replay.
      yield { type: 'toolCallComplete', id: call.callId, name: call.name, args };
    };

    try {
      while (true) {
        const { done, value } = await readWithTimeout(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        let eventType = '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('event:')) { eventType = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let event: Record<string, any>;
          try { event = JSON.parse(payload); } catch { continue; }
          const type = String(event.type || eventType || '');

          if (type === 'response.output_text.delta') {
            const delta = String(event.delta || '');
            if (delta) {
              if (!startedText) { startedText = true; yield { type: 'contentBlockStart', block: { type: 'text' } }; }
              yield { type: 'textDelta', text: delta };
            }
            continue;
          }
          if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && this.thinkingLevel !== 'off') {
            const delta = String(event.delta || '');
            if (delta) {
              sawReasoningDelta = true;
              yield { type: 'thinkingDelta', text: delta };
            }
            continue;
          }
          if (type === 'response.output_item.added') {
            const item = (event.item || {}) as Record<string, unknown>;
            if (item.type === 'function_call') {
              const call = ensureCall(item);
              if (!call.started && call.name) {
                call.started = true;
                yield { type: 'contentBlockStart', block: { type: 'toolUse', id: call.callId, name: call.name } };
              }
            }
            continue;
          }
          if (type === 'response.function_call_arguments.delta') {
            const call = ensureCall(event);
            const delta = String(event.delta || '');
            call.args += delta;
            if (!call.started && call.name) {
              call.started = true;
              yield { type: 'contentBlockStart', block: { type: 'toolUse', id: call.callId, name: call.name } };
            }
            if (call.name) yield { type: 'toolInputDelta', id: call.callId, name: call.name, accumulated: call.args };
            continue;
          }
          if (type === 'response.function_call_arguments.done') {
            const call = ensureCall(event);
            if (typeof event.arguments === 'string') call.args = event.arguments;
            if (!call.started && call.name) {
              call.started = true;
              yield { type: 'contentBlockStart', block: { type: 'toolUse', id: call.callId, name: call.name } };
            }
            yield* finishCall(call);
            continue;
          }
          if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
            // The done event normally repeats the text emitted by delta frames;
            // use it only when a gateway skipped streaming deltas entirely.
            const text = String(event.text || event.summary || event.delta || '');
            if (text && this.thinkingLevel !== 'off' && !sawReasoningDelta) {
              yield { type: 'thinkingDelta', text };
            }
            continue;
          }
          if (type === 'response.output_item.done') {
            const item = (event.item || {}) as Record<string, unknown>;
            if (item.type === 'reasoning' && this.thinkingLevel !== 'off' && !sawReasoningDelta) {
              const summary = Array.isArray(item.summary)
                ? item.summary.map((part: any) => String(part?.text || '')).filter(Boolean).join('\n')
                : String(item.summary || '');
              if (summary) yield { type: 'thinkingDelta', text: summary };
            }
            if (item.type === 'function_call') {
              const call = ensureCall(item);
              if (typeof item.arguments === 'string') call.args = item.arguments;
              if (!call.started && call.name) {
                call.started = true;
                yield { type: 'contentBlockStart', block: { type: 'toolUse', id: call.callId, name: call.name } };
              }
              yield* finishCall(call);
            }
            continue;
          }
          if (type === 'response.completed') {
            const completed = (event.response || {}) as Record<string, any>;
            const usage = completed.usage || event.usage;
            if (usage) yield { type: 'usage', usage: { inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0), outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0) } };
            for (const call of calls.values()) yield* finishCall(call);
            emittedDone = true;
            yield { type: 'done', stopReason: calls.size ? 'toolUse' : 'endTurn' };
            return;
          }
          if (type === 'error' || type === 'response.failed') {
            const err = event.error || event.response?.error || event;
            throw new Error(String(err?.message || 'Responses stream failed'));
          }
        }
      }
      if (!emittedDone) {
        for (const call of calls.values()) yield* finishCall(call);
        yield { type: 'done', stopReason: calls.size ? 'toolUse' : 'endTurn' };
      }
    } finally { reader.releaseLock(); }
  }

  private apiBaseURL(): string {
    let apiURL = this.baseURL.replace(/\/+$/, '');
    if (!apiURL.endsWith('/v1')) apiURL += '/v1';
    return apiURL;
  }

  private convertResponsesInput(messages: AgentMessage[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const message of messages) {
      const text: string[] = [];
      const images: Record<string, unknown>[] = [];
      const calls: Record<string, unknown>[] = [];
      const outputs: Record<string, unknown>[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') text.push(part.text);
        else if (part.type === 'imageData') images.push({ type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data.toString('base64')}` });
        else if (part.type === 'toolUse') calls.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input) });
        else if (part.type === 'toolResult') outputs.push({ type: 'function_call_output', call_id: part.id, output: part.content });
      }
      if (text.length || images.length) {
        const content: Record<string, unknown>[] = [];
        if (text.length) content.push({ type: message.role === 'user' ? 'input_text' : 'output_text', text: text.join('') });
        content.push(...images);
        result.push({ role: message.role, content });
      }
      result.push(...calls, ...outputs);
    }
    return result;
  }

  private convertResponsesTools(tools: AgentToolDefinition[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      type: 'function', name: tool.name, description: tool.description,
      parameters: { type: 'object', properties: Object.fromEntries(Object.entries(tool.parameters).map(([key, param]) => [key, { type: param.type, description: param.description, ...(param.enumValues ? { enum: param.enumValues } : {}) }])), required: tool.required },
    }));
  }

  private applyResponsesThinkingLevel(body: Record<string, unknown>): void {
    if (this.thinkingLevel === 'off') return;
    const model = this.model.toLowerCase();
    if (!/gpt-5|o[1-9]|reason|codex/.test(model)) return;
    const effort: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', ultra: 'high' };
    // Responses does not stream a displayable reasoning trace by default. Ask
    // for the model-produced summary so the UI can render a thinking block,
    // without exposing the encrypted private chain of thought.
    body.reasoning = { effort: effort[this.thinkingLevel] || 'medium', summary: 'auto' };
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
