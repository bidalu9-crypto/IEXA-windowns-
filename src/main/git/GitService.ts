import { execFile } from 'child_process';
import * as path from 'path';

export interface GitFileStatus {
  path: string;
  index: string;
  workTree: string;
}

export interface GitStatus {
  available: boolean;
  repository: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  error?: string;
}

export interface GitDiff {
  path?: string;
  staged: boolean;
  content: string;
  truncated: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  committedAt: string;
}

const MAX_GIT_OUTPUT = 512 * 1024;

/**
 * Small, shell-free Git adapter for the project workbench. Keeping Git calls
 * here gives the UI structured data rather than forcing it to parse terminal
 * output, and makes path validation consistent for every mutating operation.
 */
export class GitService {
  async status(root: string): Promise<GitStatus> {
    try {
      let isRepository = false;
      try {
        isRepository = (await this.run(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
      } catch (error) {
        if (/ENOENT/i.test((error as Error).message)) throw error;
        return { available: true, repository: false, files: [] };
      }
      if (!isRepository) return { available: true, repository: false, files: [] };

      const [branchResult, statusResult, upstreamResult] = await Promise.all([
        this.run(root, ['branch', '--show-current']),
        this.run(root, ['status', '--porcelain=v1', '-z', '--branch']),
        this.run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ({ stdout: '', stderr: '' })),
      ]);
      const parsed = parseStatus(statusResult.stdout);
      const upstream = upstreamResult.stdout.trim() || undefined;
      let ahead: number | undefined;
      let behind: number | undefined;
      if (upstream) {
        try {
          const counts = (await this.run(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).stdout.trim().split(/\s+/).map(Number);
          behind = Number.isFinite(counts[0]) ? counts[0] : undefined;
          ahead = Number.isFinite(counts[1]) ? counts[1] : undefined;
        } catch { /* An unavailable remote should not break local status. */ }
      }

      return {
        available: true,
        repository: true,
        branch: branchResult.stdout.trim() || '(detached HEAD)',
        upstream,
        ahead,
        behind,
        files: parsed.files,
      };
    } catch (error) {
      const message = (error as Error).message;
      if (/ENOENT/i.test(message)) return { available: false, repository: false, files: [], error: '未找到 Git。请安装 Git 并重新打开 IEXA。' };
      return { available: true, repository: false, files: [], error: message };
    }
  }

  async diff(root: string, relativePath?: string, staged = false): Promise<GitDiff> {
    const args = ['diff', '--no-ext-diff', '--unified=3'];
    if (staged) args.push('--cached');
    const normalized = relativePath ? this.relativePath(root, relativePath) : undefined;
    if (normalized) args.push('--', normalized);
    const { stdout } = await this.run(root, args, MAX_GIT_OUTPUT + 1);
    return {
      path: normalized,
      staged,
      content: stdout.slice(0, MAX_GIT_OUTPUT),
      truncated: Buffer.byteLength(stdout) > MAX_GIT_OUTPUT,
    };
  }

  async stage(root: string, paths: string[]): Promise<void> {
    const normalized = this.relativePaths(root, paths);
    if (normalized.length === 0) throw new Error('请选择至少一个文件。');
    await this.run(root, ['add', '--', ...normalized]);
  }

  async unstage(root: string, paths: string[]): Promise<void> {
    const normalized = this.relativePaths(root, paths);
    if (normalized.length === 0) throw new Error('请选择至少一个文件。');
    await this.run(root, ['restore', '--staged', '--', ...normalized]);
  }

  async restore(root: string, paths: string[]): Promise<void> {
    const normalized = this.relativePaths(root, paths);
    if (normalized.length === 0) throw new Error('请选择至少一个文件。');
    await this.run(root, ['restore', '--worktree', '--', ...normalized]);
  }

  async stageAll(root: string): Promise<void> {
    await this.run(root, ['add', '--all']);
  }

  async branches(root: string): Promise<GitBranch[]> {
    const { stdout } = await this.run(root, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads']);
    return stdout.split(/\r?\n/).map((line) => {
      const [name, head] = line.split('\0');
      return { name: name || '', current: head === '*' };
    }).filter((branch) => Boolean(branch.name));
  }

  async switchBranch(root: string, name: string): Promise<void> {
    const branch = this.branchName(name);
    await this.run(root, ['switch', branch]);
  }

  async createBranch(root: string, name: string): Promise<void> {
    const branch = this.branchName(name);
    await this.run(root, ['switch', '-c', branch]);
  }

  async commit(root: string, message: string): Promise<void> {
    const subject = String(message || '').trim();
    if (!subject) throw new Error('请输入提交信息。');
    if (subject.length > 4_000) throw new Error('提交信息不能超过 4000 个字符。');
    await this.run(root, ['commit', '-m', subject], MAX_GIT_OUTPUT);
  }

  async pull(root: string): Promise<void> {
    await this.run(root, ['pull', '--ff-only'], MAX_GIT_OUTPUT);
  }

  async push(root: string): Promise<void> {
    await this.run(root, ['push'], MAX_GIT_OUTPUT);
  }

  async log(root: string, limit = 12): Promise<GitLogEntry[]> {
    const count = Math.max(1, Math.min(50, Math.floor(limit)));
    const { stdout } = await this.run(root, ['log', `-n${count}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e']);
    return stdout.split('\x1e').map((record) => {
      const [hash, shortHash, subject, author, committedAt] = record.trim().split('\x1f');
      return { hash: hash || '', shortHash: shortHash || '', subject: subject || '', author: author || '', committedAt: committedAt || '' };
    }).filter((entry) => Boolean(entry.hash));
  }

  private relativePaths(root: string, paths: string[]): string[] {
    return [...new Set(paths.map((candidate) => this.relativePath(root, candidate)))];
  }

  private relativePath(root: string, candidate: string): string {
    const value = String(candidate || '').replace(/\\/g, '/').trim();
    if (!value || value === '.' || path.isAbsolute(value)) throw new Error('Git 文件路径无效。');
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, value);
    const relative = path.relative(resolvedRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Git 文件路径超出项目目录。');
    return relative.replace(/\\/g, '/');
  }

  private branchName(value: string): string {
    const branch = String(value || '').trim();
    if (!branch || branch.length > 255 || /[\s~^:?*\\[\\]|]|\.\.|@\{|\/$|^\.|\.$/.test(branch)) {
      throw new Error('分支名称无效。');
    }
    return branch;
  }

  private run(cwd: string, args: string[], maxBuffer = MAX_GIT_OUTPUT): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, windowsHide: true, timeout: 15_000, maxBuffer }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}

function parseStatus(value: string): { files: GitFileStatus[] } {
  const files: GitFileStatus[] = [];
  const records = value.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.startsWith('## ')) continue;
    if (record.length < 4) continue;
    const index = record[0];
    const workTree = record[1];
    let filePath = record.slice(3);
    // Rename/copy porcelain records are emitted as "XY to\0from\0".
    if ((index === 'R' || index === 'C' || workTree === 'R' || workTree === 'C') && records[i + 1]) i++;
    if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
    files.push({ path: filePath.replace(/\\/g, '/'), index, workTree });
  }
  return { files };
}
