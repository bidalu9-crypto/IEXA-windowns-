export interface ResolvedPath {
    input: string;
    path: string;
    workspace: string;
}
export type PathMode = 'workspace' | 'selected-roots' | 'full';
export interface PathPolicy {
    workspaceDir: string;
    allowMissing?: boolean;
    writable?: boolean;
    mode?: PathMode;
    roots?: readonly string[];
    permissionMode?: 'plan' | 'ask' | 'risk' | 'full';
}
/** HTTP routes: relative inputs use the first root, all roots are realpath boundaries. */
export declare function resolveScopedPath(input: string, roots: readonly string[], allowMissing?: boolean): string;
export declare function resolveScopedPathAsync(input: string, roots: readonly string[], allowMissing?: boolean): Promise<string>;
/** Revalidate at the point of use; path resolution alone is not an atomic file handle sandbox. */
export declare class PathSandbox {
    resolveSync(input: string, policy: PathPolicy): ResolvedPath;
    resolve(input: string, policy: PathPolicy): Promise<ResolvedPath>;
}
//# sourceMappingURL=PathSandbox.d.ts.map