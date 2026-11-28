"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertDesktopHelpersOpen = assertDesktopHelpersOpen;
exports.trackDesktopHelper = trackDesktopHelper;
exports.closeDesktopHelpers = closeDesktopHelpers;
// Only pipes created by this iExA process are owned here. Never kill by image name.
const children = new Set();
let shuttingDown = false;
function assertDesktopHelpersOpen() {
    if (shuttingDown)
        throw new Error('iExA is closing; desktop helper startup cancelled.');
}
function trackDesktopHelper(child) {
    if (!child.stdin)
        throw new Error('Desktop helper requires an owner lifetime pipe.');
    children.add(child);
    child.stdin.on('error', () => { }); // Native idle exit can close the pipe first.
    child.stdin.unref?.();
    const forget = () => { children.delete(child); child.stdin?.destroy(); };
    child.once('exit', forget);
    child.once('error', forget);
    child.unref();
    if (shuttingDown)
        child.stdin.destroy();
}
/** Synchronous EOF: also works during Electron's final process-exit phase.
 * If iExA crashes, Windows closes these same handles without a JS callback. */
function closeDesktopHelpers() {
    shuttingDown = true;
    for (const child of children)
        child.stdin?.destroy();
    children.clear();
}
process.once('exit', closeDesktopHelpers);
//# sourceMappingURL=DesktopHelperLifetime.js.map