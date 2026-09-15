// =============================================================================
// IEXA PC - Provider Factory
// Mirrors iOS ProviderFactory.swift + LLMProviderFactory
// =============================================================================

import { ProviderConfig, AgentMessage, AgentToolDefinition, AgentStreamEvent } from './types';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { GeminiProvider } from './GeminiProvider';
import { clampThinkingLevel } from './ModelCapabilities';

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly defaultMaxTokens: number;
  streamMessage(
    messages: AgentMessage[],
    systemPrompt: string,
    tools: AgentToolDefinition[],
    maxTokens?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent>;
}

export class ProviderFactory {
  static create(config: ProviderConfig): LLMProvider {
    const effectiveConfig = {
      ...config,
      thinkingLevel: clampThinkingLevel(config.thinkingLevel || 'off', config.type, config.model),
    };
    switch (config.type) {
      case 'anthropic':
        return new AnthropicProvider(effectiveConfig);
      case 'openai':
        return new OpenAIProvider(effectiveConfig);
      case 'openrouter':
        return new OpenAIProvider({
          ...effectiveConfig,
          baseURL: 'https://openrouter.ai/api/v1',
          name: 'openrouter',
        });
      case 'xai':
        return new OpenAIProvider({
          ...effectiveConfig,
          baseURL: 'https://api.x.ai/v1',
          name: 'xai',
        });
      case 'deepseek':
        return new OpenAIProvider({
          ...effectiveConfig,
          baseURL: 'https://api.deepseek.com/v1',
          name: 'deepseek',
        });
      case 'custom':
        // User provides baseURL — fall back to a sensible default if missing
        return new OpenAIProvider({
          ...effectiveConfig,
          baseURL: config.baseURL || 'https://api.openai.com/v1',
          name: 'custom',
        });
      case 'gemini':
        return new GeminiProvider(effectiveConfig);
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }
}
