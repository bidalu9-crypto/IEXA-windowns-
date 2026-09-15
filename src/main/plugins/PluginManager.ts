import { JsonStore } from '../persistence/JsonStore';
import { validatePluginCard } from './PluginPresentation';
import { createChildEnvironment } from '../security/ChildEnvironment';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentToolDefinition, AgentToolParam, ToolExecutionResult } from '../providers/types';

export interface PluginToolManifest {
  name: string;
  description: string;
  parameters?: Record<string, AgentToolParam>;
  required?: string[];
  propertyOrdering?: string[];
}

export interface PluginPanelManifest { id: string; title: string; entry: string; }

export interface PluginManifest {
  apiVersion?: 1 | 2;
  contributions?: { panels: PluginPanelManifest[] };
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  main?: string;
  ui?: string;
  tools: PluginToolManifest[];
}

interface PluginStateEntry { enabled: boolean; installedAt: number; }
interface PluginState { plugins: Record<string, PluginStateEntry>; }
export interface InstalledPlugin extends PluginManifest {
  enabled: boolean;
  installedAt: number;
  directory: string;
  hasUI: boolean;
  uiURL?: string;
  error?: string;
  tools: Array<PluginToolManifest & { agentName: string }>;
}
export interface PluginAgentBinding { pluginId: string; localName: string; definition: AgentToolDefinition; }

const MANIFEST_FILE = 'iexa-plugin.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_FILES = 2_000;
const MAX_PLUGIN_BYTES = 100 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export class PluginManager {
  readonly pluginsDir: string;
  private readonly stateFile: string;
  private state: PluginState;
  private readonly uiGrants = new Map<string, { id: string; panelId?: string; expiresAt: number }>();
  private readonly activeCalls = new Map<string, Set<AbortController>>();

  constructor(private readonly workspaceDir: string) {
    this.pluginsDir = path.join(workspaceDir, '.iexa-plugins');
    this.stateFile = path.join(workspaceDir, '.iexa-plugin-state.json');
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    this.state = this.loadState();
  }

  list(): InstalledPlugin[] {
    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && fs.existsSync(path.join(this.pluginsDir, entry.name, MANIFEST_FILE)));
    return entries.map((entry) => {
      const directory = path.join(this.pluginsDir, entry.name);
      try {
        const manifest = this.readManifest(directory);
        const state = this.state.plugins[manifest.id] || { enabled: false, installedAt: fs.statSync(directory).birthtimeMs || Date.now() };
        return this.toInstalled(manifest, directory, state);
      } catch (error) {
        return {
          id: entry.name, name: entry.name, version: 'unknown', description: '', tools: [], enabled: false,
          installedAt: fs.statSync(directory).birthtimeMs || Date.now(), directory, hasUI: false,
          error: (error as Error).message,
        };
      }
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  install(sourcePath: string): InstalledPlugin {
    const source = path.resolve(String(sourcePath || '').trim());
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('请选择包含 iexa-plugin.json 的插件文件夹。');
    const manifest = this.readManifest(source);
    const destination = path.join(this.pluginsDir, manifest.id);
    if (fs.existsSync(destination)) throw new Error(`插件 ${manifest.id} 已安装，请先卸载或使用重载。`);
    this.validatePackageSize(source);
    const staging = path.join(this.pluginsDir, `.install-${manifest.id}-${crypto.randomUUID()}`);
    try {
      fs.cpSync(source, staging, { recursive: true, errorOnExist: true, filter: (item) => !path.basename(item).startsWith('.install-') });
      this.readManifest(staging);
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    const state = { enabled: true, installedAt: Date.now() };
    this.state.plugins[manifest.id] = state;
    this.saveState();
    return this.toInstalled(manifest, destination, state);
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const plugin = this.get(id);
    if (enabled && plugin.error) throw new Error(plugin.error);
    if (!enabled) this.cancelCalls(id);
    this.state.plugins[id] = { enabled, installedAt: plugin.installedAt };
    this.saveState();
    return { ...plugin, enabled };
  }

  reload(id: string): InstalledPlugin {
    this.cancelCalls(id);
    const directory = this.pluginDirectory(id);
    const manifest = this.readManifest(directory);
    if (manifest.id !== id) throw new Error('插件清单 ID 与安装目录不一致。');
    const state = this.state.plugins[id] || { enabled: false, installedAt: Date.now() };
    return this.toInstalled(manifest, directory, state);
  }

  remove(id: string): void {
    this.cancelCalls(id);
    const directory = this.pluginDirectory(id);
    fs.rmSync(directory, { recursive: true, force: true });
    delete this.state.plugins[id];
    this.saveState();
  }

  bindings(): PluginAgentBinding[] {
    return this.list().filter((plugin) => plugin.enabled && !plugin.error).flatMap((plugin) => plugin.tools.map((tool) => ({
      pluginId: plugin.id,
      localName: tool.name,
      definition: {
        name: tool.agentName,
        description: `插件 ${plugin.name}：${tool.description}`,
        parameters: tool.parameters || {},
        required: tool.required || [],
        propertyOrdering: tool.propertyOrdering || Object.keys(tool.parameters || {}),
      },
    })));
  }

  async invoke(id: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const plugin = this.get(id);
    if (!plugin.enabled) return { output: '插件已停用。', success: false };
    const tool = plugin.tools.find((item) => item.name === toolName);
    if (!tool) return { output: `插件工具不存在：${toolName}`, success: false };
    if (!plugin.main) return { output: '插件未声明 main 执行入口。', success: false };
    const entry = this.resolveInside(plugin.directory, plugin.main, 'main');
    const dataDir = path.join(this.pluginsDir, '.data', plugin.id);
    fs.mkdirSync(dataDir, { recursive: true });
    this.validateArguments(tool, args);
    const calls = this.activeCalls.get(id) || new Set<AbortController>();
    if (calls.size >= 8) throw new Error('插件并发调用已达到 8 个，请等待现有调用结束。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    calls.add(controller); this.activeCalls.set(id, calls);
    try {
      const result = await this.runPlugin(entry, { tool: toolName, args, context: { workspaceDir: this.workspaceDir, pluginDir: plugin.directory, dataDir } }, controller.signal);
      const rawUI = (result as ToolExecutionResult & { ui?: unknown }).ui;
      delete (result as ToolExecutionResult & { ui?: unknown }).ui;
      delete result.pluginUI; // Identity is stamped by the host, never trusted from child output.
      if (rawUI !== undefined) {
        try { result.pluginUI = { pluginId: id, pluginName: plugin.name, tool: toolName, card: validatePluginCard(rawUI) }; }
        catch (error) { result.metadata = { ...result.metadata, pluginUIError: (error as Error).message }; }
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', abort); calls.delete(controller);
      if (!calls.size && this.activeCalls.get(id) === calls) this.activeCalls.delete(id);
    }
  }

  resolveUiAsset(id: string, relativePath = '', panelId?: string): { path: string; html: boolean } {
    const plugin = this.get(id);
    if (!plugin.enabled || plugin.error) throw new Error('插件已停用或清单无效。');
    const ui = panelId ? plugin.contributions?.panels.find(panel => panel.id === panelId)?.entry : plugin.ui;
    if (!ui) throw new Error('该插件没有指定的可视化界面。');
    const entry = this.resolveInside(plugin.directory, ui, 'ui');
    const uiRoot = path.dirname(entry);
    const target = relativePath ? this.resolveInside(uiRoot, relativePath, 'UI 资源') : entry;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('插件 UI 资源不存在。');
    return { path: target, html: path.extname(target).toLowerCase() === '.html' };
  }

  createUIGrant(id: string, panelId?: string): { token: string; url: string; expiresAt: number } {
    this.resolveUiAsset(id, '', panelId);
    const now = Date.now();
    for (const [key, grant] of this.uiGrants) if (grant.expiresAt <= now) this.uiGrants.delete(key);
    if (this.uiGrants.size >= 128) throw new Error('打开的插件面板过多，请关闭部分面板。');
    const token = crypto.randomBytes(24).toString('hex'), expiresAt = now + 30 * 60_000;
    this.uiGrants.set(token, { id, panelId, expiresAt });
    return { token, url: `/plugin-assets/${token}/`, expiresAt };
  }

  revokeUIGrant(id: string, token: string): void { if (this.uiGrants.get(token)?.id === id) this.uiGrants.delete(token); }

  resolveGrantedAsset(token: string, relative: string): { path: string; html: boolean; sdk?: boolean } {
    const grant = this.uiGrants.get(token);
    if (!grant || grant.expiresAt <= Date.now()) { this.uiGrants.delete(token); throw new Error('插件资源凭证已失效，请刷新面板。'); }
    // Recheck enabled state and the manifest at every read; grants authorize no tool/API access.
    this.resolveUiAsset(grant.id, '', grant.panelId);
    if (relative === '_iexa-sdk.js') return { path: '', html: false, sdk: true };
    const asset = this.resolveUiAsset(grant.id, relative, grant.panelId);
    if (!['.html', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.wasm', '.ico'].includes(path.extname(asset.path).toLowerCase())) throw new Error('插件资源类型未开放。');
    return asset;
  }

  readUIState(id: string): { revision: number; value: unknown } {
    const plugin = this.get(id);
    if (!plugin.enabled || plugin.error) throw new Error('插件已停用或清单无效。');
    return new JsonStore<{ revision: number; value: unknown }>(path.join(this.pluginsDir, '.data', id, 'host-ui-state.json'), () => ({ revision: 0, value: null })).loadSync();
  }

  writeUIState(id: string, revision: number, value: unknown): { revision: number; value: unknown } {
    const previous = this.readUIState(id);
    if (!Number.isSafeInteger(revision) || revision !== previous.revision) throw new Error('插件状态版本冲突，请重新读取后保存。');
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new Error('插件 UI 状态需要 JSON，且不超过 64 KB。');
    const next = { revision: revision + 1, value: JSON.parse(encoded) };
    new JsonStore(path.join(this.pluginsDir, '.data', id, 'host-ui-state.json'), () => previous).saveSync(next);
    return next;
  }

  private cancelCalls(id: string): void { for (const [token, grant] of this.uiGrants) if (grant.id === id) this.uiGrants.delete(token); for (const controller of this.activeCalls.get(id) || []) controller.abort(); }

  private validateArguments(tool: PluginToolManifest, args: Record<string, unknown>): void {
    const check = (schema: AgentToolParam, value: unknown, label: string): void => {
      if (schema.type === 'string' && (typeof value !== 'string' || (schema.enumValues && !schema.enumValues.includes(value)))) throw new Error(`参数 ${label} 需要有效字符串。`);
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) throw new Error(`参数 ${label} 需要整数。`);
      if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`参数 ${label} 需要布尔值。`);
      if (schema.type === 'array') {
        if (!Array.isArray(value)) throw new Error(`参数 ${label} 需要数组。`);
        if (schema.items) value.forEach((item, i) => check(schema.items!, item, `${label}[${i}]`));
      }
      if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`参数 ${label} 需要对象。`);
        const record = value as Record<string, unknown>;
        for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`缺少参数 ${label}.${key}。`);
        for (const [key, child] of Object.entries(schema.properties || {})) if (Object.prototype.hasOwnProperty.call(record, key)) check(child, record[key], `${label}.${key}`);
      }
    };
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('插件参数需要对象。');
    for (const key of tool.required || []) if (!Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`缺少参数 ${key}。`);
    for (const [key, value] of Object.entries(args)) {
      const schema = Object.prototype.hasOwnProperty.call(tool.parameters || {}, key) ? tool.parameters![key] : undefined;
      if (!schema) throw new Error(`未声明参数 ${key}。`);
      check(schema, value, key);
    }
  }

  private get(id: string): InstalledPlugin {
    const plugin = this.list().find((item) => item.id === id);
    if (!plugin) throw new Error('插件不存在。');
    return plugin;
  }

  private pluginDirectory(id: string): string {
    if (!/^[a-z][a-z0-9._-]{2,63}$/.test(id)) throw new Error('插件 ID 无效。');
    const directory = this.resolveInside(this.pluginsDir, id, '插件目录');
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('插件不存在。');
    return directory;
  }

  private readManifest(directory: string): PluginManifest {
    const manifestPath = path.join(directory, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) throw new Error(`缺少 ${MANIFEST_FILE}。`);
    if (fs.statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('插件清单超过 256 KB。');
    let source: unknown;
    try { source = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw new Error('插件清单不是有效 JSON。'); }
    return this.validateManifest(source, directory);
  }

  private validateManifest(value: unknown, directory: string): PluginManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件清单必须是 JSON 对象。');
    const raw = value as Record<string, unknown>;
    const id = String(raw.id || '').trim().toLowerCase();
    const name = String(raw.name || '').trim();
    const version = String(raw.version || '').trim();
    const description = String(raw.description || '').trim();
    if (!/^[a-z][a-z0-9._-]{2,63}$/.test(id)) throw new Error('插件 ID 需为 3-64 位小写字母、数字、点、横线或下划线，并以字母开头。');
    if (!name || name.length > 80) throw new Error('插件名称长度需为 1-80 个字符。');
    if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('插件版本必须使用 SemVer，例如 1.0.0。');
    if (description.length > 500) throw new Error('插件描述不能超过 500 个字符。');
    const main = raw.main == null ? undefined : String(raw.main).trim();
    const ui = raw.ui == null ? undefined : String(raw.ui).trim();
    if (main) {
      const entry = this.resolveInside(directory, main, 'main');
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile() || !['.js', '.cjs'].includes(path.extname(entry).toLowerCase())) throw new Error('main 必须指向插件目录内存在的 .js 或 .cjs 文件。');
    }
    if (ui) {
      const entry = this.resolveInside(directory, ui, 'ui');
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile() || path.extname(entry).toLowerCase() !== '.html') throw new Error('ui 必须指向插件目录内存在的 HTML 文件。');
    }
    const apiVersion = raw.apiVersion ?? 1;
    if (apiVersion !== 1 && apiVersion !== 2) throw new Error('插件 apiVersion 需要 1 或 2。');
    const panels: PluginPanelManifest[] = [];
    if (raw.contributions !== undefined) {
      if (apiVersion !== 2 || !raw.contributions || typeof raw.contributions !== 'object' || Array.isArray(raw.contributions)) throw new Error('contributions 需要 apiVersion: 2。');
      const contributions = raw.contributions as Record<string, unknown>;
      if (Object.keys(contributions).some(key => key !== 'panels')) throw new Error('未知插件 contribution。');
      if (!Array.isArray(contributions.panels) || contributions.panels.length > 8) throw new Error('插件最多注册 8 个面板。');
      for (const value of contributions.panels) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件面板声明无效。');
        const panel = value as Record<string, unknown>;
        if (typeof panel.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(panel.id) || panels.some(p => p.id === panel.id)) throw new Error('插件面板 ID 无效或重复。');
        if (typeof panel.title !== 'string' || !panel.title.trim() || panel.title.length > 80 || typeof panel.entry !== 'string') throw new Error('插件面板标题或入口无效。');
        const entry = this.resolveInside(directory, panel.entry, 'panel');
        if (!fs.existsSync(entry) || !fs.statSync(entry).isFile() || path.extname(entry).toLowerCase() !== '.html') throw new Error('panel 入口需要 HTML 文件。');
        panels.push({ id: panel.id, title: panel.title, entry: panel.entry });
      }
    }
    const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
    if (rawTools.length > 32) throw new Error('单个插件最多声明 32 个工具。');
    const names = new Set<string>();
    const tools = rawTools.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('插件工具声明必须是对象。');
      const source = item as Record<string, unknown>;
      const toolName = String(source.name || '').trim();
      const toolDescription = String(source.description || '').trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(toolName)) throw new Error(`插件工具名无效：${toolName || '(empty)'}`);
      if (names.has(toolName)) throw new Error(`插件工具名重复：${toolName}`);
      names.add(toolName);
      if (!toolDescription || toolDescription.length > 500) throw new Error(`插件工具 ${toolName} 缺少有效描述。`);
      const parameters = this.validateParameters(source.parameters, toolName);
      const required = Array.isArray(source.required) ? source.required.map(String) : [];
      if (required.some((key) => !parameters[key])) throw new Error(`插件工具 ${toolName} 的 required 包含未声明参数。`);
      const propertyOrdering = Array.isArray(source.propertyOrdering) ? source.propertyOrdering.map(String).filter((key) => parameters[key]) : Object.keys(parameters);
      return { name: toolName, description: toolDescription, parameters, required, propertyOrdering };
    });
    if (tools.length > 0 && !main) throw new Error('声明工具的插件必须提供 main 执行入口。');
    if (tools.length === 0 && !ui && !panels.length) throw new Error('插件至少需要声明一个工具或可视化 UI。');
    return { apiVersion, contributions: { panels }, id, name, version, description, author: raw.author ? String(raw.author).slice(0, 120) : undefined, main, ui, tools };
  }

  private validateParameters(value: unknown, toolName: string): Record<string, AgentToolParam> {
    if (value == null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`插件工具 ${toolName} 的 parameters 必须是对象。`);
    const output: Record<string, AgentToolParam> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) throw new Error(`插件工具 ${toolName} 的参数 ${key} 无效。`);
      output[key] = this.validateParameter(raw, `${toolName}.${key}`, 0);
    }
    return output;
  }

  private validateParameter(value: unknown, label: string, depth: number): AgentToolParam {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) throw new Error(`插件参数 ${label} 的结构无效。`);
    const item = value as Record<string, unknown>;
    const type = String(item.type || 'string') as AgentToolParam['type'];
    if (!['string', 'integer', 'boolean', 'array', 'object'].includes(type)) throw new Error(`插件参数 ${label} 使用了不支持的类型。`);
    const output: AgentToolParam = { type, description: String(item.description || label).slice(0, 500) };
    if (Array.isArray(item.enumValues) && type === 'string') output.enumValues = item.enumValues.map(String).slice(0, 100);
    if (type === 'array' && item.items) output.items = this.validateParameter(item.items, `${label}[]`, depth + 1);
    if (type === 'object' && item.properties && typeof item.properties === 'object' && !Array.isArray(item.properties)) {
      output.properties = {};
      for (const [key, child] of Object.entries(item.properties as Record<string, unknown>)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) throw new Error(`插件参数 ${label}.${key} 无效。`);
        output.properties[key] = this.validateParameter(child, `${label}.${key}`, depth + 1);
      }
      if (Array.isArray(item.required)) output.required = item.required.map(String).filter((key) => output.properties?.[key]);
    }
    return output;
  }

  private toInstalled(manifest: PluginManifest, directory: string, state: PluginStateEntry): InstalledPlugin {
    return {
      ...manifest, enabled: state.enabled, installedAt: state.installedAt, directory, hasUI: Boolean(manifest.ui || manifest.contributions?.panels.length),
      uiURL: manifest.ui ? `/api/plugins/${encodeURIComponent(manifest.id)}/ui/` : undefined,
      tools: manifest.tools.map((tool) => ({ ...tool, agentName: this.agentToolName(manifest.id, tool.name) })),
    };
  }

  private agentToolName(pluginId: string, toolName: string): string {
    const id = pluginId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 22);
    const hash = crypto.createHash('sha256').update(pluginId).digest('hex').slice(0, 6);
    return `plugin_${id}_${hash}_${toolName}`.slice(0, 64);
  }

  private resolveInside(root: string, relative: string, field: string): string {
    if (!relative || path.isAbsolute(relative)) throw new Error(`${field} 必须是插件目录内的相对路径。`);
    const target = path.resolve(root, relative);
    const rel = path.relative(path.resolve(root), target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${field} 不能超出插件目录。`);
    if (fs.existsSync(target)) {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`${field} 不能通过链接指向插件目录外。`);
    }
    return target;
  }

  private validatePackageSize(root: string): void {
    let files = 0; let bytes = 0;
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) throw new Error('插件包不能包含符号链接。');
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) { files++; bytes += stat.size; }
        if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) throw new Error('插件包超过 2000 个文件或 100 MB 限制。');
      }
    };
    walk(root);
  }

  private runPlugin(entry: string, payload: unknown, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (signal?.aborted) return Promise.resolve({ output: '插件调用已取消。', success: false });
    let input: string;
    try { input = JSON.stringify(payload); }
    catch { return Promise.resolve({ output: '插件输入序列化失败。', success: false }); }
    if (Buffer.byteLength(input, 'utf8') > 2 * 1024 * 1024) return Promise.resolve({ output: '插件输入超过 2 MB。', success: false });
    return new Promise((resolve) => {
      const runner = path.join(__dirname, 'PluginRunner.js');
      const child = spawn(process.execPath, [runner, entry], {
        cwd: path.dirname(entry), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...createChildEnvironment(), ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
      });
      let stdout = ''; let stdoutBytes = 0; let stderr = ''; let settled = false; let stopped: ToolExecutionResult | undefined;
      const finish = (result: ToolExecutionResult) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); stdout = ''; stderr = ''; resolve(result); };
      const stop = (result: ToolExecutionResult) => { if (settled || stopped) return; stopped = result; child.kill(); };
      const abort = () => stop({ output: '插件调用已取消。', success: false, cancelled: true });
      const timer = setTimeout(() => { stop({ output: '插件调用超过 30 秒，已终止。', success: false, timedOut: true }); }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => { if (settled || stopped) return; if (stdoutBytes + chunk.length > MAX_RESULT_BYTES) { stop({ output: '插件输出超过 8 MB 限制。', success: false }); } else { stdoutBytes += chunk.length; stdout += chunk.toString('utf8'); } });
      child.stderr.on('data', (chunk: Buffer) => { if (settled || stopped) return; stderr = (stderr + chunk.subarray(-16_000).toString('utf8')).slice(-16_000); });
      child.on('error', (error) => finish({ output: `插件进程启动失败：${error.message}`, success: false }));
      child.on('close', (code) => {
        if (settled) return;
        if (stopped) { finish(stopped); return; }
        try {
          const parsed = JSON.parse(stdout || '{}') as Partial<ToolExecutionResult>;
          const output = typeof parsed.output === 'string' ? parsed.output : parsed.output == null ? '' : JSON.stringify(parsed.output, null, 2);
          finish({ ...parsed, output: output || (stderr.trim() || '(no output)'), success: parsed.success !== false && code === 0 });
        } catch {
          finish({ output: stderr.trim() || stdout.trim() || `插件进程退出：${code ?? -1}`, success: false, exitCode: code ?? -1 });
        }
      });
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', (error) => { stop({ output: `插件输入失败：${error.message}`, success: false }); });
      if (!settled && !stopped) child.stdin.end(input);
    });
  }

  private loadState(): PluginState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as PluginState;
      return parsed && parsed.plugins && typeof parsed.plugins === 'object' ? parsed : { plugins: {} };
    } catch { return { plugins: {} }; }
  }

  private saveState(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporary, this.stateFile);
  }
}
