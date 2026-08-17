import { promises as fs } from 'fs';
import * as path from 'path';

export interface ArtifactRef { id: string; path: string; size: number; createdAt: number; }
export class ArtifactStore {
  constructor(private readonly root: string) {}
  async put(content: string, extension = '.txt'): Promise<ArtifactRef> {
    await fs.mkdir(this.root, { recursive: true });
    const id = `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const filePath = path.join(this.root, `${id}${extension}`);
    await fs.writeFile(filePath, content, 'utf8');
    const stat = await fs.stat(filePath);
    return { id, path: filePath, size: stat.size, createdAt: Date.now() };
  }
}
