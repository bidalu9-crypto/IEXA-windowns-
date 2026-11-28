import { FileWorkspace, IDEError } from './FileWorkspace';
export declare const BUNDLED_RUFF_VERSION = "0.14.4";
export interface FormatDiagnostic {
    message: string;
    severity: 'error';
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
}
export interface CodeFormatOptions {
    /** Monaco's version ID for the exact input snapshot. Never apply to a newer model. */
    modelVersion: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    lineLength?: number;
}
export interface CodeFormatResult {
    workspaceId: string;
    path: string;
    modelVersion: number;
    inputHash: string;
    content: string;
    changed: boolean;
    formatter: {
        name: 'ruff' | 'black';
        version: string;
        source: 'project' | 'system' | 'bundled';
    };
    diagnostics: FormatDiagnostic[];
}
export declare class IDEFormatError extends IDEError {
    readonly diagnostics: FormatDiagnostic[];
    constructor(code: string, message: string, diagnostics?: FormatDiagnostic[]);
}
interface FormatterOptions {
    env?: NodeJS.ProcessEnv;
    /** A main-process controlled location. null disables the bundled fallback. */
    bundledRuffPath?: string | null;
}
/** Syntax-aware Python formatting on stdin. No source, cache or temporary file is
 * written to the user's project, and neither Python code nor project hooks run. */
export declare class CodeFormatter {
    private readonly files;
    private readonly env;
    private readonly bundledRuffPath;
    private active;
    constructor(files: FileWorkspace, options?: FormatterOptions);
    format(workspaceId: string, relative: string, content: string, options: CodeFormatOptions): Promise<CodeFormatResult>;
    private check;
    private discover;
    private findExecutable;
    private pythonDiagnostics;
    private run;
}
export {};
//# sourceMappingURL=CodeFormatter.d.ts.map