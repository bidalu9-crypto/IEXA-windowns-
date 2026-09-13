import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import { HttpError, jsonReply, readBody, readRawBody } from './HttpServer';

interface Upload { owner: string; sessionId: string; name: string; mime: string; kind: string; size: number; received: number; partPath: string; created: number; }
const CHUNK = 4 * 1024 * 1024;
const TTL = 2 * 60 * 60_000;
/** Serializes state transitions per upload, with bounded aggregate reservations. */
export class UploadRoutes {
  private entries = new Map<string, Upload>();
  private inflight = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly workspace: string) { this.workspace = fs.realpathSync.native(workspace); this.cleanupStaleFiles(); this.timer = setInterval(() => this.prune(), 60_000); this.timer.unref(); }
  close(): void { clearInterval(this.timer); for (const [id, item] of this.entries) if (!this.locks.has(id)) this.discard(id, item); }
  private discard(id: string, item: Upload): void { this.entries.delete(id); try { this.validatePart(item); fs.unlinkSync(item.partPath); } catch {} }
  private prune(): void { for (const [id, item] of this.entries) if (!this.locks.has(id) && Date.now() - item.created > TTL) this.discard(id, item); }
  private directory(sessionId?: string, chunks = false, create = false): string {
    const parts = ['uploads', ...(sessionId ? [sessionId] : []), ...(chunks ? ['.chunks'] : [])];
    let current = this.workspace;
    for (const part of parts) {
      current = path.join(current, part);
      try { const st = fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) throw new HttpError(403, '上传目录包含别名或非目录。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error; fs.mkdirSync(current); }
      if (path.relative(current, fs.realpathSync.native(current)) !== '') throw new HttpError(403, '上传目录包含别名。');
    }
    return current;
  }
  private validatePart(item: Upload): void {
    const dir = this.directory(item.sessionId, true); const stat = fs.lstatSync(item.partPath);
    if (path.dirname(item.partPath) !== dir || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new HttpError(403, '上传临时文件被替换。');
  }
  private cleanupStaleFiles(): void {
    let root: string; try { root = this.directory(); } catch { return; }
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(session.name)) continue;
      try {
        const dir = this.directory(session.name, true);
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!item.isFile() || !/^upl_[a-f0-9-]+\.part$/.test(item.name)) continue;
          const file = path.join(dir, item.name); const st = fs.lstatSync(file);
          if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && Date.now() - st.mtimeMs > TTL) fs.unlinkSync(file);
        }
      } catch {}
    }
  }
  private async lock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const tail = previous.then(() => gate);
    this.locks.set(id, tail); await previous;
    try { return await run(); } finally { release(); if (this.locks.get(id) === tail) this.locks.delete(id); }
  }
  private entry(id: string, owner: string): Upload {
    const item = this.entries.get(id);
    if (!item || item.owner !== owner || Date.now() - item.created > TTL) throw new HttpError(404, '上传已过期或不存在。');
    return item;
  }
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, owner: string): Promise<boolean> {
    if (!url.pathname.startsWith('/api/uploads/')) return false;
    const count = this.inflight.get(owner) || 0;
    if (count >= 8 || [...this.inflight.values()].reduce((a,b) => a+b, 0) >= 32) throw new HttpError(429, '并发上传配额已满。');
    this.inflight.set(owner, count + 1);
    try { return await this.handleAdmitted(req, res, url, owner); }
    finally { const remaining = (this.inflight.get(owner) || 1) - 1; if (remaining) this.inflight.set(owner, remaining); else this.inflight.delete(owner); }
  }
  private async handleAdmitted(req: http.IncomingMessage, res: http.ServerResponse, url: URL, owner: string): Promise<boolean> {
    if (!url.pathname.startsWith('/api/uploads/')) return false;
    if (req.method !== 'POST') throw new HttpError(405, '上传接口要求 POST。');
    this.prune();
    if (url.pathname === '/api/uploads/init') {
      const input = JSON.parse(await readBody(req, 1_000_000)); const sessionId = String(input.sessionId || ''); const size = Number(input.size);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !Number.isSafeInteger(size) || size <= 8 * 1024 * 1024 || size > 100 * 1024 * 1024) throw new HttpError(400, '上传参数或文件大小无效。');
      const items = [...this.entries.values()];
      if (items.length >= 32 || items.filter(x => x.owner === owner).length >= 8 || items.reduce((n, x) => n + x.size, size) > 1024 * 1024 * 1024) throw new HttpError(429, '上传配额已满。');
      const name = String(input.name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'file';
      const id = `upl_${crypto.randomUUID()}`;
      const real = this.directory(sessionId, true, true);
      const space = fs.statfsSync(real); if (space.bavail * space.bsize < size + 128 * 1024 * 1024) throw new HttpError(507, '磁盘剩余空间不足。');
      const partPath = path.join(real, `${id}.part`); fs.writeFileSync(partPath, Buffer.alloc(0), { flag: 'wx' });
      this.entries.set(id, { owner, sessionId, size, received: 0, partPath, created: Date.now(), name, mime: String(input.mime || 'application/octet-stream').slice(0, 100), kind: ['image','text','file'].includes(input.kind) ? input.kind : 'file' });
      jsonReply(res, 200, { uploadId: id, chunkBytes: CHUNK }); return true;
    }
    if (url.pathname === '/api/uploads/chunk') {
      const id = url.searchParams.get('uploadId') || ''; this.entry(id, owner);
      // Read bounded bodies concurrently; serialize offset validation and commit AFTER the await.
      const chunk = await readRawBody(req, CHUNK);
      const offset = Number(url.searchParams.get('offset'));
      if (!chunk.length || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '分块参数无效。');
      await this.lock(id, async () => {
        const item = this.entry(id, owner); this.validatePart(item);
        if (offset < item.received && offset + chunk.length <= item.received) {
          const fd = fs.openSync(item.partPath, 'r'); const stored = Buffer.alloc(chunk.length);
          try { fs.readSync(fd, stored, 0, stored.length, offset); } finally { fs.closeSync(fd); }
          if (stored.equals(chunk)) { jsonReply(res, 200, { received: item.received, size: item.size, duplicate: true }); return; }
        }
        if (offset !== item.received) throw new HttpError(409, `分块偏移冲突，期望 ${item.received}。`);
        if (item.received + chunk.length > item.size) throw new HttpError(413, '分块超过声明大小。');
        fs.appendFileSync(item.partPath, chunk); item.received += chunk.length;
        jsonReply(res, 200, { received: item.received, size: item.size });
      }); return true;
    }
    if (url.pathname === '/api/uploads/complete') {
      const input = JSON.parse(await readBody(req, 1_000_000)); const id = String(input.uploadId || '');
      await this.lock(id, async () => {
        const item = this.entry(id, owner); this.validatePart(item); if (item.received !== item.size || fs.statSync(item.partPath).size !== item.size) throw new HttpError(409, '文件尚未上传完整。');
        const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(item.partPath)) hash.update(chunk);
        const sha256 = hash.digest('hex'); if (input.sha256 && input.sha256 !== sha256) throw new HttpError(409, '文件校验和不匹配。');
        const destName = `${crypto.randomUUID()}_${item.name}`; const dest = path.join(this.directory(item.sessionId), destName);
        this.validatePart(item);
        fs.renameSync(item.partPath, dest); this.entries.delete(id);
        jsonReply(res, 200, { savedPath: path.relative(fs.realpathSync.native(this.workspace), dest).replace(/\\/g, '/'), name: item.name, mime: item.mime, kind: item.kind, size: item.size, sha256 });
      }); return true;
    }
    throw new HttpError(404, '上传接口不存在。');
  }
}
