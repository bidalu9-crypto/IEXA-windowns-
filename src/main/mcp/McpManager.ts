import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

export interface McpToolInfo { name: string; description?: string; inputSchema?: Record<string, unknown>; }
export interface McpResourceInfo { uri: string; name?: string; mimeType?: string; }
export interface McpServerInfo extends McpServerConfig { status: 'disconnected' | 'connecting' | 'connected' | 'error'; error?: string; tools: McpToolInfo[]; resources: McpResourceInfo[]; logs: string[]; }

interface StdioConnection { child: ChildProcess; buffer: string; nextId: number; pending: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>; }

/** Minimal MCP client supporting stdio JSON-RPC and JSON-over-HTTP servers. */
export class McpManager {
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly state = new Map<string, Omit<McpServerInfo, keyof McpServerConfig>>();
  private readonly connections = new Map<string, StdioConnection>();

  constructor(private readonly configFile: string) { this.load(); }

  list(): McpServerInfo[] {
    return [...this.configs.values()].map((config) => this.info(config));
  }

  add(input: Omit<McpServerConfig, 'id'>): McpServerInfo {
    const config = this.validate({ ...input, id: crypto.randomUUID() });
    this.configs.set(config.id, config);
    this.state.set(config.id, { status: 'disconnected', tools: [], resources: [], logs: [] });
    this.save();
    return this.info(config);
  }

  remove(id: string): void {
    this.disconnect(id);
    if (!this.configs.delete(id)) throw new Error('未找到 MCP Server。');
    this.state.delete(id);
    this.save();
  }

  async connect(id: string): Promise<McpServerInfo> {
    const config = this.getConfig(id);
    if (!config.enabled) throw new Error('该 MCP Server 已禁用。');
    this.disconnect(id);
    this.setState(id, { status: 'connecting', error: undefined, tools: [], resources: [], logs: [] });
    try {
      const initialize = await this.request(config, 'initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'IEXA-WIN', version: '1.0.0' },
      });
      await this.notify(config, 'notifications/initialized', {});
      const listed = await this.request(config, 'tools/list', {});
      const tools = Array.isArray((listed as { tools?: unknown[] })?.tools) ? (listed as { tools: unknown[] }).tools.map(toTool).filter(Boolean) as McpToolInfo[] : [];
      let resources: McpResourceInfo[] = [];
      try {
        const listedResources = await this.request(config, 'resources/list', {});
        resources = Array.isArray((listedResources as { resources?: unknown[] })?.resources) ? (listedResources as { resources: unknown[] }).resources.map(toResource).filter(Boolean) as McpResourceInfo[] : [];
      } catch { /* Resources are optional. */ }
      const serverName = String((initialize as { serverInfo?: { name?: string } })?.serverInfo?.name || config.name);
      this.log(id, `已连接：${serverName}；发现 ${tools.length} 个工具、${resources.length} 个资源。`);
      this.setState(id, { status: 'connected', error: undefined, tools, resources });
    } catch (error) {
      this.disconnect(id);
      const message = (error as Error).message;
      this.log(id, `连接失败：${message}`);
      this.setState(id, { status: 'error', error: message });
    }
    return this.info(config);
  }

  disconnect(id: string): McpServerInfo {
    const connection = this.connections.get(id);
    if (connection) {
      for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('MCP 连接已断开。')); }
      connection.child.kill();
      this.connections.delete(id);
    }
    const config = this.getConfig(id);
    const previous = this.state.get(id);
    this.setState(id, { status: 'disconnected', error: undefined, tools: previous?.tools || [], resources: previous?.resources || [] });
    return this.info(config);
  }

  async callTool(id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const config = this.getConfig(id);
    if (this.info(config).status !== 'connected') await this.connect(id);
    this.log(id, `调用工具：${name}`);
    return this.request(config, 'tools/call', { name, arguments: args });
  }

  async readResource(id: string, uri: string): Promise<unknown> {
    const config = this.getConfig(id);
    if (this.info(config).status !== 'connected') await this.connect(id);
    this.log(id, `读取资源：${uri}`);
    return this.request(config, 'resources/read', { uri });
  }

  private async request(config: McpServerConfig, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (config.transport === 'http') return this.httpRequest(config, method, params, false);
    let connection = this.connections.get(config.id);
    if (!connection) connection = this.openStdio(config);
    const id = connection.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection?.pending.delete(id); reject(new Error(`MCP 请求超时：${method}`)); }, 20_000);
      connection!.pending.set(id, { resolve, reject, timer });
      connection!.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private async notify(config: McpServerConfig, method: string, params: Record<string, unknown>): Promise<void> {
    if (config.transport === 'http') { await this.httpRequest(config, method, params, true); return; }
    const connection = this.connections.get(config.id);
    if (!connection?.child.stdin?.writable) throw new Error('MCP stdio 连接不可用。');
    connection.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private openStdio(config: McpServerConfig): StdioConnection {
    if (!config.command) throw new Error('stdio MCP Server 缺少启动命令。');
    const child = spawn(config.command, config.args || [], { windowsHide: true, stdio: 'pipe', env: process.env });
    const connection: StdioConnection = { child, buffer: '', nextId: 1, pending: new Map() };
    this.connections.set(config.id, connection);
    child.stdout?.on('data', (chunk: Buffer) => this.consume(config.id, connection, chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.log(config.id, chunk.toString('utf8').trim()));
    child.on('error', (error) => this.log(config.id, `进程错误：${error.message}`));
    child.on('close', (code) => {
      if (this.connections.get(config.id) === connection) this.connections.delete(config.id);
      if (code !== 0 && code !== null) this.log(config.id, `进程退出：${code}`);
    });
    return connection;
  }

  private consume(serverId: string, connection: StdioConnection, text: string): void {
    connection.buffer += text;
    let breakIndex = connection.buffer.indexOf('\n');
    while (breakIndex >= 0) {
      const line = connection.buffer.slice(0, breakIndex).trim();
      connection.buffer = connection.buffer.slice(breakIndex + 1);
      if (line) {
        try {
          const response = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof response.id === 'number') {
            const pending = connection.pending.get(response.id);
            if (pending) {
              clearTimeout(pending.timer); connection.pending.delete(response.id);
              if (response.error) pending.reject(new Error(response.error.message || 'MCP 请求失败')); else pending.resolve(response.result);
            }
          }
        } catch { this.log(serverId, `无法解析 MCP 输出：${line.slice(0, 180)}`); }
      }
      breakIndex = connection.buffer.indexOf('\n');
    }
  }

  private httpRequest(config: McpServerConfig, method: string, params: Record<string, unknown>, notification: boolean): Promise<unknown> {
    if (!config.url) return Promise.reject(new Error('HTTP MCP Server 缺少 URL。'));
    return new Promise((resolve, reject) => {
      const url = new URL(config.url!);
      const payload = JSON.stringify(notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: 1, method, params });
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(url, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (response) => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 400) { reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 300)}`)); return; }
          if (notification || !body.trim()) { resolve({}); return; }
          try {
            const parsed = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
            if (parsed.error) reject(new Error(parsed.error.message || 'MCP 请求失败')); else resolve(parsed.result);
          } catch { reject(new Error('HTTP MCP 返回了非 JSON 响应。')); }
        });
      });
      request.setTimeout(20_000, () => request.destroy(new Error(`MCP 请求超时：${method}`)));
      request.on('error', reject); request.end(payload);
    });
  }

  private getConfig(id: string): McpServerConfig {
    const config = this.configs.get(id);
    if (!config) throw new Error('未找到 MCP Server。');
    return config;
  }

  private info(config: McpServerConfig): McpServerInfo {
    const state = this.state.get(config.id) || { status: 'disconnected' as const, tools: [], resources: [], logs: [] };
    return { ...config, ...state, tools: state.tools || [], resources: state.resources || [], logs: state.logs || [] };
  }

  private setState(id: string, update: Partial<Omit<McpServerInfo, keyof McpServerConfig>>): void {
    const current = this.state.get(id) || { status: 'disconnected' as const, tools: [], resources: [], logs: [] };
    this.state.set(id, { ...current, ...update });
  }

  private log(id: string, message: string): void {
    if (!message) return;
    const current = this.state.get(id) || { status: 'disconnected' as const, tools: [], resources: [], logs: [] };
    const logs = [...(current.logs || []), `[${new Date().toLocaleTimeString('zh-CN')}] ${message}`].slice(-80);
    this.state.set(id, { ...current, logs });
  }

  private validate(value: McpServerConfig): McpServerConfig {
    const name = String(value.name || '').trim();
    const transport = value.transport === 'http' ? 'http' : 'stdio';
    if (!name || name.length > 80) throw new Error('MCP Server 名称无效。');
    if (transport === 'stdio' && !String(value.command || '').trim()) throw new Error('stdio MCP Server 必须填写启动命令。');
    if (transport === 'http') {
      try { const url = new URL(String(value.url || '')); if (!/^https?:$/.test(url.protocol)) throw new Error(); } catch { throw new Error('HTTP MCP Server URL 无效。'); }
    }
    return { id: value.id, name, transport, command: String(value.command || '').trim() || undefined, args: Array.isArray(value.args) ? value.args.map(String).slice(0, 60) : [], url: String(value.url || '').trim() || undefined, enabled: value.enabled !== false };
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as { servers?: McpServerConfig[] };
      for (const value of raw.servers || []) {
        const config = this.validate(value);
        this.configs.set(config.id, config); this.state.set(config.id, { status: 'disconnected', tools: [], resources: [], logs: [] });
      }
    } catch { /* First run or invalid local config: start with no MCP servers. */ }
  }

  private save(): void {
    fs.mkdirSync(require('path').dirname(this.configFile), { recursive: true });
    const temporary = `${this.configFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ servers: [...this.configs.values()] }, null, 2), 'utf8');
    fs.renameSync(temporary, this.configFile);
  }
}

function toTool(value: unknown): McpToolInfo | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as { name?: unknown; description?: unknown; inputSchema?: unknown };
  const name = typeof source.name === 'string' ? source.name : '';
  if (!name) return null;
  return { name, description: typeof source.description === 'string' ? source.description : undefined, inputSchema: source.inputSchema && typeof source.inputSchema === 'object' ? source.inputSchema as Record<string, unknown> : undefined };
}

function toResource(value: unknown): McpResourceInfo | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as { uri?: unknown; name?: unknown; mimeType?: unknown };
  const uri = typeof source.uri === 'string' ? source.uri : '';
  if (!uri) return null;
  return { uri, name: typeof source.name === 'string' ? source.name : undefined, mimeType: typeof source.mimeType === 'string' ? source.mimeType : undefined };
}
