export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const ORDER: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Match the GPT-6 Astra family, including provider-prefixed and dated aliases.
 * Keep this explicit instead of treating every future GPT-6 id as compatible:
 * OpenAI-compatible gateways reject unknown reasoning fields aggressively. */
export function isGpt6AstraModel(model: string): boolean {
  const id = String(model || '').toLowerCase().replace(/[._]/g, '-');
  return /(?:^|[/:-])gpt-6-astra(?:$|[/:-])/.test(id);
}

/** Match GLM 5.3 Flash and the common transposed `falsh` catalog alias. */
export function isGlm53FlashModel(model: string): boolean {
  const id = String(model || '').toLowerCase().replace(/[._]/g, '-');
  return /(?:^|[/:-])glm-5-3-(?:flash|falsh)(?:$|[/:-])/.test(id);
}

/** Shared native-vision gate used by attachment routing and profile metadata. */
export function modelLikelySupportsVision(provider: string, model: string): boolean {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  return p === 'anthropic' || p === 'gemini' || isGpt6AstraModel(m) || isGlm53FlashModel(m) ||
    /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|vl|llava|qwen2\.5-vl|qwen3-vl/.test(m);
}

/** Conservative model-id capability registry. Unknown models stay off so a
 * gateway is never sent unsupported reasoning fields by guesswork. */
export function maxThinkingLevel(provider: string, model: string): ThinkingLevel {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase().replace(/[._]/g, '-');
  if (isGpt6AstraModel(m)) return 'max';
  if (isGlm53FlashModel(m)) return 'high';
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
