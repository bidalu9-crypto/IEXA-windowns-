import { ToolExecutionResult } from '../providers/types';
type Change = NonNullable<ToolExecutionResult['fileChange']>;
export declare const groupFileChanges: (changes: Change[]) => Array<Change & {
    records: Change[];
}>;
export declare const sha256: (bytes: Buffer) => string;
export declare function undoUnavailable(changes: Change[]): string | undefined;
/** No client-supplied paths/content. Preflight the entire turn before changing any file. */
export declare function undoFileChanges(changes: Change[], roots: string[], alreadyUndone?: string[], onRestored?: (file: string) => Promise<void>): Promise<string[]>;
export {};
//# sourceMappingURL=FileChangeUndo.d.ts.map