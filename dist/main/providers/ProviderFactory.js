"use strict";
// =============================================================================
// iExA PC - Provider Factory
// Mirrors iOS ProviderFactory.swift + LLMProviderFactory
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderFactory = void 0;
const AnthropicProvider_1 = require("./AnthropicProvider");
const OpenAIProvider_1 = require("./OpenAIProvider");
const GeminiProvider_1 = require("./GeminiProvider");
const ModelCapabilities_1 = require("./ModelCapabilities");
class ProviderFactory {
    static create(config) {
        const effectiveConfig = {
            ...config,
            thinkingLevel: (0, ModelCapabilities_1.clampThinkingLevel)(config.thinkingLevel || 'off', config.type, config.model),
        };
        switch (config.type) {
            case 'anthropic':
                return new AnthropicProvider_1.AnthropicProvider(effectiveConfig);
            case 'openai':
                return new OpenAIProvider_1.OpenAIProvider(effectiveConfig);
            case 'openrouter':
                return new OpenAIProvider_1.OpenAIProvider({
                    ...effectiveConfig,
                    baseURL: 'https://openrouter.ai/api/v1',
                    name: 'openrouter',
                });
            case 'xai':
                return new OpenAIProvider_1.OpenAIProvider({
                    ...effectiveConfig,
                    baseURL: 'https://api.x.ai/v1',
                    name: 'xai',
                });
            case 'deepseek':
                return new OpenAIProvider_1.OpenAIProvider({
                    ...effectiveConfig,
                    baseURL: 'https://api.deepseek.com/v1',
                    name: 'deepseek',
                });
            case 'custom':
                // User provides baseURL — fall back to a sensible default if missing
                return new OpenAIProvider_1.OpenAIProvider({
                    ...effectiveConfig,
                    baseURL: config.baseURL || 'https://api.openai.com/v1',
                    name: 'custom',
                });
            case 'gemini':
                return new GeminiProvider_1.GeminiProvider(effectiveConfig);
            default:
                throw new Error(`Unknown provider type: ${config.type}`);
        }
    }
}
exports.ProviderFactory = ProviderFactory;
//# sourceMappingURL=ProviderFactory.js.map