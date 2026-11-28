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
exports.PathSandbox = void 0;
exports.resolveScopedPath = resolveScopedPath;
exports.resolveScopedPathAsync = resolveScopedPathAsync;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const IexaError_1 = require("../errors/IexaError");
function reject(code, message) { throw new IexaError_1.IexaError(code, 'SECURITY', message); }
/** Reject alternate Windows namespaces on every platform, before normalization. */
function validatePath(input, full) {
    if (typeof input !== 'string' || !input.trim())
        reject('PATH_EMPTY', 'File path is empty.');
    if (/[\x00-\x1f]/.test(input))
        reject('PATH_INVALID', 'Control characters in path.');
    const windows = input.replace(/\//g, '\\');
    if (windows.startsWith('\\\\') || windows.startsWith('\\??\\') || windows.startsWith('\\Device\\')) {
        reject('PATH_NETWORK', 'UNC and device paths are restricted.');
    }
    if (/^[a-z]:[^\\/]/i.test(input) || /^[a-z]:$/i.test(input))
        reject('PATH_INVALID', 'Drive-relative path is ambiguous.');
    const body = input.replace(/^[a-z]:[\\/]/i, '');
    for (const component of body.split(/[\\/]/)) {
        if (!full && /^\.iexa-/i.test(component))
            reject('PATH_INTERNAL', 'Internal application paths are restricted.');
        if (component.includes(':') || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component) ||
            (component !== '.' && component !== '..' && /[. ]$/.test(component))) {
            reject('PATH_INVALID', 'Alternate streams, device names and ambiguous path components are restricted.');
        }
    }
}
function* canonical(input, allowMissing) {
    let current = input;
    const suffix = [];
    for (;;) {
        try {
            const real = (yield { kind: 'realpath', path: current });
            if (suffix.length && !(yield { kind: 'stat', path: real }).isDirectory()) {
                reject('PATH_PARENT', 'Existing path parent is not a directory.');
            }
            return path.join(real, ...suffix.reverse());
        }
        catch (error) {
            if (!allowMissing || error.code !== 'ENOENT')
                throw error;
            let exists = false;
            try {
                yield { kind: 'lstat', path: current };
                exists = true;
            }
            catch (statError) {
                if (statError.code !== 'ENOENT')
                    throw statError;
            }
            if (exists)
                reject('PATH_LINK', 'Unresolvable symbolic link or junction.');
            const parent = path.dirname(current);
            if (parent === current)
                throw error;
            suffix.push(path.basename(current));
            current = parent;
        }
    }
}
function contains(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function* resolvePolicy(input, policy) {
    const full = policy.permissionMode === 'full';
    if (policy.mode === 'full' && !full)
        reject('PATH_MODE', 'Full path access requires explicit full permission mode.');
    validatePath(input, full);
    validatePath(policy.workspaceDir, full);
    const workspace = yield* canonical(path.resolve(policy.workspaceDir), false);
    const candidate = path.resolve(workspace, input);
    const resolved = yield* canonical(candidate, policy.allowMissing === true);
    validatePath(resolved, full);
    if (!full) {
        const roots = policy.mode === 'selected-roots' ? policy.roots || [] : [policy.workspaceDir];
        let allowed = false;
        for (const root of roots) {
            validatePath(root, false);
            const realRoot = yield* canonical(path.resolve(root), false);
            validatePath(realRoot, false);
            if (!(yield { kind: 'stat', path: realRoot }).isDirectory())
                reject('PATH_ROOT', 'Scope root is not a directory.');
            if (contains(realRoot, resolved))
                allowed = true;
        }
        if (!allowed)
            reject('PATH_OUTSIDE', 'Path is outside the authorized roots.');
    }
    return { input, path: resolved, workspace };
}
function runSync(steps) {
    let step = steps.next();
    while (!step.done) {
        try {
            const op = step.value;
            const result = op.kind === 'realpath' ? fs.realpathSync.native(op.path) : op.kind === 'stat' ? fs.statSync(op.path) : fs.lstatSync(op.path);
            step = steps.next(result);
        }
        catch (error) {
            step = steps.throw(error);
        }
    }
    return step.value;
}
async function runAsync(steps) {
    let step = steps.next();
    while (!step.done) {
        try {
            const op = step.value;
            const result = op.kind === 'realpath' ? await fs.promises.realpath(op.path) : op.kind === 'stat' ? await fs.promises.stat(op.path) : await fs.promises.lstat(op.path);
            step = steps.next(result);
        }
        catch (error) {
            step = steps.throw(error);
        }
    }
    return step.value;
}
/** HTTP routes: relative inputs use the first root, all roots are realpath boundaries. */
function resolveScopedPath(input, roots, allowMissing = false) {
    if (!roots.length)
        reject('PATH_ROOT', 'At least one authorized root is required.');
    return runSync(resolvePolicy(input, { workspaceDir: roots[0], mode: 'selected-roots', roots, allowMissing })).path;
}
async function resolveScopedPathAsync(input, roots, allowMissing = false) {
    if (!roots.length)
        reject('PATH_ROOT', 'At least one authorized root is required.');
    return (await runAsync(resolvePolicy(input, { workspaceDir: roots[0], mode: 'selected-roots', roots, allowMissing }))).path;
}
/** Revalidate at the point of use; path resolution alone is not an atomic file handle sandbox. */
class PathSandbox {
    resolveSync(input, policy) { return runSync(resolvePolicy(input, policy)); }
    resolve(input, policy) { return runAsync(resolvePolicy(input, policy)); }
}
exports.PathSandbox = PathSandbox;
//# sourceMappingURL=PathSandbox.js.map