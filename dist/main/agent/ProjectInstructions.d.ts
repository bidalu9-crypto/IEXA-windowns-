export interface ProjectInstructionSource {
    path: string;
    scope: string;
    sha256: string;
    content: string;
}
export interface ProjectInstructionResult {
    target: string;
    sources: ProjectInstructionSource[];
    warnings: string[];
}
/** Project-only scope: never reads home/parent directories or follows links outside the project.
 * Same-directory nonempty AGENTS.override.md wins; children specialize parent rules.
 * Read fresh for every request so edits are visible without restarting the application.
 */
export declare class ProjectInstructions {
    private readonly root;
    constructor(root: string);
    resolve(target?: string, kind?: 'file' | 'directory'): Promise<ProjectInstructionResult>;
    static format(result: ProjectInstructionResult): string;
}
//# sourceMappingURL=ProjectInstructions.d.ts.map