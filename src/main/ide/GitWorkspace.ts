import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as iconv from 'iconv-lite';
import { execFile } from 'child_process';
import { FileWorkspace, IDEError } from './FileWorkspace';

export type IDEGitRef = 'index' | 'HEAD' | 'base' | 'ours' | 'theirs';
export interface IDEGitEntry {
  path: string; index: string; workTree: string; status: string;
  staged: boolean; conflict: boolean; untracked: boolean; ignored: boolean; originalPath?: string;
}
export interface IDEGitStatus {
  available: boolean; repository: boolean; branch?: string; head?: string; unborn?: boolean;
  files: IDEGitEntry[]; error?: string; errorCode?: string;
}
export interface IDEGitContent {
  path: string; ref?: IDEGitRef; exists: boolean; content: string; revision: string;
  oid?: string; binary: boolean; encoding?: string; conflict?: boolean; stages?: number[];
}
export interface IDEGitDiff { path: string; status?: IDEGitEntry; original: IDEGitContent; modified: IDEGitContent; }
interface Repository { root: string; git: string; project: string; prefix: string; head?: string; branch?: string; unborn: boolean; }
interface View { repo: Repository; directory: string; }
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
// Git for Windows accepts NUL; Node's \\.\nul device namespace is rejected by Git.
const GIT_NULL = process.platform === 'win32' ? 'NUL' : os.devNull;
const digest = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = (value: string): string => value.replace(/\\/g, '/');
const within = (root: string, target: string): boolean => { const rel = path.relative(root, target); return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Porcelain -z paths are UTF-8 bytes, never C-quoted; rename source is a separate record. */
export function parseIDEGitStatus(value: Buffer | string): { files: IDEGitEntry[]; branch?: string; head?: string; unborn?: boolean } {
  const result: { files: IDEGitEntry[]; branch?: string; head?: string; unborn?: boolean } = { files: [] };
  const records = (Buffer.isBuffer(value) ? value.toString('utf8') : value).split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    if (record.startsWith('# branch.head ')) { result.branch = record.slice(14); continue; }
    if (record.startsWith('# branch.oid ')) { const head = record.slice(13); result.unborn = head === '(initial)'; if (oidPattern.test(head)) result.head = head; continue; }
    if (record.startsWith('#') || record.startsWith('## ')) continue;
    let index: string, workTree: string, filename: string, originalPath: string | undefined;
    if (/^[12u] /.test(record)) {
      const count = record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10;
      let position = 0;
      for (let j = 0; j < count; j++) { position = record.indexOf(' ', position) + 1; if (!position) break; }
      if (!position) continue;
      index = record[2]; workTree = record[3]; filename = record.slice(position);
      if (record[0] === '2') originalPath = records[++i];
    } else if (/^[?!] /.test(record)) { index = workTree = record[0]; filename = record.slice(2); }
    else if (record.length >= 4 && record[2] === ' ') {
      index = record[0]; workTree = record[1]; filename = record.slice(3);
      if ('RC'.includes(index) || 'RC'.includes(workTree)) originalPath = records[++i];
    } else continue;
    index = index === '.' ? ' ' : index; workTree = workTree === '.' ? ' ' : workTree;
    const untracked = index === '?' && workTree === '?'; const ignored = index === '!' && workTree === '!';
    const conflict = index === 'U' || workTree === 'U' || ['AA', 'DD'].includes(index + workTree);
    result.files.push({ path: filename, index, workTree, status: conflict ? 'U' : untracked ? '?' : ignored ? '!' : workTree.trim() || index.trim() || ' ', staged: ![' ', '?', '!'].includes(index), conflict, untracked, ignored, ...(originalPath ? { originalPath } : {}) });
  }
  return result;
}

/** Git is scoped by picker-authorized FileWorkspace IDs, independently of chat permissions.
 * A disposable metadata view prevents status from invoking repository filters/fsmonitor/hooks.
 * Original HEAD/index/config are never written. cat-file reads raw blobs, without textconv.
 */
export class GitWorkspace {
  constructor(private readonly files: FileWorkspace) {}

  async status(id: string): Promise<IDEGitStatus> {
    this.files.project(id); // Authorization failures must never become an innocuous "not a repository".
    try {
      const repo = this.discover(id);
      if (!repo) return { available: true, repository: false, files: [] };
      return await this.withView(repo, async view => this.statusInView(id, view));
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { code?: string };
      const missing = err.code === 'ENOENT' && /(?:spawn|git)/i.test(err.message);
      return { available: !missing, repository: false, files: [], error: missing ? '未找到 Git，请安装 Git 后重试。' : err.message, errorCode: missing ? 'IDE_GIT_UNAVAILABLE' : err.code || 'IDE_GIT_ERROR' };
    }
  }

  async baseline(id: string, relative: string, ref: IDEGitRef = 'index'): Promise<IDEGitContent> {
    const normalized = this.validateFile(id, relative);
    return this.inRepository(id, async view => {
      const status = await this.statusInView(id, view);
      return this.baselineInView(id, view, normalized, ref, status.files.find(entry => entry.path === normalized));
    });
  }

  async diff(id: string, relative: string, ref: IDEGitRef = 'index'): Promise<IDEGitDiff> {
    const normalized = this.validateFile(id, relative);
    return this.inRepository(id, async view => {
      const status = (await this.statusInView(id, view)).files.find(entry => entry.path === normalized);
      const original = await this.baselineInView(id, view, normalized, ref, status);
      // Re-resolve after async Git calls; all working-tree reads remain FileWorkspace scoped.
      const target = this.files.resolve(id, normalized, true);
      let modified: IDEGitContent;
      try {
        const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new IDEError('IDE_GIT_FILE', '请选择项目内普通文件。');
        if (stat.size > MAX_TEXT) throw new IDEError('IDE_SIZE', '文件超过 4 MiB 编辑上限。');
        const bytes = fs.readFileSync(this.files.resolve(id, normalized));
        if (bytes.length > MAX_TEXT) throw new IDEError('IDE_SIZE', '文件超过 4 MiB 编辑上限。');
        modified = { path: normalized, exists: true, revision: digest(bytes), ...decodeText(bytes) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        modified = missingContent(normalized);
      }
      return { path: normalized, ...(status ? { status } : {}), original, modified };
    });
  }

  private validateFile(id: string, relative: string): string {
    if (typeof relative !== 'string' || !relative || relative.split(/[\\/]/).some(part => ['.git', '.ssh'].includes(part.toLowerCase()))) throw new IDEError('IDE_GIT_PATH', '请选择项目内文件。');
    this.files.resolve(id, relative, true);
    const normalized = slash(path.relative(this.files.project(id).root, path.resolve(this.files.project(id).root, relative)));
    if (!normalized || normalized === '.' || normalized.startsWith('../')) throw new IDEError('IDE_GIT_PATH', '请选择项目内文件。');
    return normalized;
  }

  private discover(id: string): Repository | null {
    const project = this.files.project(id).root; let root = project;
    for (;;) {
      const git = path.join(root, '.git'); let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(git); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (stat) {
        if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(git) !== git) throw new IDEError('IDE_GIT_METADATA', 'Git 元数据必须为仓库内真实目录，外部 gitfile 或链接不予读取。');
        this.assertMetadataTree(git, 'objects');
        const headInfo = this.readHead(git);
        return { root, git, project, prefix: slash(path.relative(root, project)), ...headInfo };
      }
      const parent = path.dirname(root); if (parent === root) return null; root = parent;
    }
  }

  private metadata(git: string, relative: string, optional = false, limit = 64 * 1024 * 1024): Buffer | undefined {
    const target = path.resolve(git, relative); if (!within(git, target)) throw new IDEError('IDE_GIT_METADATA', 'Git 元数据路径超出仓库。');
    let current = git;
    try {
      for (const part of path.relative(git, target).split(path.sep)) {
        current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new IDEError('IDE_GIT_METADATA', 'Git 元数据链接已阻止。');
      }
      if (fs.statSync(target).size > limit) throw new IDEError('IDE_GIT_SIZE', 'Git 元数据超过读取上限。');
      return fs.readFileSync(target);
    } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  private assertMetadataTree(git: string, relative: string): void {
    const directory = path.join(git, relative); let visited = 0;
    const walk = (target: string) => {
      if (fs.lstatSync(target).isSymbolicLink()) throw new IDEError('IDE_GIT_METADATA', 'Git 对象目录链接已阻止。');
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (++visited > 150000) throw new IDEError('IDE_GIT_SIZE', 'Git 对象数量超过本次读取上限。');
        if (entry.isSymbolicLink()) throw new IDEError('IDE_GIT_METADATA', 'Git 对象链接已阻止。');
        if (entry.isDirectory()) walk(path.join(target, entry.name));
      }
    };
    walk(directory);
    // Alternates and HTTP alternates can redirect object reads outside the authorized repository.
    for (const name of ['alternates', 'http-alternates']) if (this.metadata(git, `objects/info/${name}`, true)?.toString().trim()) throw new IDEError('IDE_GIT_METADATA', '外部 Git 对象存储不在项目授权范围。');
    if (this.metadata(git, 'commondir', true)) throw new IDEError('IDE_GIT_METADATA', '共享 Git 元数据不在项目授权范围。');
  }

  private readHead(git: string): { head?: string; branch?: string; unborn: boolean } {
    let text = this.metadata(git, 'HEAD', false, 4096)!.toString('utf8').trim(); let branch: string | undefined;
    for (let depth = 0; depth < 8 && text.startsWith('ref: '); depth++) {
      const ref = text.slice(5);
      if (!ref.startsWith('refs/') || ref.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(ref)) throw new IDEError('IDE_GIT_METADATA', 'Git HEAD 引用格式无效。');
      if (!branch) branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
      const loose = this.metadata(git, ref, true, 4096)?.toString('utf8').trim();
      if (loose) { text = loose; continue; }
      const packed = this.metadata(git, 'packed-refs', true, 16 * 1024 * 1024)?.toString('utf8').split('\n').map(line => line.trimEnd()).find(line => line.endsWith(' ' + ref));
      if (packed) { text = packed.split(' ')[0]; continue; }
      return { branch, unborn: true };
    }
    if (!oidPattern.test(text)) throw new IDEError('IDE_GIT_METADATA', 'Git HEAD 对象格式无效。');
    return { head: text, branch: branch || '(detached HEAD)', unborn: false };
  }

  private async inRepository<T>(id: string, action: (view: View) => Promise<T>): Promise<T> {
    const repo = this.discover(id); if (!repo) throw new IDEError('IDE_GIT_REPOSITORY', '此项目尚未初始化 Git 仓库。');
    return this.withView(repo, action);
  }

  private async withView<T>(repo: Repository, action: (view: View) => Promise<T>): Promise<T> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iexa-ide-git-'));
    try {
      fs.mkdirSync(path.join(directory, 'objects')); fs.mkdirSync(path.join(directory, 'refs')); fs.mkdirSync(path.join(directory, 'info'));
      fs.writeFileSync(path.join(directory, 'HEAD'), repo.head || 'ref: refs/heads/iexa-unborn\n');
      const index = this.metadata(repo.git, 'index', true); if (index) fs.writeFileSync(path.join(directory, 'index'), index);
      for (const entry of fs.readdirSync(repo.git)) if (/^sharedindex\.[a-f0-9]+$/.test(entry)) fs.writeFileSync(path.join(directory, entry), this.metadata(repo.git, entry)!);
      const excluded = this.metadata(repo.git, 'info/exclude', true); if (excluded) fs.writeFileSync(path.join(directory, 'info/exclude'), excluded);
      // Highest-precedence attributes suppress all custom clean/process drivers, including nested attributes.
      fs.writeFileSync(path.join(directory, 'info/attributes'), '* -filter\n');
      const config = this.metadata(repo.git, 'config', true, 2 * 1024 * 1024);
      let safeConfig = '[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = false\nhooksPath = ' + quoteConfig(GIT_NULL) + '\n';
      if (config) {
        const safe = await this.raw(repo.root, ['config', '--no-includes', '--file', path.join(repo.git, 'config'), '--null', '--get-regexp', '^(core\\.(autocrlf|eol|filemode|ignorecase|symlinks|trustctime|checkstat)|extensions\\.objectformat)$'], undefined, [0, 1]);
        const items = safe.toString('utf8').split('\0').map(item => item.split('\n'));
        for (const [key, value] of items) {
          if (/^core\.(autocrlf|eol|filemode|ignorecase|symlinks|trustctime|checkstat)$/.test(key || '') && /^(true|false|input|native|lf|crlf|default|minimal)$/i.test(value || '')) safeConfig += key.slice(5) + ' = ' + quoteConfig(value) + '\n';
        }
        if (items.some(([key, value]) => key === 'extensions.objectformat' && value === 'sha256')) safeConfig = safeConfig.replace('repositoryformatversion = 0', 'repositoryformatversion = 1') + '[extensions]\nobjectformat = sha256\n';
      }
      fs.writeFileSync(path.join(directory, 'config'), safeConfig);
      return await action({ repo, directory });
    } finally { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }

  private scoped(id: string, repo: Repository, candidate: string): string | undefined {
    if (!candidate || candidate.startsWith('/') || candidate.includes('\\') || candidate.split('/').some(part => part === '..' || part === '.git' || part === '.ssh')) return undefined;
    if (repo.prefix && !candidate.startsWith(repo.prefix + '/')) return undefined;
    const relative = repo.prefix ? candidate.slice(repo.prefix.length + 1) : candidate;
    if (!relative) return undefined;
    try { this.files.resolve(id, relative, true); return relative; } catch { return undefined; }
  }

  private async statusInView(id: string, view: View): Promise<IDEGitStatus> {
    const output = await this.run(view, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=all', ...(view.repo.prefix ? ['--', ':(top,literal)' + view.repo.prefix] : [])]);
    const files: IDEGitEntry[] = [];
    for (const entry of parseIDEGitStatus(output).files) {
      const relative = this.scoped(id, view.repo, entry.path); if (!relative) continue;
      const originalPath = entry.originalPath ? this.scoped(id, view.repo, entry.originalPath) : undefined;
      files.push({ ...entry, path: relative, ...(originalPath ? { originalPath } : {}) });
      if (!originalPath) delete files[files.length - 1].originalPath;
    }
    return { available: true, repository: true, branch: view.repo.branch, head: view.repo.head, unborn: view.repo.unborn, files };
  }

  private async baselineInView(id: string, view: View, relative: string, ref: IDEGitRef, status?: IDEGitEntry): Promise<IDEGitContent> {
    if (!['index', 'HEAD', 'base', 'ours', 'theirs'].includes(ref)) throw new IDEError('IDE_GIT_REF', '请选择 HEAD、index 或冲突版本。');
    this.validateFile(id, relative);
    const repoPath = slash(path.posix.join(view.repo.prefix, relative)); let oid: string | undefined; let mode: string | undefined;
    if (ref === 'HEAD') {
      if (!view.repo.head) return { ...missingContent(relative), ref };
      const source = status?.originalPath ? slash(path.posix.join(view.repo.prefix, status.originalPath)) : repoPath;
      const output = await this.run(view, ['ls-tree', '-z', 'HEAD', '--', ':(literal)' + source]);
      const record = output.toString('utf8').split('\0').find(line => line.slice(line.indexOf('\t') + 1) === source);
      const match = record?.match(/^(\d+) blob ([a-f0-9]+)\t/); mode = match?.[1]; oid = match?.[2];
    } else {
      const output = await this.run(view, ['ls-files', '--stage', '-z', '--', ':(top,literal)' + repoPath]);
      const stages = output.toString('utf8').split('\0').map(line => /^(\d+) ([a-f0-9]+) ([0-3])\t(.*)$/s.exec(line)).filter((match): match is RegExpExecArray => !!match && match[4] === repoPath);
      const stage = { index: 0, base: 1, ours: 2, theirs: 3 }[ref]; const match = stages.find(item => Number(item[3]) === stage); mode = match?.[1]; oid = match?.[2];
      if (!oid) return { ...missingContent(relative), ref, ...(stages.length ? { conflict: true, stages: stages.map(item => Number(item[3])) } : {}) };
    }
    if (!oid) return { ...missingContent(relative), ref };
    if (!oidPattern.test(oid)) throw new IDEError('IDE_GIT_OBJECT', 'Git 对象标识无效。');
    const size = Number((await this.run(view, ['cat-file', '-s', oid])).toString().trim());
    if (!Number.isFinite(size) || size > MAX_TEXT) throw new IDEError('IDE_SIZE', 'Git 基线文件超过 4 MiB 编辑上限。');
    const bytes = await this.run(view, ['cat-file', 'blob', oid]);
    return { path: relative, ref, exists: true, oid, revision: digest(bytes), ...(mode === '120000' ? { content: '', binary: true } : decodeText(bytes)) };
  }

  private run(view: View, args: string[]): Promise<Buffer> {
    // Validate metadata again before every use; do not accept a replaced .git or object link.
    if (fs.lstatSync(view.repo.git).isSymbolicLink() || fs.realpathSync.native(view.repo.git) !== view.repo.git) throw new IDEError('IDE_GIT_METADATA', 'Git 元数据目录已变化。');
    const objects = path.join(view.repo.git, 'objects');
    if (fs.lstatSync(objects).isSymbolicLink() || fs.realpathSync.native(objects) !== objects) throw new IDEError('IDE_GIT_METADATA', 'Git 对象目录已变化。');
    for (const name of ['alternates', 'http-alternates']) if (this.metadata(view.repo.git, `objects/info/${name}`, true)?.toString().trim()) throw new IDEError('IDE_GIT_METADATA', '外部 Git 对象存储不在项目授权范围。');
    return this.raw(view.repo.root, ['--git-dir=' + view.directory, '--work-tree=' + view.repo.root, ...args], { GIT_OBJECT_DIRECTORY: path.join(view.repo.git, 'objects') });
  }

  private raw(cwd: string, args: string[], extra?: NodeJS.ProcessEnv, accepted = [0]): Promise<Buffer> {
    const env = { ...process.env }; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', ...extra });
    return new Promise((resolve, reject) => {
      execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + GIT_NULL, '-c', 'submodule.recurse=false', ...args], { cwd, env, windowsHide: true, timeout: 15000, maxBuffer: MAX_OUTPUT, encoding: 'buffer' }, (error, stdout, stderr) => {
        if (error && !accepted.includes(Number(error.code))) { if (error.code === 'ENOENT') { reject(error); return; } reject(new IDEError('IDE_GIT_COMMAND', stderr.toString('utf8').trim() || error.message)); return; }
        resolve(stdout);
      });
    });
  }
}

function quoteConfig(value: string): string { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'; }
function missingContent(relative: string): IDEGitContent { return { path: relative, exists: false, content: '', revision: '', binary: false }; }
function decodeText(bytes: Buffer): Pick<IDEGitContent, 'content' | 'binary' | 'encoding'> {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { content: iconv.decode(bytes.subarray(2), 'utf16le'), binary: false, encoding: 'utf16le-bom' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { content: iconv.decode(bytes.subarray(2), 'utf16be'), binary: false, encoding: 'utf16be-bom' };
  if (bytes.includes(0)) return { content: '', binary: true };
  try { const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])); return { content: new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes), binary: false, encoding: bom ? 'utf8-bom' : 'utf8' }; }
  catch { return { content: '', binary: true }; }
}
