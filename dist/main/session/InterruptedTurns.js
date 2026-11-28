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
exports.markInterruptedTurns = markInterruptedTurns;
// =============================================================================
// Interrupted turns
//
// A turn is written to disk as `running` while it streams and as `paused` when
// the user parks it. Neither state can finish on its own after the process
// dies, so startup rewrites them to `interrupted`: the renderer then offers to
// continue instead of presenting half a turn as if it had completed.
// =============================================================================
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Returns how many sessions were repaired. A broken file is skipped: one bad
 * session must never stop the server from starting.
 */
function markInterruptedTurns(workspaceDir, store) {
    const dir = path.join(workspaceDir, '.iexa-sessions');
    if (!fs.existsSync(dir))
        return 0;
    let repaired = 0;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json'))
            continue;
        try {
            const sessionId = name.slice(0, -5);
            const messages = store.loadSync(sessionId);
            if (!Array.isArray(messages) || messages.length === 0)
                continue;
            let dirty = false;
            for (const message of messages) {
                if (message.role === 'assistant' && (message.status === 'running' || message.status === 'paused')) {
                    message.status = 'interrupted';
                    dirty = true;
                }
            }
            if (dirty) {
                store.saveSync(sessionId, messages);
                repaired += 1;
            }
        }
        catch { /* skip an unreadable session */ }
    }
    return repaired;
}
//# sourceMappingURL=InterruptedTurns.js.map