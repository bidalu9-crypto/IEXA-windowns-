import * as path from 'path';
import { IexaError } from '../errors/IexaError';

export interface ResolvedPath { input: string; path: string; workspace: string; }
export interface PathPolicy { workspaceDir: string; allowMissing?: boolean; writable?: boolean; }

/**
 * Normalizes local filesystem paths for file tools.
 *
 * The workspace remains the base for relative paths, but it is not an access
 * boundary: callers may explicitly target another local directory with either
 * an absolute path or a relative path that traverses above the workspace.
 */
export class PathSandbox {
  async resolve(input: string, policy: PathPolicy): Promise<ResolvedPath> {
    if (!input || !input.trim()) throw new IexaError('PATH_EMPTY', 'FILESYSTEM', '文件路径不能为空。');
    if (/^(\\\\|\\\\\?\\|\\\\\.\\)/.test(input)) {
      throw new IexaError('PATH_NETWORK', 'SECURITY', '不允许使用 UNC 或设备路径。');
    }
    const lexicalWorkspace = path.resolve(policy.workspaceDir);
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(lexicalWorkspace, input);
    return { input, path: candidate, workspace: lexicalWorkspace };
  }
}
