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
exports.readDesktopRecovery = readDesktopRecovery;
exports.appendDesktopRecoveryEvent = appendDesktopRecoveryEvent;
const fs = __importStar(require("fs"));
const phases = new Set(['queued', 'observe', 'resolve', 'action_start', 'action_end', 'verify', 'completed', 'failed', 'takeover', 'cancelled']);
const terminal = new Set(['completed', 'failed', 'takeover', 'cancelled']);
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Scan the whole WAL in bounded chunks. A newer queued/read-only operation must
 * never erase an earlier uncertain write, even when it lies outside the last 64KB.
 * Retain only unresolved effects in memory; never load text, selectors or capabilities. */
function readDesktopRecovery(file) {
    if (!file || !fs.existsSync(file))
        return;
    const fd = fs.openSync(file, 'r');
    const unresolved = new Map();
    let latest;
    let integrity = 'complete';
    let bytesScanned = 0;
    const accept = (line) => {
        if (!line.trim())
            return;
        try {
            const e = JSON.parse(line);
            if (e?.version !== 1 || typeof e.operationId !== 'string' || !e.operationId || !phases.has(e.phase) || !Number.isFinite(e.timestamp))
                throw new Error('Invalid journal event');
            const previous = unresolved.get(e.operationId);
            // v1 journals did not carry counters: a start/end/verify is conservative evidence of dispatch.
            const legacyEffect = ['action_start', 'action_end', 'verify'].includes(e.phase);
            const inputMayHaveExecuted = !!previous?.inputMayHaveExecuted || e.inputMayHaveExecuted === true || count(e.dispatchedActions) > 0 || legacyEffect;
            const op = {
                operationId: e.operationId, phase: e.phase, timestamp: e.timestamp,
                ...(typeof e.action === 'string' ? { action: e.action.slice(0, 64) } : {}),
                interrupted: !terminal.has(e.phase), inputMayHaveExecuted,
                dispatchedActions: Math.max(previous?.dispatchedActions || 0, count(e.dispatchedActions), legacyEffect ? 1 : 0),
                completedSteps: Math.max(previous?.completedSteps || 0, count(e.completedSteps)),
            };
            if (e.phase === 'completed')
                unresolved.delete(e.operationId);
            else if (inputMayHaveExecuted)
                unresolved.set(e.operationId, op);
            latest = op;
        }
        catch {
            integrity = 'partial';
        }
    };
    try {
        const buffer = Buffer.alloc(65536);
        let carry = Buffer.alloc(0), discarding = false;
        for (;;) {
            const n = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!n)
                break;
            bytesScanned += n;
            const bytes = Buffer.concat([carry, buffer.subarray(0, n)]);
            let start = 0;
            for (;;) {
                const end = bytes.indexOf(10, start);
                if (end < 0)
                    break;
                if (!discarding)
                    accept(bytes.subarray(start, end).toString('utf8'));
                discarding = false;
                start = end + 1;
            }
            carry = Buffer.from(bytes.subarray(start));
            // Production records contain only phase/progress metadata. Bound malformed records too.
            if (carry.length > 65536 || discarding) {
                integrity = 'partial';
                carry = Buffer.alloc(0);
                discarding = true;
            }
        }
        if (carry.length) {
            accept(carry.toString('utf8'));
            integrity = 'partial';
        }
    }
    finally {
        fs.closeSync(fd);
    }
    if (!latest && integrity === 'complete')
        return;
    return {
        ...latest, unresolvedOperations: [...unresolved.values()].slice(-32), unresolvedOperationCount: unresolved.size,
        unresolvedOperationsTruncated: unresolved.size > 32, journalIntegrity: integrity, bytesScanned,
        replayPolicy: 'observe_and_verify_no_automatic_replay',
    };
}
/** Separate any torn tail before append, so it cannot swallow the next valid event.
 * Start intents and terminal outcomes are fsynced before dispatch/return respectively. */
function appendDesktopRecoveryEvent(file, event) {
    const fd = fs.openSync(file, 'a+', 0o600);
    try {
        const size = fs.fstatSync(fd).size;
        if (size) {
            const last = Buffer.alloc(1);
            fs.readSync(fd, last, 0, 1, size - 1);
            if (last[0] !== 10)
                fs.writeSync(fd, '\n');
        }
        const bytes = Buffer.from(JSON.stringify(event) + '\n');
        let offset = 0;
        while (offset < bytes.length) {
            const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (!n)
                throw new Error('Desktop journal write made no progress.');
            offset += n;
        }
        if (event.phase === 'action_start' || terminal.has(event.phase))
            fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
//# sourceMappingURL=DesktopRecoveryJournal.js.map