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
/**
 * Small, shell-free Git adapter for the project workbench. Keeping Git calls
 * here gives the UI structured data rather than forcing it to parse terminal
 * output, and makes path validation consistent for every mutating operation.
 */
export declare class GitService {
    status(root: string): Promise<GitStatus>;
    diff(root: string, relativePath?: string, staged?: boolean): Promise<GitDiff>;
    stage(root: string, paths: string[]): Promise<void>;
    unstage(root: string, paths: string[]): Promise<void>;
    restore(root: string, paths: string[]): Promise<void>;
    stageAll(root: string): Promise<void>;
    branches(root: string): Promise<GitBranch[]>;
    switchBranch(root: string, name: string): Promise<void>;
    createBranch(root: string, name: string): Promise<void>;
    commit(root: string, message: string): Promise<void>;
    pull(root: string): Promise<void>;
    push(root: string): Promise<void>;
    log(root: string, limit?: number): Promise<GitLogEntry[]>;
    private relativePaths;
    private relativePath;
    private branchName;
    private run;
}
//# sourceMappingURL=GitService.d.ts.map