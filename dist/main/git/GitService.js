"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitService = void 0;
const DiagnosticDecoder_1 = require("../encoding/DiagnosticDecoder");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const MAX_GIT_OUTPUT = 512 * 1024;
/**
 * Small, shell-free Git adapter for the project workbench. Keeping Git calls
 * here gives the UI structured data rather than forcing it to parse terminal
 * output, and makes path validation consistent for every mutating operation.
 */
class GitService {
    async status(root) {
        try {
            let isRepository = false;
            try {
                isRepository = (await this.run(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
            }
            catch (error) {
                if (/ENOENT/i.test(error.message))
                    throw error;
                return { available: true, repository: false, files: [] };
            }
            if (!isRepository)
                return { available: true, repository: false, files: [] };
            const [branchResult, statusResult, upstreamResult] = await Promise.all([
                this.run(root, ['branch', '--show-current']),
                this.run(root, ['status', '--porcelain=v1', '-z', '--branch']),
                this.run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ({ stdout: '', stderr: '' })),
            ]);
            const parsed = parseStatus(statusResult.stdout);
            const upstream = upstreamResult.stdout.trim() || undefined;
            let ahead;
            let behind;
            if (upstream) {
                try {
                    const counts = (await this.run(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).stdout.trim().split(/\s+/).map(Number);
                    behind = Number.isFinite(counts[0]) ? counts[0] : undefined;
                    ahead = Number.isFinite(counts[1]) ? counts[1] : undefined;
                }
                catch { /* An unavailable remote should not break local status. */ }
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
        }
        catch (error) {
            const message = error.message;
            if (/ENOENT/i.test(message))
                return { available: false, repository: false, files: [], error: '未找到 Git。请安装 Git 并重新打开 iExA。' };
            return { available: true, repository: false, files: [], error: message };
        }
    }
    async diff(root, relativePath, staged = false) {
        const args = ['diff', '--no-ext-diff', '--unified=3'];
        if (staged)
            args.push('--cached');
        const normalized = relativePath ? this.relativePath(root, relativePath) : undefined;
        if (normalized)
            args.push('--', normalized);
        const { stdout } = await this.run(root, args, MAX_GIT_OUTPUT + 1);
        return {
            path: normalized,
            staged,
            content: stdout.slice(0, MAX_GIT_OUTPUT),
            truncated: Buffer.byteLength(stdout) > MAX_GIT_OUTPUT,
        };
    }
    async stage(root, paths) {
        const normalized = this.relativePaths(root, paths);
        if (normalized.length === 0)
            throw new Error('请选择至少一个文件。');
        await this.run(root, ['add', '--', ...normalized]);
    }
    async unstage(root, paths) {
        const normalized = this.relativePaths(root, paths);
        if (normalized.length === 0)
            throw new Error('请选择至少一个文件。');
        await this.run(root, ['restore', '--staged', '--', ...normalized]);
    }
    async restore(root, paths) {
        const normalized = this.relativePaths(root, paths);
        if (normalized.length === 0)
            throw new Error('请选择至少一个文件。');
        await this.run(root, ['restore', '--worktree', '--', ...normalized]);
    }
    async stageAll(root) {
        await this.run(root, ['add', '--all']);
    }
    async branches(root) {
        const { stdout } = await this.run(root, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads']);
        return stdout.split(/\r?\n/).map((line) => {
            const [name, head] = line.split('\0');
            return { name: name || '', current: head === '*' };
        }).filter((branch) => Boolean(branch.name));
    }
    async switchBranch(root, name) {
        const branch = this.branchName(name);
        await this.run(root, ['switch', branch]);
    }
    async createBranch(root, name) {
        const branch = this.branchName(name);
        await this.run(root, ['switch', '-c', branch]);
    }
    async commit(root, message) {
        const subject = String(message || '').trim();
        if (!subject)
            throw new Error('请输入提交信息。');
        if (subject.length > 4_000)
            throw new Error('提交信息不能超过 4000 个字符。');
        await this.run(root, ['commit', '-m', subject], MAX_GIT_OUTPUT);
    }
    async pull(root) {
        await this.run(root, ['pull', '--ff-only'], MAX_GIT_OUTPUT);
    }
    async push(root) {
        await this.run(root, ['push'], MAX_GIT_OUTPUT);
    }
    async log(root, limit = 12) {
        const count = Math.max(1, Math.min(50, Math.floor(limit)));
        const { stdout } = await this.run(root, ['log', `-n${count}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e']);
        return stdout.split('\x1e').map((record) => {
            const [hash, shortHash, subject, author, committedAt] = record.trim().split('\x1f');
            return { hash: hash || '', shortHash: shortHash || '', subject: subject || '', author: author || '', committedAt: committedAt || '' };
        }).filter((entry) => Boolean(entry.hash));
    }
    relativePaths(root, paths) {
        return [...new Set(paths.map((candidate) => this.relativePath(root, candidate)))];
    }
    relativePath(root, candidate) {
        const value = String(candidate || '').replace(/\\/g, '/').trim();
        if (!value || value === '.' || path.isAbsolute(value))
            throw new Error('Git 文件路径无效。');
        const resolvedRoot = path.resolve(root);
        const target = path.resolve(resolvedRoot, value);
        const relative = path.relative(resolvedRoot, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Git 文件路径超出项目目录。');
        return relative.replace(/\\/g, '/');
    }
    branchName(value) {
        const branch = String(value || '').trim();
        if (!branch || branch.length > 255 || /[\s~^:?*\\[\\]|]|\.\.|@\{|\/$|^\.|\.$/.test(branch)) {
            throw new Error('分支名称无效。');
        }
        return branch;
    }
    run(cwd, args, maxBuffer = MAX_GIT_OUTPUT) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.execFile)('git', args, { cwd, windowsHide: true, timeout: 15_000, maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => {
                const output = (0, DiagnosticDecoder_1.decodeDiagnostic)(stdout);
                const diagnostic = (0, DiagnosticDecoder_1.decodeDiagnostic)(stderr);
                if (error) {
                    const detail = (diagnostic || output || error.message).trim();
                    reject(new Error(detail || error.message));
                    return;
                }
                resolve({ stdout: output, stderr: diagnostic });
            });
        });
    }
}
exports.GitService = GitService;
function parseStatus(value) {
    const files = [];
    const records = value.split('\0');
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record || record.startsWith('## '))
            continue;
        if (record.length < 4)
            continue;
        const index = record[0];
        const workTree = record[1];
        let filePath = record.slice(3);
        // Rename/copy porcelain records are emitted as "XY to\0from\0".
        if ((index === 'R' || index === 'C' || workTree === 'R' || workTree === 'C') && records[i + 1])
            i++;
        if (filePath.startsWith('"') && filePath.endsWith('"'))
            filePath = filePath.slice(1, -1);
        files.push({ path: filePath.replace(/\\/g, '/'), index, workTree });
    }
    return { files };
}
//# sourceMappingURL=GitService.js.map