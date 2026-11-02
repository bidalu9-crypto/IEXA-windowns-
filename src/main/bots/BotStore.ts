import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonStore } from '../persistence/JsonStore';
import { SoulFile } from '../agent/SoulStore';

export interface BotProfile {
  id: string; name: string; description: string; persona: string; memory: string;
  profileId: string; allowedTools: string[]; created: number; updated: number;
}
export interface BotPackage {
  format: 'iexa-bot'; version: 1;
  bot: Pick<BotProfile, 'name' | 'description' | 'persona' | 'allowedTools'> & { memory?: string };
}
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);

function validateTools(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error('Bot allowedTools 必须是最多 128 项的工具名数组');
  const seen = new Set<string>();
  return Array.from(value, item => {
    if (typeof item !== 'string' || !item.trim() || !/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(item.trim())) {
      throw new Error('Bot allowedTools 必须包含非空有效工具名');
    }
    const name = item.trim();
    if (name.split(/[.:]/).some(part => dangerousKeys.has(part))) throw new Error(`Bot allowedTools 拒绝危险工具名：${name}`);
    if (seen.has(name)) throw new Error(`Bot allowedTools 存在重复工具名：${name}`);
    seen.add(name);
    return name;
  });
}
function textField(value: unknown, key: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new Error(`Bot 字段 ${key} 无效（上限 ${limit} 字符）`);
  }
  return value.trim();
}
function packageObject(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} 必须是普通 JSON 对象`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'profileId') throw new Error('Bot 包不得包含 profileId；请在本机显式选择模型配置');
    if (typeof key !== 'string' || dangerousKeys.has(key) || !allowed.includes(key)) {
      throw new Error(`${label} 包含未知或危险字段：${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Error(`${label} 不接受访问器或可执行字段`);
  }
  return value as Record<string, unknown>;
}
/** Parse data only. External plugins, archives and profile credentials are never imported. */
export function parseBotPackage(input: unknown): BotPackage {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) throw new Error('不支持 ZIP/二进制 Bot 包；仅支持 iexa-bot v1 JSON，不支持 DSH 或 plugin');
  if (typeof input === 'string') {
    if (input.startsWith('PK')) throw new Error('不支持 ZIP Bot 包；请提供 iexa-bot v1 JSON');
    try { input = JSON.parse(input); }
    catch { throw new Error('Bot 包必须是有效的 iexa-bot v1 JSON，不支持 ZIP、DSH 或 plugin'); }
  }
  const envelope = packageObject(input, ['format', 'version', 'bot'], 'Bot 包');
  if (envelope.format !== 'iexa-bot') throw new Error('仅支持原生 iexa-bot 格式，不支持 ZIP、DSH 或 plugin 包');
  if (envelope.version !== 1) throw new Error('不支持的 Bot 包版本；仅支持 version: 1');
  const bot = packageObject(envelope.bot, ['name', 'description', 'persona', 'memory', 'allowedTools'], 'Bot 包 bot');
  return { format: 'iexa-bot', version: 1, bot: {
    name: textField(bot.name, 'name', 80, true),
    description: textField(bot.description === undefined ? '' : bot.description, 'description', 600),
    persona: textField(bot.persona === undefined ? '' : bot.persona, 'persona', 12000),
    memory: textField(bot.memory === undefined ? '' : bot.memory, 'memory', 16000),
    allowedTools: validateTools(bot.allowedTools),
  } };
}
/**
 * Conservative adapter for .botharness/bot.json (unversioned schema), verified at
 * BotHarness/DeepSeekBot commit 2a241b66459c07e9585f1cd45c7563bc70b15c78.
 * The descriptor contains display metadata, NOT a persona: upstream loads that
 * separately from SOUL.md / legacy PERSONA.md. Never infer instructions from bio/tags.
 */
export function convertTobsDescriptor(input: unknown): BotPackage {
  const label = 'DeepSeekBot 描述文件';
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    throw new Error(`${label} 不支持 ZIP/二进制或 DSH/plugin 包；仅支持 .botharness/bot.json`);
  }
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > 16384) throw new Error(`${label} 超过 16384 字节`);
    try { input = JSON.parse(input); }
    catch { throw new Error(`${label} 必须是有效 JSON；不支持 ZIP、DSH/plugin 或 Markdown 人格文件`); }
  }
  // Inspect descriptors before serializing, so accessors/toJSON are never invoked.
  const jsonData = (value: unknown, depth = 0): unknown => {
    if (depth > 16) throw new Error(`${label} JSON 嵌套过深`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' ||
        (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
      throw new Error(`${label} 仅接受纯 JSON 数据，不加载代码或插件`);
    }
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string' || dangerousKeys.has(key) ||
          (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))) throw new Error(`${label} 包含危险或非法 JSON 字段`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new Error(`${label} 不接受访问器或可执行字段`);
      (result as Record<string, unknown>)[key] = jsonData(descriptor.value, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) throw new Error(`${label} 不接受稀疏数组`);
    return result;
  };
  const source = packageObject(jsonData(input), ['name', 'bio', 'tags', 'roles', 'avatar', 'banner', 'primaryColor', 'i18n'], label);
  if (Buffer.byteLength(JSON.stringify(source), 'utf8') > 16384) throw new Error(`${label} 超过 16384 字节`);
  const descriptorText = (value: unknown, key: string, limit: number, required = false): string => {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || [...value.trim()].length > limit || (required && !value.trim())) {
      throw new Error(`${label} 字段 ${key} 无效（上限 ${limit} 个 Unicode 字符）`);
    }
    return value.trim();
  };
  const name = descriptorText(source.name, 'name', 60, true);
  const description = descriptorText(source.bio, 'bio', 160);
  // tags and the upstream legacy roles alias are display metadata, never tool grants/persona.
  for (const key of ['tags', 'roles']) {
    const tags = source[key];
    if (tags === undefined) continue;
    if (!Array.isArray(tags) || tags.length > 8) throw new Error(`${label} ${key} 必须是最多 8 项的标签数组`);
    for (const tag of tags) descriptorText(tag, key, 32, true);
  }
  // Appearance/localizations are inert JSON metadata: accepted but deliberately not rendered,
  // fetched, localized or mapped. This adapter is not a full upstream appearance validator.
  for (const key of ['avatar', 'banner', 'primaryColor', 'i18n']) {
    const value = source[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`${label} ${key} 必须是 JSON 对象`);
    }
  }
  if (name.length > 80) throw new Error(`${label} name 超过本机 Bot 的 80 字符限制`);
  return { format: 'iexa-bot', version: 1, bot: { name, description, persona: '', allowedTools: [] } };
}

/** Native IEXA personas; no DSH process, protocol or credentials involved. */
export class BotStore {
  private readonly store: JsonStore<{ bots: BotProfile[] }>;
  constructor(readonly root: string) {
    this.store = new JsonStore(path.join(root, 'bots.json'), () => ({ bots: [] }));
  }
  list(): BotProfile[] { return this.store.loadSync().bots.map(bot => ({ ...bot, allowedTools: validateTools(bot.allowedTools) })); }
  get(id: string): BotProfile | undefined { return this.list().find(bot => bot.id === id); }
  save(input: Record<string, unknown>, id?: string): BotProfile {
    const data = this.store.loadSync();
    const old = id ? data.bots.find(bot => bot.id === id) : undefined;
    if (id && !old) throw new Error('Bot 不存在');
    if (!id && data.bots.length >= 100) throw new Error('最多创建 100 个 Bot');
    const text = (key: string, limit: number, required = false): string => {
      const value = input[key] === undefined && old ? old[key as keyof BotProfile] : input[key] ?? '';
      if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`Bot 字段 ${key} 无效（上限 ${limit} 字符）`);
      return value.trim();
    };
    const bot: BotProfile = { id: old?.id || 'bot_' + randomUUID(), name: text('name', 80, true),
      description: text('description', 600), persona: text('persona', 12000), memory: text('memory', 16000),
      profileId: text('profileId', 200, true),
      allowedTools: validateTools(input.allowedTools === undefined ? old?.allowedTools : input.allowedTools),
      created: old?.created || Date.now(), updated: Date.now() };
    data.bots = [...data.bots.filter(item => item.id !== bot.id), bot];
    this.store.saveSync(data); return bot;
  }
  exportBot(id: string, includeMemory = false): BotPackage {
    const bot = this.get(id);
    if (!bot) throw new Error('Bot 不存在');
    const exported: BotPackage = { format: 'iexa-bot', version: 1, bot: {
      name: bot.name, description: bot.description, persona: bot.persona, allowedTools: [...bot.allowedTools],
    } };
    if (includeMemory === true) exported.bot.memory = bot.memory;
    return exported;
  }
  remove(id: string): void {
    const data = this.store.loadSync();
    if (!data.bots.some(bot => bot.id === id)) throw new Error('Bot 不存在');
    this.store.saveSync({ bots: data.bots.filter(bot => bot.id !== id) });
  }
  memoryDir(id: string): string {
    if (!/^bot_[a-f0-9-]{36}$/.test(id)) throw new Error('无效 Bot ID');
    return path.join(this.root, id, 'memory');
  }
}
export function botSoul(base: SoulFile, bot: BotProfile): SoulFile {
  return { metadata: { ...base.metadata, name: bot.name },
    body: `${base.body}\n\n## 当前 Bot 身份\n${bot.persona}\n\n## 当前 Bot 显式长期记忆\n${bot.memory}\n\n此身份与记忆仅属于 ${bot.name}。不扩大现有工具权限，不自动访问其他 Bot 的记忆。` };
}
