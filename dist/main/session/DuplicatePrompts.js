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
exports.removeDuplicatePrompts = removeDuplicatePrompts;
// =============================================================================
// Duplicate prompts
//
// The pre-generation prompt commit and the final turn save both wrote the user
// message. The final save re-read the file and appended it again, so the stored
// transcript showed the user speaking twice in a row. A natural-chat reply then
// reported "you called twice" after a single call.
//
// The writer no longer duplicates it; this repairs conversations written before
// that fix. Only exact neighbours - same role, same content, same timestamp -
// are removed. A genuine repeat carries a different timestamp, so nothing the
// user really said twice can be lost.
// =============================================================================
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Returns how many sessions were repaired. A broken file is skipped: one bad
 * session must never stop the server from starting.
 */
function removeDuplicatePrompts(workspaceDir, store) {
    const dir = path.join(workspaceDir, '.iexa-sessions');
    if (!fs.existsSync(dir))
        return 0;
    let repaired = 0;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.bak'))
            continue;
        const id = name.slice(0, -'.json'.length);
        try {
            const messages = store.loadSync(id);
            if (!Array.isArray(messages) || messages.length === 0)
                continue;
            const kept = [];
            let removed = 0;
            for (const message of messages) {
                const previous = kept[kept.length - 1];
                const duplicate = Boolean(previous)
                    && previous.role === message.role
                    && previous.timestamp === message.timestamp
                    && String(previous.content ?? '') === String(message.content ?? '');
                if (duplicate) {
                    removed += 1;
                    continue;
                }
                kept.push(message);
            }
            if (!removed)
                continue;
            store.saveSync(id, kept);
            repaired += 1;
            console.log(`[iExA] removed ${removed} duplicate message(s) from ${id}`);
        }
        catch { /* one unreadable session must not stop startup */ }
    }
    return repaired;
}
//# sourceMappingURL=DuplicatePrompts.js.map