export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/** Match GPT family ids (including GPT-6 Astra), provider-prefixed and dated aliases.
 * Deliberately avoid GPT-4/4o and other chat-only families. */
export declare function isGptReasoningModel(model: string): boolean;
/** Backward-compatible named matcher for existing call sites. */
export declare function isGpt6AstraModel(model: string): boolean;
/** Match GLM 5.3 Flash and the common transposed `falsh` catalog alias. */
export declare function isGlm53FlashModel(model: string): boolean;
export type VisionCapability = 'auto' | 'native' | 'text';
/** Shared native-vision gate used by attachment routing and profile metadata. */
export declare function modelLikelySupportsVision(provider: string, model: string): boolean;
/** Explicit per-profile capability overrides heuristics for private gateway aliases. */
export declare function modelSupportsVision(provider: string, model: string, capability?: VisionCapability): boolean;
/** Native image input wins; a separately configured profile is a fallback for text-only chats. */
export declare function shouldUseVisionProxy(activeProvider: string, activeModel: string, hasVisionProfile: boolean, sameProfile: boolean, capability?: VisionCapability): boolean;
/** Conservative model-id capability registry. Unknown models stay off so a
 * gateway is never sent unsupported reasoning fields by guesswork. */
export declare function maxThinkingLevel(provider: string, model: string): ThinkingLevel;
export declare function clampThinkingLevel(level: string, provider: string, model: string): ThinkingLevel;
export type ThinkingWire = 'levels' | 'model-decides' | 'unsupported';
/**
 * Whether a chosen level reaches the model at all.
 *
 * The selector used to show seven steps for every model, so a level could look
 * selected while the provider sent nothing. This mirrors each provider's actual
 * request builder:
 *   levels        — the level is serialised into the request
 *   model-decides — the provider sends no level; the model picks its own depth
 *   unsupported   — the model has no reasoning mode, so the control is inert
 */
export declare function thinkingWire(provider: string, model: string): ThinkingWire;
//# sourceMappingURL=ModelCapabilities.d.ts.map