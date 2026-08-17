import * as syncFs from 'fs';
import * as path from 'path';
import { JsonStore } from '../persistence/JsonStore';

export class SessionManager<T> {
  constructor(private readonly root: string) {}
  private file(id: string): string { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid session id'); return path.join(this.root, `${id}.json`); }
  async load(id: string): Promise<T | null> { return this.loadSync(id); }
  async save(id: string, value: T): Promise<void> { this.saveSync(id, value); }
  loadSync(id: string): T | null { const file = this.file(id); if (!syncFs.existsSync(file) && !syncFs.existsSync(`${file}.bak`)) return null; return new JsonStore<T>(file, () => { throw new Error(`Session ${id} is unavailable`); }).loadSync(); }
  saveSync(id: string, value: T): void { new JsonStore<T>(this.file(id), () => value).saveSync(value); }
  deleteSync(id: string): void { try { syncFs.unlinkSync(this.file(id)); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
