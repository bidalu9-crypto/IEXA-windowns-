import { FileWorkspace } from './FileWorkspace';
export type IDEGitRef = 'index' | 'HEAD' | 'base' | 'ours' | 'theirs';
export interface IDEGitEntry {
    path: string;
    index: string;
    workTree: string;
    status: string;
    staged: boolean;
    conflict: boolean;
    untracked: boolean;
    ignored: boolean;
    originalPath?: string;
}
export interface IDEGitStatus {
    available: boolean;
    repository: boolean;
    branch?: string;
    head?: string;
    unborn?: boolean;
    files: IDEGitEntry[];
    error?: string;
    errorCode?: string;
}
export interface IDEGitContent {
    path: string;
    ref?: IDEGitRef;
    exists: boolean;
    content: string;
    revision: string;
    oid?: string;
    binary: boolean;
    encoding?: string;
    conflict?: boolean;
    stages?: number[];
}
export interface IDEGitDiff {
    path: string;
    status?: IDEGitEntry;
    original: IDEGitContent;
    modified: IDEGitContent;
}
/** Porcelain -z paths are UTF-8 bytes, never C-quoted; rename source is a separate record. */
export declare function parseIDEGitStatus(value: Buffer | string): {
    files: IDEGitEntry[];
    branch?: string;
    head?: string;
    unborn?: boolean;
};
/** Git is scoped by picker-authorized FileWorkspace IDs, independently of chat permissions.
 * A disposable metadata view prevents status from invoking repository filters/fsmonitor/hooks.
 * Original HEAD/index/config are never written. cat-file reads raw blobs, without textconv.
 */
export declare class GitWorkspace {
    private readonly files;
    constructor(files: FileWorkspace);
    status(id: string): Promise<IDEGitStatus>;
    baseline(id: string, relative: string, ref?: IDEGitRef): Promise<IDEGitContent>;
    diff(id: string, relative: string, ref?: IDEGitRef): Promise<IDEGitDiff>;
    private validateFile;
    private discover;
    private metadata;
    private assertMetadataTree;
    private readHead;
    private inRepository;
    private withView;
    private scoped;
    private statusInView;
    private baselineInView;
    private run;
    private raw;
}
//# sourceMappingURL=GitWorkspace.d.ts.map