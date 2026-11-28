"use strict";
// =============================================================================
// iExA PC - Tool lifecycle hooks
//
// Workspace-level configuration in `<workspace>/.iexa-hooks.json`:
//
//   {
//     "preToolUse":  { "script": ".iexa-hooks/pre.js",  "tools": ["file_write"], "timeoutMs": 5000 },
//     "postToolUse": { "script": ".iexa-hooks/post.js" }
//   }
//
// A hook is a Node script that receives one JSON payload on stdin and may print
// `{ "block": true, "reason": "..." }` on stdout. Only preToolUse can block; a
// postToolUse result is advisory. Hooks never receive the ability to rewrite
// tool arguments, so the schema that was validated is the schema that runs.
// =============================================================================
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
exports.loadHookSpecs = loadHookSpecs;
exports.runHooks = runHooks;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stripBom_1 = require("../persistence/stripBom");
const ProcessManager_1 = require("../tools/shell/ProcessManager");
const AbortWait_1 = require("./AbortWait");
const CONFIG_FILE = '.iexa-hooks.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_HOOK_STDOUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/** Read and validate the workspace hook configuration. Invalid entries fail closed. */
function loadHookSpecs(workspaceDir) {
    let root;
    try {
        root = fs.realpathSync.native(workspaceDir);
    }
    catch {
        return [];
    }
    const configPath = path.join(root, CONFIG_FILE);
    let source;
    try {
        const stat = fs.statSync(configPath);
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
            return [];
        source = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(configPath, 'utf8')));
    }
    catch {
        return [];
    }
    if (!source || typeof source !== 'object' || Array.isArray(source))
        return [];
    const specs = [];
    for (const phase of ['preToolUse', 'postToolUse']) {
        const entry = source[phase];
        if (entry == null)
            continue;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        const raw = entry;
        if (Object.keys(raw).some((key) => !['script', 'tools', 'timeoutMs'].includes(key)))
            continue;
        const relativeScript = String(raw.script || '').trim();
        if (!relativeScript)
            continue;
        const absolute = path.resolve(root, relativeScript);
        if (!inside(root, absolute))
            continue;
        try {
            const stat = fs.statSync(absolute);
            if (!stat.isFile() || !['.js', '.cjs', '.mjs'].includes(path.extname(absolute).toLowerCase()))
                continue;
        }
        catch {
            continue;
        }
        let tools;
        if (raw.tools !== undefined) {
            if (!Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.length > 64)
                continue;
            tools = raw.tools.map((value) => String(value)).filter((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value));
            if (!tools.length)
                continue;
        }
        const requested = Number(raw.timeoutMs);
        const timeoutMs = Number.isFinite(requested) ? Math.max(100, Math.min(30_000, Math.floor(requested))) : DEFAULT_TIMEOUT_MS;
        specs.push({ phase, script: absolute, tools, timeoutMs });
    }
    return specs;
}
function runOne(spec, payload, cwd, signal) {
    return new Promise((resolve) => {
        let settled = false;
        let termination;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            // The owned process cleanup continues even if its OS helper is slow.
            // Releasing a cancelled turn must not wait for the helper indefinitely.
            if (termination)
                void (0, AbortWait_1.settleWithin)(termination, 150).then(() => resolve(value));
            else
                resolve(value);
        };
        const stop = () => { termination ??= (0, ProcessManager_1.terminateProcessTree)(child, 500).catch(() => { }); };
        const onAbort = () => { stop(); finish({ block: false, error: 'hook 已取消' }); };
        const child = (0, child_process_1.spawn)(process.execPath, [spec.script], {
            cwd,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
            // In a packaged build process.execPath is iExA-WIN.exe. Without this flag
            // Electron boots a second full application for every hook invocation —
            // a window, a GPU process and a black flash per tool call. The flag makes
            // the child a plain node process, which is all a hook needs.
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', IEXA_HOOK_PHASE: spec.phase, IEXA_SESSION_ID: payload.sessionId },
        });
        const timer = setTimeout(() => {
            stop();
            finish({ block: false, error: `hook 超时（${spec.timeoutMs}ms）` });
        }, spec.timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
        let stdout = '';
        let overflow = false;
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_HOOK_STDOUT && !overflow) {
                overflow = true;
                stop();
            }
        });
        child.stderr.on('data', () => { });
        child.on('error', (error) => finish({ block: false, error: `hook 启动失败：${error.message}` }));
        child.on('close', (code) => {
            if (overflow)
                return finish({ block: false, error: 'hook 输出超过 64 KB' });
            const text = stdout.trim();
            if (!text)
                return finish({ block: false });
            try {
                const parsed = JSON.parse(text);
                if (spec.phase === 'preToolUse' && parsed.block === true) {
                    return finish({ block: true, reason: String(parsed.reason || 'hook 阻止了该工具').slice(0, 500) });
                }
                return finish({ block: false });
            }
            catch {
                return finish({ block: false, error: `hook 输出不是有效 JSON（exit ${code ?? '?'}）` });
            }
        });
        try {
            child.stdin.end(JSON.stringify(payload));
        }
        catch { /* child exited early */ }
    });
}
/** Run every matching hook in order. preToolUse blocking stops the chain. */
async function runHooks(specs, payload, cwd, signal) {
    const errors = [];
    const matching = specs.filter((spec) => spec.phase === payload.phase && (!spec.tools || spec.tools.includes(payload.tool)));
    if (!matching.length)
        return { block: false, errors };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted)
        controller.abort();
    try {
        for (const spec of matching) {
            if (controller.signal.aborted)
                break;
            const outcome = await runOne(spec, payload, cwd, controller.signal);
            if (outcome.error)
                errors.push(outcome.error);
            if (outcome.block)
                return { block: true, reason: outcome.reason, errors };
        }
        return { block: false, errors };
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=HookRunner.js.map