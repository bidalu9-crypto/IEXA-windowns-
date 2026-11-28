import { ChildProcess } from 'child_process';
export declare function assertDesktopHelpersOpen(): void;
export declare function trackDesktopHelper(child: ChildProcess): void;
/** Synchronous EOF: also works during Electron's final process-exit phase.
 * If iExA crashes, Windows closes these same handles without a JS callback. */
export declare function closeDesktopHelpers(): void;
//# sourceMappingURL=DesktopHelperLifetime.d.ts.map