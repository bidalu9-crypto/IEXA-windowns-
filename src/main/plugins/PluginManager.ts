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

export interface PluginManifest {
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
    this.state.plugins[id] = { enabled, installedAt: plugin.installedAt };
    this.saveState();
    return { ...plugin, enabled };
  }

  reload(id: string): InstalledPlugin {
    const directory = this.pluginDirectory(id);
    const manifest = this.readManifest(directory);
    if (manifest.id !== id) throw new Error('插件清单 ID 与安装目录不一致。');
    const state = this.state.plugins[id] || { enabled: false, installedAt: Date.now() };
    return this.toInstalled(manifest, directory, state);
  }

  remove(id: string): void {
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
    return this.runPlugin(entry, { tool: toolName, args, context: { workspaceDir: this.workspaceDir, pluginDir: plugin.directory, dataDir } }, signal);
  }

  resolveUiAsset(id: string, relativePath = ''): { path: string; html: boolean } {
    const plugin = this.get(id);
    if (!plugin.ui) throw new Error('该插件没有可视化界面。');
    const entry = this.resolveInside(plugin.directory, plugin.ui, 'ui');
    const uiRoot = path.dirname(entry);
    const target = relativePath ? this.resolveInside(uiRoot, relativePath, 'UI 资源') : entry;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('插件 UI 资源不存在。');
    return { path: target, html: path.extname(target).toLowerCase() === '.html' };
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
    if (tools.length === 0 && !ui) throw new Error('插件至少需要声明一个工具或可视化 UI。');
    return { id, name, version, description, author: raw.author ? String(raw.author).slice(0, 120) : undefined, main, ui, tools };
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
      ...manifest, enabled: state.enabled, installedAt: state.installedAt, directory, hasUI: Boolean(manifest.ui),
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
    return new Promise((resolve) => {
      const runner = path.join(__dirname, 'PluginRunner.js');
      const child = spawn(process.execPath, [runner, entry], {
        cwd: path.dirname(entry), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
      });
      let stdout = ''; let stderr = ''; let settled = false;
      const finish = (result: ToolExecutionResult) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result); };
      const abort = () => { child.kill(); finish({ output: '插件调用已取消。', success: false }); };
      const timer = setTimeout(() => { child.kill(); finish({ output: '插件调用超过 30 秒，已终止。', success: false, timedOut: true }); }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (Buffer.byteLength(stdout) > MAX_RESULT_BYTES) { child.kill(); finish({ output: '插件输出超过 8 MB 限制。', success: false }); } });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_000); });
      child.on('error', (error) => finish({ output: `插件进程启动失败：${error.message}`, success: false }));
      child.on('close', (code) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(stdout || '{}') as Partial<ToolExecutionResult>;
          const output = typeof parsed.output === 'string' ? parsed.output : parsed.output == null ? '' : JSON.stringify(parsed.output, null, 2);
          finish({ ...parsed, output: output || (stderr.trim() || '(no output)'), success: parsed.success !== false && code === 0 });
        } catch {
          finish({ output: stderr.trim() || stdout.trim() || `插件进程退出：${code ?? -1}`, success: false, exitCode: code ?? -1 });
        }
      });
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end(JSON.stringify(payload));
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
