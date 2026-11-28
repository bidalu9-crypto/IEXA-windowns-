import { EventEmitter } from 'events';
export interface IDEProject {
    id: string;
    root: string;
    name: string;
}
export interface IDEEntry {
    name: string;
    path: string;
    directory: boolean;
    size: number;
}
export interface IDEFile {
    path: string;
    content: string;
    revision: string;
    encoding: string;
}
export declare class IDEError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** A picker-authorized collection. Renderers can only refer to opaque workspace IDs. */
export declare class FileWorkspace extends EventEmitter {
    private readonly stateFile?;
    private readonly opened;
    private readonly watchers;
    private readonly timers;
    constructor(stateFile?: string | undefined);
    authorize(selectedRoot: string, restoredId?: string, persist?: boolean): IDEProject;
    projects(): IDEProject[];
    project(id: string, verifyRoot?: boolean): IDEProject;
    resolve(id: string, relative?: string, allowMissing?: boolean): string;
    list(id: string, relative?: string): {
        entries: IDEEntry[];
    };
    search(id: string, query: string): {
        entries: IDEEntry[];
    };
    read(id: string, relative: string): IDEFile;
    write(id: string, relative: string, content: string, expectedRevision: string, onCommitted?: (result: IDEFile) => void): Promise<IDEFile>;
    create(id: string, relative: string, directory?: boolean): Promise<{
        ok: true;
        path: string;
    }>;
    rename(id: string, relative: string, next: string): Promise<{
        ok: true;
        path: string;
        newPath: string;
    }>;
    remove(id: string, relative: string): Promise<{
        ok: true;
    }>;
    private notRoot;
    private changed;
    private watch;
    private persist;
    dispose(): void;
}
//# sourceMappingURL=FileWorkspace.d.ts.map