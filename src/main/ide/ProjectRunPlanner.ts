import * as fs from 'fs';
import * as path from 'path';
import { FileWorkspace, IDEError } from './FileWorkspace';

export type ProjectRunKind = 'file' | 'project' | 'build' | 'test';
export interface ProjectRunRequest { kind: ProjectRunKind; path?: string; script?: string; }
export interface ProjectRunPlan {
  label: string; kind: ProjectRunKind; cwd: string; shell: 'powershell';
  command: string; executable: string; args: string[]; exitMarker: string;
  language: string; entry?: string; script?: string; scriptCommand?: string;
}
interface PlannerOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; }
const EXIT_MARKER = 'IEXA_IDE_EXIT_CODE';
/** PowerShell literal strings do not expand $, &, backticks or subexpressions. */
export function quotePowerShellArgument(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new IDEError('IDE_RUN_ARGUMENT', '运行参数包含无效字符。');
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Builds reviewable terminal commands only. It never starts a program, probes a
 * port, downloads a runner, or changes process/system environment variables. */
export class ProjectRunPlanner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  constructor(private readonly files: FileWorkspace, options: PlannerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
  }
  plan(workspaceId: string, request: ProjectRunRequest): ProjectRunPlan {
    const root = this.files.project(workspaceId).root;
    if (!request || !['file', 'project', 'build', 'test'].includes(request.kind)) throw new IDEError('IDE_RUN_KIND', '请选择运行当前文件、运行项目、构建或测试。');
    if (request.path !== undefined && typeof request.path !== 'string') throw new IDEError('IDE_RUN_PATH', '运行入口必须是项目内相对路径。');
    if (request.script !== undefined && (typeof request.script !== 'string' || !request.script || request.script.length > 200 || request.script.includes('\0'))) throw new IDEError('IDE_RUN_SCRIPT', '项目脚本名称无效。');
    const finish = (executable: string, args: string[], language: string, label: string, extra: Partial<ProjectRunPlan> = {}): ProjectRunPlan => {
      const invoke = '& ' + [executable, ...args].map(quotePowerShellArgument).join(' ');
      // Reset stale native exit state, capture immediately, and keep the user's
      // terminal alive. Failed invocation reports 1 instead of an old success.
      const command = `$global:LASTEXITCODE = 0; try { Set-Location -LiteralPath ${quotePowerShellArgument(root)} -ErrorAction Stop; ${invoke}; $iexaRunExitCode = $LASTEXITCODE; if ($null -eq $iexaRunExitCode) { $iexaRunExitCode = 0 } } catch { $iexaRunExitCode = $LASTEXITCODE; if ($null -eq $iexaRunExitCode -or $iexaRunExitCode -eq 0) { $iexaRunExitCode = 1 }; Write-Error $_ -ErrorAction Continue }; Write-Output ('${EXIT_MARKER}=' + $iexaRunExitCode); $global:LASTEXITCODE = $iexaRunExitCode`;
      return { label, kind: request.kind, cwd: root, shell: 'powershell', command, executable, args, exitMarker: EXIT_MARKER, language, ...extra };
    };
    const read = (relative: string) => this.files.read(workspaceId, relative);
    const exists = (relative: string) => { try { return fs.statSync(this.files.resolve(workspaceId, relative)).isFile(); } catch { return false; } };
    const resolveText = (relative: string) => { read(relative); return this.files.resolve(workspaceId, relative); };
    const executable = (names: string[], label: string, configured?: string) => this.executable(names, label, configured);
    const node = () => executable(['node'], 'Node.js；请安装系统 Node.js，或将 IEXA_NODE_EXECUTABLE 设为 node.exe 的完整路径', this.env.IEXA_NODE_EXECUTABLE);
    const python = () => {
      for (const relative of this.platform === 'win32' ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe'] : ['.venv/bin/python', 'venv/bin/python']) {
        if (exists(relative)) return { executable: this.files.resolve(workspaceId, relative), prefix: [] as string[] };
      }
      const found = executable(['python', 'python3', ...(this.platform === 'win32' ? ['py'] : [])], 'Python 3；请安装 Python，或在项目中建立 .venv', this.env.IEXA_PYTHON_EXECUTABLE);
      return { executable: found, prefix: /^py(?:\.exe)?$/i.test(path.basename(found)) ? ['-3'] : [] };
    };
    if (request.kind === 'file') {
      if (request.script) throw new IDEError('IDE_RUN_SCRIPT', '运行当前文件不接受项目脚本名称，请选择运行项目任务。');
      if (!request.path) throw new IDEError('IDE_RUN_PATH', '请先打开要运行的代码文件。');
      const entry = resolveText(request.path), extension = path.extname(entry).toLowerCase();
      if (extension === '.py') { const runtime = python(); return finish(runtime.executable, [...runtime.prefix, '-u', entry], 'python', `运行 ${request.path}`, { entry: request.path }); }
      if (['.js', '.mjs', '.cjs'].includes(extension)) return finish(node(), [entry], 'javascript', `运行 ${request.path}`, { entry: request.path });
      if (['.ts', '.mts', '.cts', '.tsx'].includes(extension)) {
        const local = ['node_modules/tsx/dist/cli.mjs', 'node_modules/tsx/dist/cli.cjs'].find(exists);
        if (!local) throw new IDEError('IDE_RUN_TYPESCRIPT', '当前项目没有本地 tsx。请安装项目的 tsx 依赖，或配置并选择 package.json 中的 TypeScript 运行脚本；也可以在终端运行项目自己的命令。');
        return finish(node(), [resolveText(local), entry], 'typescript', `运行 ${request.path}`, { entry: request.path });
      }
      if (extension === '.go') return finish(executable(['go'], 'Go SDK'), ['run', entry], 'go', `运行 ${request.path}`, { entry: request.path });
      if (extension === '.ps1') return finish(executable(this.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'], 'PowerShell'), ['-NoProfile', '-File', entry], 'powershell', `运行 ${request.path}`, { entry: request.path });
      throw new IDEError('IDE_RUN_FILE_TYPE', `当前文件 ${extension || '无扩展名'} 没有已配置的运行方式。请使用项目脚本、构建/测试，或在终端选择语言工具。HTML/CSS 请使用网页预览。`);
    }
    const explicit = request.path ? resolveText(request.path) : undefined;
    const explicitName = explicit ? path.basename(explicit).toLowerCase() : '';
    if ((!explicit || explicitName === 'package.json') && exists(request.path || 'package.json')) {
      const manifest = request.path || 'package.json'; let pkg: any;
      try { pkg = JSON.parse(read(manifest).content.replace(/^\uFEFF/, '')); } catch (error) { throw new IDEError('IDE_RUN_MANIFEST', `读取 package.json 失败：${(error as Error).message}`); }
      const scripts = pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
      const selected = request.script || (request.kind === 'project' ? ['start', 'dev'].find(name => typeof scripts[name] === 'string') : request.kind);
      if (!selected || typeof scripts[selected] !== 'string' || !scripts[selected].trim()) throw new IDEError('IDE_RUN_SCRIPT', request.kind === 'project' ? 'package.json 没有 start/dev 运行入口。请选择项目中已存在的脚本，或在终端执行自定义命令。' : `package.json 没有 ${selected || request.kind} 脚本。请先配置对应任务或使用终端。`);
      const runtime = node(), npm = this.npm(runtime);
      return finish(runtime, [npm, '--prefix', path.dirname(this.files.resolve(workspaceId, manifest)), 'run', selected], 'node', `运行 npm ${selected}`, { entry: manifest, script: selected, scriptCommand: scripts[selected] });
    }
    if (request.script && (explicit ? explicitName !== 'pyproject.toml' : !exists('pyproject.toml'))) throw new IDEError('IDE_RUN_SCRIPT', '此项目没有可选择脚本的 package.json 或 pyproject.toml。请使用终端执行明确的命令。');
    const csharpProjects: string[] = explicit && /\.csproj$/i.test(explicit) ? [request.path!] : !explicit ? this.files.list(workspaceId).entries.filter(entry => !entry.directory && /\.csproj$/i.test(entry.name)).map(entry => entry.path) : [];
    if (csharpProjects.length > 1) throw new IDEError('IDE_RUN_ENTRY', '检测到多个 .csproj，请指定要运行、构建或测试的项目文件。');
    if (csharpProjects.length === 1) {
      const entry = resolveText(csharpProjects[0]), runtime = executable(['dotnet'], '.NET SDK');
      return finish(runtime, request.kind === 'project' ? ['run', '--project', entry] : [request.kind, entry], 'dotnet', `${request.kind === 'project' ? '运行' : request.kind === 'build' ? '构建' : '测试'} .NET 项目`, { entry: csharpProjects[0] });
    }
    if ((!explicit || explicitName === 'go.mod') && exists(request.path || 'go.mod')) {
      const entry = request.path || 'go.mod', directory = path.dirname(resolveText(entry));
      return finish(executable(['go'], 'Go SDK'), [...(directory === root ? [] : ['-C', directory]), request.kind === 'project' ? 'run' : request.kind, request.kind === 'test' ? './...' : '.'], 'go', `${request.kind === 'project' ? '运行' : request.kind === 'build' ? '构建' : '测试'} Go 项目`, { entry });
    }
    if ((!explicit || explicitName === 'cargo.toml') && exists(request.path || 'Cargo.toml')) {
      const entry = resolveText(request.path || 'Cargo.toml'); return finish(executable(['cargo'], 'Rust Cargo'), [request.kind === 'project' ? 'run' : request.kind, '--manifest-path', entry], 'rust', `${request.kind === 'project' ? '运行' : request.kind === 'build' ? '构建' : '测试'} Rust 项目`, { entry: request.path || 'Cargo.toml' });
    }
    if (!explicit && !exists('pyproject.toml') && !exists('__main__.py') && exists('main.py')) {
      if (request.kind !== 'project') throw new IDEError('IDE_RUN_ENTRY', '已识别 Python main.py 运行入口。构建请配置 pyproject.toml；测试请配置项目测试工具或在终端执行测试命令。');
      const runtime = python(); return finish(runtime.executable, [...runtime.prefix, '-u', resolveText('main.py')], 'python', '运行 Python main.py', { entry: 'main.py' });
    }
    if ((!explicit || explicitName === 'pyproject.toml' || explicitName === '__main__.py') && (exists(request.path || 'pyproject.toml') || exists('__main__.py'))) {
      if (request.script && request.kind !== 'project') throw new IDEError('IDE_RUN_SCRIPT', 'pyproject.toml 的脚本入口请使用运行项目；构建与测试分别使用 Python 构建和测试工具。');
      const runtime = python(), manifest = explicitName === 'pyproject.toml' ? request.path! : 'pyproject.toml';
      const config = exists(manifest) ? read(manifest).content : '', directory = path.dirname(this.files.resolve(workspaceId, manifest, !exists(manifest)));
      if (request.kind === 'build') {
        if (!config) throw new IDEError('IDE_RUN_ENTRY', 'Python 构建需要 pyproject.toml。请配置构建任务或使用终端。');
        return finish(runtime.executable, [...runtime.prefix, '-u', '-m', 'build', path.dirname(this.files.resolve(workspaceId, manifest))], 'python', '构建 Python 项目', { entry: manifest });
      }
      if (request.kind === 'test') return finish(runtime.executable, [...runtime.prefix, '-u', '-m', /\[tool\.pytest(?:\.|\])/.test(config) ? 'pytest' : 'unittest', ...(/\[tool\.pytest(?:\.|\])/.test(config) ? [directory] : ['discover', '-s', directory])], 'python', '测试 Python 项目', { entry: manifest });
      const main = explicitName === '__main__.py' ? request.path! : path.relative(root, path.join(directory, '__main__.py'));
      if (!request.script && exists(main)) return finish(runtime.executable, [...runtime.prefix, '-u', resolveText(main)], 'python', '运行 Python 项目', { entry: main });
      // A bounded TOML subset: only the standard [project.scripts] table with
      // quoted module:callable values. Unsupported TOML remains an explicit error.
      const table = config.match(/^\[project\.scripts\]\s*\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m)?.[1] || '';
      const scripts = new Map<string, string>();
      for (const line of table.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:([A-Za-z0-9_.-]+)|"([^"]+)"|'([^']+)')\s*=\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']\s*(?:#.*)?$/);
        if (match) scripts.set(match[1] || match[2] || match[3], match[4]);
      }
      const selected = request.script || (scripts.size === 1 ? [...scripts.keys()][0] : undefined), entry = selected && scripts.get(selected);
      if (!entry) throw new IDEError('IDE_RUN_ENTRY', 'Python 项目没有明确的 __main__.py 入口，或 pyproject.toml 的 [project.scripts] 入口未选定。请指定脚本或在终端运行模块。');
      const code = "import importlib,operator,sys; sys.path.insert(0,sys.argv.pop(1)); entry=sys.argv.pop(1); module,attr=entry.split(':',1); sys.exit(operator.attrgetter(attr)(importlib.import_module(module))())";
      return finish(runtime.executable, [...runtime.prefix, '-u', '-c', code, directory, entry], 'python', `运行 Python ${selected}`, { entry: manifest, script: selected });
    }
    if ((!explicit || explicitName === 'cmakelists.txt') && exists(request.path || 'CMakeLists.txt')) {
      if (request.kind === 'project') throw new IDEError('IDE_RUN_ENTRY', 'CMake 项目请先构建，再在终端运行具体的可执行目标。');
      const entry = request.path || 'CMakeLists.txt', directory = path.dirname(resolveText(entry));
      const build = this.files.resolve(workspaceId, path.relative(root, path.join(directory, 'build')), true);
      if (!fs.existsSync(build) || !fs.statSync(build).isDirectory()) throw new IDEError('IDE_RUN_CMAKE', 'CMake build 目录尚未配置。请先在终端执行 cmake -S . -B build，再使用构建或测试。');
      return request.kind === 'build' ? finish(executable(['cmake'], 'CMake'), ['--build', build], 'cmake', '构建 CMake 项目', { entry }) : finish(executable(['ctest'], 'CMake CTest'), ['--test-dir', build, '--output-on-failure'], 'cmake', '测试 CMake 项目', { entry });
    }
    throw new IDEError('IDE_RUN_ENTRY', '没有识别到可运行入口。支持当前 Python/JavaScript/Go/PowerShell 文件，以及 package.json、pyproject.toml、.csproj、go.mod、Cargo.toml、CMake 项目；请配置项目任务或打开终端执行自己的命令。');
  }
  private executable(names: string[], label: string, configured?: string): string {
    if (configured !== undefined) {
      if (!path.isAbsolute(configured) || !this.isFile(configured) || /(?:^|[\\/])electron(?:\.exe)?$/i.test(configured)) throw new IDEError('IDE_RUN_ENVIRONMENT', `${label}：配置的可执行文件路径无效，请检查环境变量。`);
      return fs.realpathSync.native(configured);
    }
    const value = Object.entries(this.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    const directories = value.split(this.platform === 'win32' ? ';' : ':').map(directory => directory.replace(/^"|"$/g, '')).filter(directory => path.isAbsolute(directory));
    for (const name of names) for (const directory of directories) for (const suffix of this.platform === 'win32' ? ['.exe', ''] : ['']) {
      const candidate = path.join(directory, name + suffix);
      if (this.isFile(candidate)) return fs.realpathSync.native(candidate);
    }
    throw new IDEError('IDE_RUN_ENVIRONMENT', `未检测到 ${label}。请安装或配置对应运行环境后重试；也可打开终端查看环境。`);
  }
  private isFile(file: string): boolean { try { return fs.statSync(file).isFile(); } catch { return false; } }
  private npm(node: string): string {
    const candidates = [this.env.npm_execpath || '', path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')];
    const executable = candidates.find(file => path.isAbsolute(file) && /npm-cli\.js$/i.test(file) && this.isFile(file));
    if (!executable) throw new IDEError('IDE_RUN_ENVIRONMENT', '未检测到 npm-cli.js。请安装包含 npm 的 Node.js，或使用项目自己的终端命令。');
    return fs.realpathSync.native(executable);
  }
}
