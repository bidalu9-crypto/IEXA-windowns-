// =============================================================================
// IEXA PC - Session Title Generation (mirrors iOS AIChatViewModel+TitleGeneration)
// =============================================================================

import { ProviderFactory, LLMProvider } from './providers/ProviderFactory';
import { AgentMessage, ProviderType } from './providers/types';

export interface TitleProfile {
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

export interface TitleResult {
  title: string;
  category?: string;
}

const MAX_TITLE_ATTEMPTS = 3;

/** iOS fallbackTitle(fromFirstUserMessage:) — ~30 chars from first user msg */
export function fallbackTitleFromFirstUserMessage(raw: string): string | null {
  let t = raw || '';
  // Drop attached-files metadata blocks if present
  t = t.replace(/<user-attached-files>[\s\S]*?<\/user-attached-files>/gi, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > 30) return t.substring(0, 30).trim() + '…';
  return t;
}

/** Build conversation summary like iOS (first pair ± last pair, 200 chars each) */
export function buildConversationSummary(opts: {
  firstUser: string;
  firstAssistant: string;
  lastUser?: string;
  lastAssistant?: string;
  toolEntries?: Array<{ name: string; args: Record<string, unknown> }>;
}): string {
  let responseText = (opts.firstAssistant || '').trim();
  if (!responseText && opts.toolEntries && opts.toolEntries.length > 0) {
    const toolSummaries = opts.toolEntries.slice(0, 3).map((entry) => {
      let argsPreview = '{}';
      try { argsPreview = JSON.stringify(entry.args); } catch { /* */ }
      return `${entry.name}(${argsPreview.substring(0, 200)})`;
    });
    responseText = `[Tool calls: ${toolSummaries.join(', ')}]`;
  }

  let summary =
    `User: ${(opts.firstUser || '').substring(0, 200)}\n\n` +
    `Assistant: ${responseText.substring(0, 200)}`;

  if (opts.lastUser && opts.lastUser !== opts.firstUser) {
    summary += '\n\n[... middle of conversation omitted ...]\n';
    summary += `\nUser: ${opts.lastUser.substring(0, 200)}`;
    if (opts.lastAssistant && opts.lastAssistant.trim()) {
      summary += `\n\nAssistant: ${opts.lastAssistant.substring(0, 200)}`;
    }
  }

  return summary;
}

/** Bilingual language injection — PC UI is Chinese (zh-Hans) */
function titleLanguageInjection(): string {
  const preferred = 'zh-Hans';
  const localizedName = '简体中文';
  return (
    `The user's app interface language is "${preferred}" (${localizedName}). ` +
    `Generate the title primarily in this language. If the conversation content is in a different language, ` +
    `you may incorporate proper nouns from it, but the overall title language should match the interface language.\n` +
    `用户的 App 界面语言是 "${preferred}"（${localizedName}）。请优先使用该语言生成标题。` +
    `如果对话内容是其他语言，可保留专有名词，但标题整体语言应与界面语言一致。`
  );
}

/** Parse model response into {title, category} — same strategies as iOS */
export function parseTitleResponse(responseText: string): TitleResult | null {
  let cleaned = (responseText || '').trim();
  if (!cleaned) return null;

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split(/\r?\n/);
    while (lines.length && lines[0].startsWith('```')) lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
    cleaned = lines.join('\n').trim();
  }

  // Extract JSON object if extra text around it
  let jsonString = cleaned;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    jsonString = cleaned.substring(start, end + 1);
  }

  try {
    const json = JSON.parse(jsonString) as { title?: unknown; category?: unknown };
    if (typeof json.title === 'string' && json.title.trim()) {
      return {
        title: cleanTitle(json.title),
        category: typeof json.category === 'string' ? json.category : undefined,
      };
    }
  } catch { /* fall through */ }

  // Regex fallback: "title": "..."
  const m = jsonString.match(/"title"\s*:\s*"([^"]+)"/);
  if (m && m[1]) {
    return { title: cleanTitle(m[1]) };
  }

  // Plain text fallback if short and no JSON artifacts
  const raw = cleaned.replace(/^["'{}]+|["'{}]+$/g, '').trim();
  if (raw && raw.length < 60 && !raw.includes('{') && !raw.includes('}')) {
    return { title: cleanTitle(raw) };
  }

  return null;
}

function cleanTitle(raw: string): string {
  let t = (raw || '').trim();
  t = t.replace(/^["'「『【\[]+|["'」』】\]]+$/g, '');
  t = t.replace(/^(标题|題目|Title)\s*[:：]\s*/i, '');
  t = t.split(/\r?\n/)[0].trim();
  t = t.replace(/[.。!！?？]+$/g, '').trim();
  // iOS keeps full title; soft-cap long ones for sidebar
  if (t.length > 40) t = t.substring(0, 40).trim();
  return t;
}

/**
 * Call active model with the same prompt shape as iOS callSubModelForTitle.
 * Returns null on failure (caller should apply fallback).
 */
export async function callModelForTitle(
  profile: TitleProfile,
  conversationSummary: string,
): Promise<TitleResult | null> {
  if (!profile.apiKey || !conversationSummary.trim()) return null;

  let provider: LLMProvider;
  try {
    provider = ProviderFactory.create({
      type: profile.provider as ProviderType,
      name: profile.provider,
      model: profile.model,
      apiKey: profile.apiKey,
      baseURL: profile.baseURL || undefined,
    });
  } catch (err) {
    console.error('[TitleGen] provider create failed:', (err as Error).message);
    return null;
  }

  const langInjection = titleLanguageInjection();
  const prompt =
    `Based on the following conversation, generate a short title (max 6 words) that captures the topic. ` +
    `Also pick a task category from: code, writing, research, analysis, creative, chat, math, translation, ` +
    `health, finance, travel, education, design, productivity, support, other.\n\n` +
    `${langInjection}\n\n` +
    `You MUST respond with valid JSON only. Example:\n` +
    `{"title": "Debug Login Page Issue", "category": "code"}\n\n` +
    `Conversation:\n${conversationSummary}`;

  const systemPrompt =
    'You generate concise titles for conversations. You MUST respond with a single valid JSON object: ' +
    '{"title": "...", "category": "..."}. No other text.';

  const messages: AgentMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: prompt }] },
  ];

  try {
    let responseText = '';
    // maxTokens 1024 like iOS; empty tools
    const stream = provider.streamMessage(messages, systemPrompt, [], 1024);
    for await (const event of stream) {
      if (event.type === 'textDelta') responseText += event.text;
    }
    console.log(`[TitleGen] raw response (${responseText.length} chars): ${responseText.substring(0, 200)}`);
    return parseTitleResponse(responseText);
  } catch (err) {
    console.error('[TitleGen] model call failed:', (err as Error).message);
    return null;
  }
}

export { MAX_TITLE_ATTEMPTS };
