"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.desktopApplicationRoot = desktopApplicationRoot;
exports.desktopHelperCandidates = desktopHelperCandidates;
exports.resolveDesktopHelper = resolveDesktopHelper;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** src/main/tools/desktop and dist/main/tools/desktop share this depth. */
function desktopApplicationRoot(moduleDirectory = __dirname) {
    if (!path.isAbsolute(moduleDirectory))
        throw new Error('Desktop helper module directory must be absolute.');
    return path.resolve(moduleDirectory, '../../../..');
}
/** Only the running application/module and executable supply installation roots.
 * A project directory (or its parent/cwd) must never select another helper. */
function desktopHelperCandidates(environment = {}) {
    const moduleRoot = desktopApplicationRoot(environment.moduleDirectory);
    const resources = environment.resourcesPath ?? process.resourcesPath;
    const execPath = environment.execPath ?? process.execPath;
    // A native executable inside an asar archive cannot be passed to spawn.
    const roots = [moduleRoot.replace(/\.asar$/i, '.asar.unpacked')];
    if (resources && path.isAbsolute(resources)) {
        roots.push(path.join(resources, 'app.asar.unpacked'), path.join(resources, 'app'), resources);
    }
    if (path.isAbsolute(execPath))
        roots.push(path.dirname(execPath));
    const seen = new Set();
    return roots.filter(root => {
        const key = process.platform === 'win32' ? root.toLowerCase() : root;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    }).map(root => path.join(root, 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'));
}
/** Select one installation directory, keeping the apphost and DLL together. */
function resolveDesktopHelper(environment = {}) {
    const isFile = (file) => { try {
        return fs.statSync(file).isFile();
    }
    catch {
        return false;
    } };
    for (const executable of desktopHelperCandidates(environment)) {
        const dll = executable.replace(/\.exe$/i, '.dll');
        const hasExecutable = isFile(executable), hasDll = isFile(dll);
        if (hasExecutable || hasDll)
            return { executable: hasExecutable ? executable : undefined, dll: hasDll ? dll : undefined };
    }
    return undefined;
}
//# sourceMappingURL=DesktopHelperPath.js.map