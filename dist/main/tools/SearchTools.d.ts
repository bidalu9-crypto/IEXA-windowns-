import { ToolExecutionResult } from '../providers/types';
import { PathPolicy } from '../security/PathSandbox';
export interface GrepOptions {
    pattern: string;
    path?: string;
    glob?: string;
    ignore_case?: boolean;
    fixed_strings?: boolean;
    context_lines?: number;
    max_results?: number;
}
export interface GlobOptions {
    pattern: string;
    path?: string;
    limit?: number;
}
/** Convert a glob (supports **, *, ?, {a,b}) into an anchored RegExp over '/' paths. */
export declare function globToRegExp(glob: string, ignoreCase?: boolean): RegExp;
type IgnoreMatcher = (relative: string, isDirectory: boolean) => boolean;
/**
 * Parse the workspace-root .gitignore. Nested .gitignore files are intentionally
 * not read (documented); negation and directory-only rules are supported.
 */
export declare function loadGitignore(root: string): Promise<IgnoreMatcher>;
export declare class SearchTools {
    private readonly sandbox;
    private resolveRoot;
    grep(args: Record<string, unknown>, workspaceDir: string, policy: Omit<PathPolicy, 'workspaceDir'>, signal?: AbortSignal): Promise<ToolExecutionResult>;
    glob(args: Record<string, unknown>, workspaceDir: string, policy: Omit<PathPolicy, 'workspaceDir'>, signal?: AbortSignal): Promise<ToolExecutionResult>;
}
export {};
//# sourceMappingURL=SearchTools.d.ts.map