export interface ProjectScope {
    targets: string[];
    operations: string[];
    notes: string;
}
export declare function normalizeProjectScope(input: unknown): ProjectScope;
/** User-managed project context, not an execution permission grant. */
export declare class ProjectScopeStore {
    private readonly directory;
    constructor(directory: string);
    private store;
    load(root: string): ProjectScope;
    save(root: string, value: unknown): ProjectScope;
}
export declare function buildProjectScopeSection(scope?: ProjectScope | null): string;
//# sourceMappingURL=ProjectScopeStore.d.ts.map