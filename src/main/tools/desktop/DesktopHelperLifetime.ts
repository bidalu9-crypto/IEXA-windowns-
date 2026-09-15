import { ChildProcess } from 'child_process';

// Only pipes created by this IEXA process are owned here. Never kill by image name.
const children = new Set<ChildProcess>();
let shuttingDown = false;
export function assertDesktopHelpersOpen(): void {
  if (shuttingDown) throw new Error('IEXA is closing; desktop helper startup cancelled.');
}
export function trackDesktopHelper(child: ChildProcess): void {
  if (!child.stdin) throw new Error('Desktop helper requires an owner lifetime pipe.');
  children.add(child);
  child.stdin.on('error', () => {}); // Native idle exit can close the pipe first.
  (child.stdin as typeof child.stdin & { unref?: () => void }).unref?.();
  const forget = () => { children.delete(child); child.stdin?.destroy(); };
  child.once('exit', forget); child.once('error', forget);
  child.unref();
  if (shuttingDown) child.stdin.destroy();
}
/** Synchronous EOF: also works during Electron's final process-exit phase.
 * If IEXA crashes, Windows closes these same handles without a JS callback. */
export function closeDesktopHelpers(): void {
  shuttingDown = true;
  for (const child of children) child.stdin?.destroy();
  children.clear();
}
process.once('exit', closeDesktopHelpers);
