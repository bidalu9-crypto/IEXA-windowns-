import { FileWorkspace } from './FileWorkspace';
export type ProjectRunKind = 'file' | 'project' | 'build' | 'test';
export interface ProjectRunRequest {
    kind: ProjectRunKind;
    path?: string;
    script?: string;
}
export interface ProjectRunPlan {
    label: string;
    kind: ProjectRunKind;
    cwd: string;
    shell: 'powershell';
    command: string;
    executable: string;
    args: string[];
    exitMarker: string;
    language: string;
    entry?: string;
    script?: string;
    scriptCommand?: string;
}
interface PlannerOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}
/** PowerShell literal strings do not expand $, &, backticks or subexpressions. */
export declare function quotePowerShellArgument(value: string): string;
/** Builds reviewable terminal commands only. It never starts a program, probes a
 * port, downloads a runner, or changes process/system environment variables. */
export declare class ProjectRunPlanner {
    private readonly files;
    private readonly env;
    private readonly platform;
    constructor(files: FileWorkspace, options?: PlannerOptions);
    plan(workspaceId: string, request: ProjectRunRequest): ProjectRunPlan;
    private executable;
    private isFile;
    private npm;
}
export {};
//# sourceMappingURL=ProjectRunPlanner.d.ts.map