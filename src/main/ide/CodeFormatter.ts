import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { FileWorkspace, IDEError } from './FileWorkspace';
import { terminateProcessTree } from '../tools/shell/ProcessManager';

export const BUNDLED_RUFF_VERSION = '0.14.4';
const MAX_INPUT = 4 * 1024 * 1024;
const MAX_OUTPUT = 12 * 1024 * 1024;
export interface FormatDiagnostic {
  message: string; severity: 'error'; line: number; column: number; endLine: number; endColumn: number;
}
export interface CodeFormatOptions {
  /** Monaco's version ID for the exact input snapshot. Never apply to a newer model. */
  modelVersion: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  lineLength?: number;
}
export interface CodeFormatResult {
  workspaceId: string; path: string; modelVersion: number; inputHash: string;
  content: string; changed: boolean;
  formatter: { name: 'ruff' | 'black'; version: string; source: 'project' | 'system' | 'bundled' };
  diagnostics: FormatDiagnostic[];
}
export class IDEFormatError extends IDEError {
  constructor(code: string, message: string, public readonly diagnostics: FormatDiagnostic[] = []) { super(code, message); }
}
interface FormatterOptions {
  env?: NodeJS.ProcessEnv;
  /** A main-process controlled location. null disables the bundled fallback. */
  bundledRuffPath?: string | null;
}
interface Command { executable: string; prefix: string[]; name: 'ruff' | 'black'; source: 'project' | 'system' | 'bundled'; }
interface Tool extends Command { version: string; }
interface ProcessResult { code: number | null; stdout: string; stderr: string; }
interface Operation { deadline: number; signal?: AbortSignal; }

/** Syntax-aware Python formatting on stdin. No source, cache or temporary file is
 * written to the user's project, and neither Python code nor project hooks run. */
export class CodeFormatter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bundledRuffPath: string | null | undefined;
  private active = 0;
  constructor(private readonly files: FileWorkspace, options: FormatterOptions = {}) {
    this.env = { ...process.env, ...options.env };
    const overridePath = Object.entries(options.env || {}).find(([key]) => key.toLowerCase() === 'path');
    if (overridePath) {
      for (const key of Object.keys(this.env)) if (key.toLowerCase() === 'path') delete this.env[key];
      this.env.PATH = overridePath[1];
    }
    this.bundledRuffPath = options.bundledRuffPath;
  }

  async format(workspaceId: string, relative: string, content: string, options: CodeFormatOptions): Promise<CodeFormatResult> {
    const root = this.files.project(workspaceId).root;
    const file = this.files.resolve(workspaceId, relative, true);
    if (!/\.(?:py|pyi|pyw)$/i.test(file)) throw new IDEFormatError('IDE_FORMAT_LANGUAGE', '此格式化入口用于 Python（.py / .pyi / .pyw）。');
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_INPUT || content.includes('\0')) throw new IDEFormatError('IDE_FORMAT_SIZE', '请格式化 4 MiB 以内的 Python 文本。');
    if (!options || !Number.isSafeInteger(options.modelVersion) || options.modelVersion < 1) throw new IDEFormatError('IDE_FORMAT_VERSION', '格式化请求缺少有效的编辑版本。');
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000)) throw new IDEFormatError('IDE_FORMAT_OPTIONS', '格式化超时应在 1–30000 毫秒之间。');
    if (options.lineLength !== undefined && (!Number.isInteger(options.lineLength) || options.lineLength < 40 || options.lineLength > 320)) throw new IDEFormatError('IDE_FORMAT_OPTIONS', '行宽应在 40–320 个字符之间。');
    const operation = { deadline: Date.now() + (options.timeoutMs ?? 10000), signal: options.signal };
    this.check(operation);
    if (this.active >= 2) throw new IDEFormatError('IDE_FORMAT_BUSY', '已有两个格式化任务，请取消旧任务或稍后重试。');
    this.active++;
    try {
      const tool = await this.discover(workspaceId, root, operation);
      this.check(operation);
      this.files.resolve(workspaceId, relative, true);
      const args = tool.name === 'ruff'
        ? ['format', '--no-cache', '--stdin-filename', file, ...(options.lineLength ? ['--line-length', String(options.lineLength)] : []), '-']
        : ['--quiet', '--stdin-filename', file, ...(options.lineLength ? ['--line-length', String(options.lineLength)] : []), '-'];
      const result = await this.run(tool, args, content, root, operation);
      this.check(operation);
      // Authorization may have changed while a child process was running.
      this.files.resolve(workspaceId, relative, true);
      if (result.code !== 0) {
        let diagnostics = parseDiagnostics(result.stderr || result.stdout);
        // Black's tokenize errors report a line without a column. Ask the
        // interpreter's parser for its actual SyntaxError range, never infer
        // indentation or execute the document to obtain a diagnostic.
        if (tool.name === 'black' && !diagnostics.length) diagnostics = await this.pythonDiagnostics(tool, content, root, operation);
        throw new IDEFormatError(diagnostics.length ? 'IDE_FORMAT_SYNTAX' : 'IDE_FORMAT_FAILED',
          diagnostics.length ? `Python 语法有误，已保留原文：${diagnostics[0].message}` : `格式化失败，已保留原文：${(result.stderr || result.stdout).trim().slice(0, 4096) || `退出码 ${result.code}`}`,
          diagnostics);
      }
      if (content.trim() && !result.stdout.trim()) throw new IDEFormatError('IDE_FORMAT_OUTPUT', '格式化工具没有返回有效内容，已保留原文。');
      return {
        workspaceId, path: path.relative(root, file).replace(/\\/g, '/'), modelVersion: options.modelVersion,
        inputHash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
        content: result.stdout, changed: result.stdout !== content,
        formatter: { name: tool.name, version: tool.version, source: tool.source }, diagnostics: [],
      };
    } finally { this.active--; }
  }

  private check(operation: Operation): void {
    if (operation.signal?.aborted) throw new IDEFormatError('IDE_FORMAT_CANCELLED', '格式化已取消，已保留原文。');
    if (Date.now() >= operation.deadline) throw new IDEFormatError('IDE_FORMAT_TIMEOUT', '格式化超时，已保留原文；可缩小文件或重试。');
  }

  private async discover(workspaceId: string, root: string, operation: Operation): Promise<Tool> {
    const commands: Command[] = [];
    const seen = new Set<string>();
    const add = (executable: string | undefined, prefix: string[], name: Command['name'], source: Command['source']) => {
      if (!executable) return;
      try {
        if (!fs.statSync(executable).isFile()) return;
        executable = fs.realpathSync.native(executable);
        const key = `${executable}\0${prefix.join('\0')}\0${name}`;
        if (!seen.has(key)) { seen.add(key); commands.push({ executable, prefix, name, source }); }
      } catch { /* a missing tool is followed by the next real candidate */ }
    };
    const addPython = (executable: string | undefined, source: Command['source']) => {
      if (!executable) return;
      const prefix = /(?:^|[\\/])py(?:\.exe)?$/i.test(executable) ? ['-3'] : [];
      for (const name of ['ruff', 'black'] as const) add(executable, [...prefix, '-I', '-B', '-X', 'utf8', '-m', name], name, source);
    };
    for (const directory of ['.venv', 'venv']) {
      const bin = process.platform === 'win32' ? `${directory}/Scripts` : `${directory}/bin`;
      const local = (name: string) => {
        try { return this.files.resolve(workspaceId, `${bin}/${name}${process.platform === 'win32' ? '.exe' : ''}`); } catch { return undefined; }
      };
      add(local('ruff'), [], 'ruff', 'project');
      add(local('black'), [], 'black', 'project');
      addPython(local('python'), 'project');
    }
    if (this.bundledRuffPath !== null) {
      const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      const executable = process.platform === 'win32' ? 'ruff.exe' : 'ruff';
      const bundled = this.bundledRuffPath ? [this.bundledRuffPath] : [
        resources ? path.join(resources, 'app.asar.unpacked', 'resources', 'formatters', executable) : '',
        resources ? path.join(resources, 'formatters', executable) : '',
        path.resolve(__dirname, '../../../resources/formatters', executable).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
      ];
      for (const candidate of bundled) add(candidate, [], 'ruff', 'bundled');
    }
    add(this.env.IEXA_RUFF_EXECUTABLE, [], 'ruff', 'system');
    add(this.findExecutable('ruff'), [], 'ruff', 'system');
    add(this.findExecutable('black'), [], 'black', 'system');
    addPython(this.env.IEXA_PYTHON_EXECUTABLE, 'system');
    for (const executable of ['python', 'python3', ...(process.platform === 'win32' ? ['py'] : [])]) addPython(this.findExecutable(executable), 'system');
    for (const command of commands) {
      this.check(operation);
      try {
        const result = await this.run(command, ['--version'], '', root, operation, 1500);
        const match = (result.stdout + '\n' + result.stderr).match(command.name === 'ruff' ? /\bruff\s+(\d+\.\d+\.\d+[^\s]*)/i : /\bblack(?:,|\s)+\s*(\d+\.\d+\.\d+[^\s]*)/i);
        if (result.code === 0 && match) {
          if (command.source === 'bundled' && match[1] !== BUNDLED_RUFF_VERSION) continue;
          return { ...command, version: match[1] };
        }
      } catch (error) {
        this.check(operation);
        if (!(error instanceof IDEFormatError) || !['IDE_FORMAT_START', 'IDE_FORMAT_PROBE_TIMEOUT'].includes(error.code)) throw error;
      }
    }
    throw new IDEFormatError('IDE_FORMAT_ENVIRONMENT', '未找到可用的 Python 格式化器。请在项目环境运行 python -m pip install ruff（或 black），或重新安装含 Ruff 的 IEXA-WIN；也可配置 IEXA_RUFF_EXECUTABLE / IEXA_PYTHON_EXECUTABLE。');
  }

  private findExecutable(name: string): string | undefined {
    const search = Object.entries(this.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    for (const directory of search.split(path.delimiter).slice(0, 200)) {
      if (!directory.trim()) continue;
      for (const suffix of process.platform === 'win32' ? ['.exe'] : ['']) {
        const file = path.join(directory.replace(/^"|"$/g, ''), name + suffix);
        // Windows Store aliases can launch an installer instead of a tool.
        if (/[/\\]Microsoft[/\\]WindowsApps[/\\]/i.test(file)) continue;
        try { if (fs.statSync(file).isFile()) return fs.realpathSync.native(file); } catch { /* next PATH entry */ }
      }
    }
    return undefined;
  }

  private async pythonDiagnostics(tool: Tool, content: string, cwd: string, operation: Operation): Promise<FormatDiagnostic[]> {
    const moduleIndex = tool.prefix.indexOf('-m');
    const candidates = moduleIndex >= 0 ? [{ executable: tool.executable, prefix: tool.prefix.slice(0, moduleIndex) }] : [
      { executable: path.join(path.dirname(tool.executable), process.platform === 'win32' ? 'python.exe' : 'python'), prefix: ['-I', '-B', '-X', 'utf8'] },
      { executable: this.env.IEXA_PYTHON_EXECUTABLE || this.findExecutable('python') || this.findExecutable('python3'), prefix: ['-I', '-B', '-X', 'utf8'] },
    ];
    const script = "import ast,json,sys\ntry:\n ast.parse(sys.stdin.buffer.read().decode('utf-8'))\nexcept SyntaxError as e:\n print(json.dumps({'message':e.msg,'severity':'error','line':e.lineno or 1,'column':max(1,e.offset or 1),'endLine':e.end_lineno or e.lineno or 1,'endColumn':max((e.offset or 1)+1,e.end_offset or 1)}))\n";
    for (const candidate of candidates) {
      if (!candidate.executable || !fs.existsSync(candidate.executable)) continue;
      try {
        const parsed = await this.run({ ...tool, executable: candidate.executable, prefix: candidate.prefix }, ['-c', script], content, cwd, operation, 1500);
        const value = JSON.parse(parsed.stdout);
        if (parsed.code === 0 && value?.severity === 'error' && typeof value.message === 'string' && ['line', 'column', 'endLine', 'endColumn'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 1)) return [value];
      } catch (error) {
        this.check(operation);
        if (error instanceof IDEFormatError && error.code === 'IDE_FORMAT_CANCELLED') throw error;
        // An unavailable parser must not turn a failed formatter into success.
      }
    }
    return [];
  }

  private run(command: Command, args: string[], input: string, cwd: string, operation: Operation, probeMs?: number): Promise<ProcessResult> {
    this.check(operation);
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      let finished = false;
      let stdoutBytes = 0, stderrBytes = 0;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); operation.signal?.removeEventListener('abort', abort); };
      const fail = (error: IDEFormatError) => {
        if (finished) return;
        finished = true; cleanup();
        // Bound cleanup as well as formatting; never leave a Python/formatter
        // child alive after a cancelled or timed-out request.
        void terminateProcessTree(child, 500).catch(() => {}).then(() => reject(error));
      };
      const abort = () => fail(new IDEFormatError('IDE_FORMAT_CANCELLED', '格式化已取消，已保留原文。'));
      try {
        child = spawn(command.executable, [...command.prefix, ...args], {
          cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...this.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', RUFF_NO_CACHE: '1', NO_COLOR: '1' },
        });
      } catch (error) { reject(new IDEFormatError('IDE_FORMAT_START', `启动格式化器失败：${(error as Error).message}`)); return; }
      child.once('error', error => {
        if (finished) return;
        finished = true; cleanup(); reject(new IDEFormatError('IDE_FORMAT_START', `启动格式化器失败：${error.message}`));
      });
      const collect = (chunks: Buffer[], chunk: Buffer, isError: boolean) => {
        if (finished) return;
        if (isError) stderrBytes += chunk.length; else stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT || stderrBytes > 256 * 1024) fail(new IDEFormatError('IDE_FORMAT_OUTPUT', '格式化器输出超过上限，已保留原文。'));
        else chunks.push(chunk);
      };
      child.stdout!.on('data', chunk => collect(stdout, chunk, false));
      child.stderr!.on('data', chunk => collect(stderr, chunk, true));
      child.once('close', code => {
        if (finished) return;
        finished = true; cleanup();
        resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
      // A syntax error may close stdin before Node finishes sending a long file.
      child.stdin!.on('error', () => {});
      operation.signal?.addEventListener('abort', abort, { once: true });
      if (operation.signal?.aborted) { abort(); return; }
      const remaining = operation.deadline - Date.now();
      const probeLimited = probeMs !== undefined && probeMs < remaining;
      timer = setTimeout(() => fail(new IDEFormatError(probeLimited ? 'IDE_FORMAT_PROBE_TIMEOUT' : 'IDE_FORMAT_TIMEOUT', '格式化超时，已保留原文。')), Math.max(1, Math.min(remaining, probeMs ?? remaining)));
      child.stdin!.end(input, 'utf8');
    });
  }
}

function parseDiagnostics(stderr: string): FormatDiagnostic[] {
  const raw = stderr.trim().slice(0, 4096);
  const ruff = raw.match(/Failed to parse [\s\S]*?:(\d+):(\d+):\s*([^\n\r]+)/i);
  const black = raw.match(/Cannot parse(?:[^\n\r]*?):\s*(\d+):(\d+):\s*([^\n\r]*)/i);
  const match = ruff || black;
  if (!match) return [];
  const line = Math.max(1, Number(match[1]));
  const column = Math.max(1, Number(match[2]) + (ruff ? 0 : 1));
  return [{ message: match[3].trim() || raw, severity: 'error', line, column, endLine: line, endColumn: column + 1 }];
}
