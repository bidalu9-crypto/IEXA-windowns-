import { promises as fs } from 'fs';
import * as path from 'path';
import { IexaError } from '../errors/IexaError';

export interface ResolvedPath { input: string; path: string; workspace: string; }
export interface PathPolicy { workspaceDir: string; allowMissing?: boolean; writable?: boolean; }

/** Resolves paths through the filesystem before applying the workspace boundary. */
export class PathSandbox {
  async resolve(input: string, policy: PathPolicy): Promise<ResolvedPath> {
    if (!input || !input.trim()) throw new IexaError('PATH_EMPTY', 'FILESYSTEM', '文件路径不能为空。');
    if (/^(\\\\|\\\\\?\\|\\\\\.\\)/.test(input)) {
      throw new IexaError('PATH_NETWORK', 'SECURITY', '不允许使用 UNC 或设备路径。');
    }
    const lexicalWorkspace = path.resolve(policy.workspaceDir);
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(lexicalWorkspace, input);
    const lexicalRelative = path.relative(lexicalWorkspace, candidate);
    if (lexicalRelative === '..' || lexicalRelative.startsWith('..' + path.sep) || path.isAbsolute(lexicalRelative)) {
      throw new IexaError('PATH_ESCAPE', 'SECURITY', '文件路径必须位于当前工作区内。');
    }
    const workspace = await fs.realpath(lexicalWorkspace);
    let canonical = candidate;
    try {
      canonical = await fs.realpath(candidate);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' || !policy.allowMissing) throw error;
      const parent = await this.realExistingParent(candidate);
      canonical = path.join(parent, path.basename(candidate));
    }
    const relative = path.relative(workspace, canonical);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      // Preserve the caller's canonicalized lexical path for Windows APIs.
      // `realpath` may switch between 8.3 and long path forms, while the
      // boundary decision above is based on the resolved filesystem target.
      return { input, path: candidate, workspace };
    }
    throw new IexaError('PATH_ESCAPE', 'SECURITY', '文件路径必须位于当前工作区内。');
  }

  async assertReadable(filePath: string): Promise<void> { await fs.access(filePath); }
  async assertWritable(filePath: string): Promise<void> { await fs.access(path.dirname(filePath)); }

  private async realExistingParent(candidate: string): Promise<string> {
    let cursor = candidate;
    while (true) {
      try { return await fs.realpath(cursor); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
  }
}
