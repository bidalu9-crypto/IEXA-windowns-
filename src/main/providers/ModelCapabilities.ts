export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const ORDER: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Match GPT family ids (including GPT-6 Astra), provider-prefixed and dated aliases.
 * Deliberately avoid GPT-4/4o and other chat-only families. */
export function isGptReasoningModel(model: string): boolean {
  const id = String(model || '').toLowerCase().replace(/[._]/g, '-');
  // GPT-5+ reasoning capability is a family contract, not an Astra-only suffix.
  const family = id.match(/(?:^|[/:-])(gpt-?(?:[5-9]|[1-9][0-9]+)(?:-[a-z0-9]+)*)(?:$|[/:-])/);
  if (!family) return false;
  // GPT-6+ variants are treated uniformly; retain only the known GPT-5
  // chat-only exclusions so ordinary GPT-5 chat aliases stay unchanged.
  return !/(?:^|[/:-])gpt-5-(?:chat|mini|nano|codex)(?:$|[/:-])/.test(id);
}

/** Backward-compatible named matcher for existing call sites. */
export function isGpt6AstraModel(model: string): boolean {
  const id = String(model || '').toLowerCase().replace(/[._]/g, '-');
  return /(?:^|[/:-])gpt-6-astra(?:$|[/:-])/.test(id);
}

/** Match GLM 5.3 Flash and the common transposed `falsh` catalog alias. */
export function isGlm53FlashModel(model: string): boolean {
  const id = String(model || '').toLowerCase().replace(/[._]/g, '-');
  return /(?:^|[/:-])glm-5-3-(?:flash|falsh)(?:$|[/:-])/.test(id);
}

export type VisionCapability = 'auto' | 'native' | 'text';

/** Shared native-vision gate used by attachment routing and profile metadata. */
export function modelLikelySupportsVision(provider: string, model: string): boolean {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  return p === 'anthropic' || p === 'gemini' || isGpt6AstraModel(m) || isGlm53FlashModel(m) ||
    /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|vl|llava|qwen2\.5-vl|qwen3-vl/.test(m);
}

/** Explicit per-profile capability overrides heuristics for private gateway aliases. */
export function modelSupportsVision(provider: string, model: string, capability: VisionCapability = 'auto'): boolean {
  if (capability === 'native') return true;
  if (capability === 'text') return false;
  return modelLikelySupportsVision(provider, model);
}

/** Native image input wins; a separately configured profile is a fallback for text-only chats. */
export function shouldUseVisionProxy(
  activeProvider: string,
  activeModel: string,
  hasVisionProfile: boolean,
  sameProfile: boolean,
  capability: VisionCapability = 'auto',
): boolean {
  return hasVisionProfile && !sameProfile && !modelSupportsVision(activeProvider, activeModel, capability);
}

/** Conservative model-id capability registry. Unknown models stay off so a
 * gateway is never sent unsupported reasoning fields by guesswork. */
export function maxThinkingLevel(provider: string, model: string): ThinkingLevel {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase().replace(/[._]/g, '-');
  // DeepSeek V4 is the one DeepSeek generation whose gateway takes a level: it
  // sends `thinking` plus `reasoning_effort`, collapsing low/medium to `high`
  // and everything above to `max`. Pre-V4 DeepSeek ignores the field entirely,
  // so capping V4 at `high` (as the generic DeepSeek branch below does) hides
  // the only setting that actually reaches the model.
  if (m.includes('deepseek-v4')) return 'max';
  const gpt6Model = m.match(/(?:^|[/:-])gpt-?6-(astra|sol|luna)(?:$|[/:-])/);
  if (gpt6Model) return gpt6Model[1] === 'astra' ? 'xhigh' : 'max';
  if (isGptReasoningModel(m)) return /gpt-5-6/.test(m) ? 'max' : 'xhigh';
  if (isGlm53FlashModel(m)) return 'high';
  // Current Claude families use adaptive thinking; keep the UI control visible.
  if (p === 'anthropic' && /(?:^|[/:-])claude-(?:opus|sonnet)-(?:[5-9]|4-[6-9])(?:-|$)/.test(m)) return 'max';
  const knownDeepSeekThinkingModel =
    /(^|[/:-])deepseek-(?:chat|reasoner|r1)(?:[/:-]|$)/.test(m) ||
    /(^|[/:-])deepseek-ai[/:-]deepseek-(?:r1|v3)(?:[/:-]|$)/.test(m) ||
    m.includes('deepseek-v4');
  // iOS explicitly allows xAI/OpenRouter-compatible reasoning models even
  // when the model catalog does not annotate the id with "reasoning".
  if (p === 'xai' || /(^|-)grok(?:-|$)/.test(m)) return 'xhigh';
  if (knownDeepSeekThinkingModel || /reasoner|qwq|qwen3-thinking|(^|-)o[1-9](?:-|$)|gpt-5|grok.*reason|claude-3-7|claude-4/.test(m) || (/thinking/.test(m) && !m.includes('deepseek')) || (p === 'deepseek' && knownDeepSeekThinkingModel)) {
    if (/claude-4|gpt-5-6|o1-pro|o3-pro/.test(m)) return 'max';
    if (/claude-3-7|gemini-2-5|deepseek/.test(m)) return 'high';
    return 'xhigh';
  }
  if (p === 'gemini' && /gemini-2-5/.test(m)) return 'high';
  return 'off';
}

export function clampThinkingLevel(level: string, provider: string, model: string): ThinkingLevel {
  const requested = ORDER.includes(level as ThinkingLevel) ? level as ThinkingLevel : 'off';
  const cap = maxThinkingLevel(provider, model);
  return ORDER.indexOf(requested) <= ORDER.indexOf(cap) ? requested : cap;
}

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
export function thinkingWire(provider: string, model: string): ThinkingWire {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase().replace(/[._]/g, '-');
  // Native providers serialise the level in their own request shape.
  if (p === 'anthropic' || p === 'gemini') return 'levels';
  if (m.includes('deepseek-v4')) return 'levels';
  if (isGlm53FlashModel(m)) return 'levels';
  // Pre-V4 DeepSeek leaves the request body untouched: the model decides. This
  // has to run before the generic "reason" match, or `deepseek-reasoner` would
  // be reported as if the level were transmitted.
  if (/(^|[/:-])deepseek-(?:chat|reasoner|r1)(?:[/:-]|$)/.test(m) ||
    /(^|[/:-])deepseek-ai[/:-]deepseek-(?:r1|v3)(?:[/:-]|$)/.test(m) ||
    p === 'deepseek') return 'model-decides';
  const reasoningModel =
    isGptReasoningModel(m) ||
    /(?:^|[/:-])o[1-9](?:-|$)/.test(m) ||
    m.includes('gpt-5') ||
    m.includes('grok') ||
    m.includes('qwq') ||
    m.includes('reason') ||
    (m.includes('thinking') && !m.includes('deepseek')) ||
    (m.includes('r1') && !m.includes('deepseek')) ||
    (m.includes('think') && !m.includes('deepseek')) ||
    p === 'xai';
  if (reasoningModel) return 'levels';
  return 'unsupported';
}
