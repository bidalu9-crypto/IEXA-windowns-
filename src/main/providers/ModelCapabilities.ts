export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const ORDER: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Conservative model-id capability registry. Unknown models stay off so a
 * gateway is never sent unsupported reasoning fields by guesswork. */
export function maxThinkingLevel(provider: string, model: string): ThinkingLevel {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase().replace(/[._]/g, '-');
  // iOS explicitly allows xAI/OpenRouter-compatible reasoning models even
  // when the model catalog does not annotate the id with "reasoning".
  if (p === 'xai' || /(^|-)grok(?:-|$)/.test(m)) return 'xhigh';
  if (/deepseek|reasoner|deepseek-r1|qwq|qwen3-thinking|(^|-)o[1-9](?:-|$)|gpt-5|grok.*reason|claude-3-7|claude-4|thinking/.test(m) || p === 'deepseek') {
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
