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
exports.FileWorkspace = exports.IDEError = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const iconv = __importStar(require("iconv-lite"));
const events_1 = require("events");
const PathSandbox_1 = require("../security/PathSandbox");
const FileWriteLocks_1 = require("../tools/FileWriteLocks");
const MAX_BYTES = 4 * 1024 * 1024;
const OMIT = new Set(['node_modules', '.git', '.ssh', '.next', 'dist', 'build']);
class IDEError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.IDEError = IDEError;
function decode(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return { content: iconv.decode(bytes.subarray(2), 'utf16le'), encoding: 'utf16le-bom' };
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return { content: iconv.decode(bytes.subarray(2), 'utf16be'), encoding: 'utf16be-bom' };
    if (bytes.includes(0))
        throw new IDEError('IDE_BINARY', '此文件包含二进制数据。');
    const bom = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    try {
        return { content: new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes), encoding: bom ? 'utf8-bom' : 'utf8' };
    }
    catch {
        throw new IDEError('IDE_ENCODING', '文件不是 UTF-8 / UTF-16 文本，请先转换编码。');
    }
}
function encode(content, encoding) {
    if (encoding === 'utf16le-bom')
        return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(content, 'utf16le')]);
    if (encoding === 'utf16be-bom')
        return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(content, 'utf16be')]);
    return Buffer.concat([encoding === 'utf8-bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(content, 'utf8')]);
}
const revision = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function publicPath(value) { return value.replace(/\\/g, '/'); }
/** A picker-authorized collection. Renderers can only refer to opaque workspace IDs. */
class FileWorkspace extends events_1.EventEmitter {
    stateFile;
    opened = new Map();
    watchers = new Map();
    timers = new Map();
    constructor(stateFile) {
        super();
        this.stateFile = stateFile;
        if (stateFile) {
            try {
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                for (const item of (Array.isArray(state.projects) ? state.projects : []).slice(0, 30)) {
                    if (typeof item.root === 'string' && typeof item.id === 'string') {
                        try {
                            this.authorize(item.root, item.id, false);
                        }
                        catch { /* removed project */ }
                    }
                }
            }
            catch { /* first launch */ }
        }
    }
    authorize(selectedRoot, restoredId, persist = true) {
        if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot))
            throw new IDEError('IDE_ROOT', '请选择本地项目目录。');
        const root = fs.realpathSync.native(selectedRoot);
        if (!fs.statSync(root).isDirectory())
            throw new IDEError('IDE_ROOT', '项目路径不是目录。');
        const found = this.projects().find(item => process.platform === 'win32' ? item.root.toLowerCase() === root.toLowerCase() : item.root === root);
        if (found)
            return found;
        if (this.opened.size >= 30)
            throw new IDEError('IDE_LIMIT', '最多保留 30 个项目。');
        const id = restoredId && /^[a-f0-9-]{36}$/.test(restoredId) ? restoredId : crypto.randomUUID();
        const project = { id, root, name: path.basename(root) || root };
        this.opened.set(id, project);
        this.watch(project);
        if (persist)
            this.persist();
        return { ...project };
    }
    projects() { return [...this.opened.values()].map(item => ({ ...item })); }
    project(id, verifyRoot = true) {
        const project = typeof id === 'string' ? this.opened.get(id) : undefined;
        if (!project)
            throw new IDEError('IDE_WORKSPACE', '项目授权已失效，请重新选择目录。');
        if (verifyRoot && fs.realpathSync.native(project.root) !== project.root)
            throw new IDEError('IDE_ROOT', '项目根目录已变化，请重新选择。');
        return { ...project };
    }
    resolve(id, relative = '', allowMissing = false) {
        if (typeof relative !== 'string' || relative.length > 4096 || path.isAbsolute(relative) || /^[a-z]:|^\\\\/i.test(relative))
            throw new IDEError('IDE_PATH', '请使用项目内相对路径。');
        const project = this.project(id);
        const target = (0, PathSandbox_1.resolveScopedPath)(relative || '.', [project.root], allowMissing);
        return target;
    }
    list(id, relative = '') {
        const target = this.resolve(id, relative);
        const project = this.project(id);
        const entries = [];
        for (const dirent of fs.readdirSync(target, { withFileTypes: true })) {
            if (/^\.iexa-/i.test(dirent.name) || ['.git', '.ssh'].includes(dirent.name))
                continue;
            const rel = publicPath(path.relative(project.root, path.join(target, dirent.name)));
            try {
                const safe = this.resolve(id, rel);
                const stat = fs.statSync(safe);
                entries.push({ name: dirent.name, path: rel, directory: stat.isDirectory(), size: stat.size });
            }
            catch { /* links outside the root are never listed */ }
            if (entries.length >= 5000)
                break;
        }
        return { entries: entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
    }
    search(id, query) {
        if (typeof query !== 'string' || query.length > 200)
            throw new IDEError('IDE_QUERY', '搜索文字过长。');
        const entries = [];
        let visited = 0;
        const walk = (relative, depth) => {
            if (depth > 15 || visited > 25000 || entries.length >= 250)
                return;
            for (const item of this.list(id, relative).entries) {
                visited++;
                if (item.path.toLowerCase().includes(query.toLowerCase()))
                    entries.push(item);
                if (item.directory && !OMIT.has(item.name) && !item.name.startsWith('.'))
                    walk(item.path, depth + 1);
                if (entries.length >= 250 || visited > 25000)
                    break;
            }
        };
        if (query.trim())
            walk('', 0);
        return { entries };
    }
    read(id, relative) {
        const file = this.resolve(id, relative);
        const stat = fs.statSync(file);
        if (!stat.isFile())
            throw new IDEError('IDE_FILE', '请选择文件。');
        if (stat.size > MAX_BYTES)
            throw new IDEError('IDE_SIZE', '文件超过 4 MiB 编辑上限。');
        const bytes = fs.readFileSync(file);
        if (bytes.length > MAX_BYTES)
            throw new IDEError('IDE_SIZE', '文件超过 4 MiB 编辑上限。');
        return { path: publicPath(path.relative(this.project(id).root, file)), ...decode(bytes), revision: revision(bytes) };
    }
    async write(id, relative, content, expectedRevision, onCommitted) {
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES)
            throw new IDEError('IDE_SIZE', '文件超过 4 MiB 编辑上限。');
        const file = this.resolve(id, relative);
        return (0, FileWriteLocks_1.withFileLocks)([file], async () => {
            this.resolve(id, relative);
            const current = this.read(id, relative);
            if (typeof expectedRevision !== 'string' || current.revision !== expectedRevision)
                throw new IDEError('IDE_CONFLICT', '文件已被 AI 或其他程序修改，请重新加载或对比后保存。');
            const bytes = encode(content, current.encoding);
            const temp = `${file}.${crypto.randomUUID()}.tmp`;
            if (bytes.length > MAX_BYTES)
                throw new IDEError('IDE_SIZE', '文件超过 4 MiB 编辑上限。');
            let handle;
            try {
                this.resolve(id, publicPath(path.relative(this.project(id).root, temp)), true);
                handle = await fs.promises.open(temp, 'wx', fs.statSync(file).mode);
                await handle.writeFile(bytes);
                await handle.sync();
                await handle.close();
                handle = undefined;
                this.resolve(id, relative);
                if (this.read(id, relative).revision !== expectedRevision)
                    throw new IDEError('IDE_CONFLICT', '保存期间文件发生变化，请重新加载。');
                for (let attempt = 0;; attempt++) {
                    try {
                        await fs.promises.rename(temp, file);
                        break;
                    }
                    catch (error) {
                        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code || '') || attempt >= 3)
                            throw error;
                        await new Promise(resolve => setTimeout(resolve, [25, 60, 120][attempt]));
                        this.resolve(id, relative);
                        if (this.read(id, relative).revision !== expectedRevision)
                            throw new IDEError('IDE_CONFLICT', '保存期间文件发生变化，请重新加载。');
                    }
                }
            }
            finally {
                if (handle)
                    await handle.close().catch(() => { });
                await fs.promises.unlink(temp).catch(() => { });
            }
            const result = this.read(id, relative);
            onCommitted?.(result);
            this.changed(id, relative);
            return result;
        });
    }
    async create(id, relative, directory = false) {
        const file = this.resolve(id, relative, true);
        this.notRoot(id, file);
        return (0, FileWriteLocks_1.withFileLocks)([file], async () => {
            this.resolve(id, relative, true);
            if (directory)
                await fs.promises.mkdir(file);
            else
                await fs.promises.writeFile(file, '', { flag: 'wx' });
            this.changed(id, relative);
            return { ok: true, path: relative };
        });
    }
    async rename(id, relative, next) {
        const source = this.resolve(id, relative);
        const target = this.resolve(id, next, true);
        this.notRoot(id, source);
        this.notRoot(id, target);
        return (0, FileWriteLocks_1.withFileLocks)([source, target], async () => {
            this.resolve(id, relative);
            this.resolve(id, next, true);
            if (fs.existsSync(target))
                throw new IDEError('IDE_EXISTS', '目标文件或目录已经存在。');
            await fs.promises.rename(source, target);
            this.changed(id, relative);
            this.changed(id, next);
            return { ok: true, path: relative, newPath: next };
        });
    }
    async remove(id, relative) {
        const file = this.resolve(id, relative);
        this.notRoot(id, file);
        return (0, FileWriteLocks_1.withFileLocks)([file], async () => {
            this.resolve(id, relative);
            await fs.promises.rm(file, { recursive: true });
            this.changed(id, relative);
            return { ok: true };
        });
    }
    notRoot(id, file) { if (file === this.project(id).root)
        throw new IDEError('IDE_ROOT', '此操作不可用于项目根目录。'); }
    changed(workspaceId, relative) { this.emit('change', { type: 'files', workspaceId, ...(relative ? { path: publicPath(relative) } : {}) }); }
    watch(project) {
        try {
            const watcher = fs.watch(project.root, { recursive: process.platform === 'win32' || process.platform === 'darwin' }, (_event, name) => {
                const relative = String(name || '');
                if (relative.split(/[\\/]/).some(part => OMIT.has(part) || /^\.iexa-/.test(part)) || /\.tmp$/.test(relative))
                    return;
                if (this.timers.has(project.id))
                    clearTimeout(this.timers.get(project.id));
                this.timers.set(project.id, setTimeout(() => { this.timers.delete(project.id); this.changed(project.id); }, 120));
            });
            watcher.on('error', () => { });
            watcher.unref();
            this.watchers.set(project.id, watcher);
        }
        catch { /* renderer also checks revisions when activating a tab */ }
    }
    persist() {
        if (!this.stateFile)
            return;
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
        const temp = `${this.stateFile}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ projects: this.projects() }, null, 2));
        fs.renameSync(temp, this.stateFile);
    }
    dispose() {
        for (const watcher of this.watchers.values())
            watcher.close();
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.watchers.clear();
        this.timers.clear();
        this.removeAllListeners();
    }
}
exports.FileWorkspace = FileWorkspace;
//# sourceMappingURL=FileWorkspace.js.map