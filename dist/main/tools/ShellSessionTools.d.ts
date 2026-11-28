import { TerminalManager, TerminalShell } from '../terminals/TerminalManager';
import type { ToolExecutionResult } from '../providers/types';
/**
 * ConPTY/xterm streams carry cursor moves, erase sequences and OSC titles.
 * Agents need the text, not the terminal's painting instructions.
 */
export declare function stripTerminalControl(value: string): string;
export interface ParsedSessionOutput {
    found: boolean;
    /** Text between the begin marker and the end marker, before echo removal. */
    lines: string[];
    exitCode: number | null;
}
/**
 * Locate the marker pair. Both markers are printed by the shell *and* echoed
 * back by the tty, so neither may be matched with a plain includes(): the echo
 * line starts with the prompt or with `Write-Output`, while the real output
 * line starts with the token itself.
 */
export declare function parseSessionOutput(raw: string, beginToken: string, endToken: string): ParsedSessionOutput;
/**
 * The tty echoes every submitted line ahead of its output, with the prompt
 * glued to the first one (`PS E:\x>` or `E:\x>`). Drop exactly those lines;
 * anything that merely resembles the command later in the output is kept.
 */
export declare function stripCommandEcho(lines: string[], command: string): string[];
/** Task-center projection; never carries the tty buffer. */
export interface ShellSessionSummary {
    id: string;
    shell: TerminalShell;
    cwd: string;
    running: boolean;
    createdAt: number;
    endedAt?: number;
}
/**
 * Persistent shells for the agent. `shell_execute` starts a new process per
 * call, so every multi-step task has to re-establish cwd, virtualenv and
 * variables. A session keeps one tty alive; commands are framed by marker
 * lines so completion and exit codes are observable without parsing prompts.
 */
export declare class ShellSessionTools {
    private readonly workspaceDir;
    private readonly manager;
    private readonly sessions;
    constructor(workspaceDir: string, manager?: TerminalManager);
    private owned;
    private writeLine;
    private runCommand;
    execute(action: string, args: Record<string, unknown>, owner: string, signal?: AbortSignal, defaultCwd?: string): Promise<ToolExecutionResult>;
    /**
     * Read-only projection for the task center. The owner check keeps one
     * conversation (or a paired phone) from enumerating another's tty.
     */
    summaries(owner: string): ShellSessionSummary[];
    /** Close from the UI; reuses the same execute path, so owner checks apply. */
    close(id: string, owner: string): Promise<ToolExecutionResult>;
    shutdown(): Promise<void>;
    shutdownSync(): void;
}
//# sourceMappingURL=ShellSessionTools.d.ts.map