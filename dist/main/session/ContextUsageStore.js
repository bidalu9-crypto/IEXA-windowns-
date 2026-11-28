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
exports.normalizeContextUsage = normalizeContextUsage;
exports.contextUsageFromStatus = contextUsageFromStatus;
exports.contextUsageStatus = contextUsageStatus;
exports.readContextUsage = readContextUsage;
exports.writeContextUsage = writeContextUsage;
exports.shouldPersistContextUsage = shouldPersistContextUsage;
// =============================================================================
// Per-session context accounting carried across restarts.
//
// The context meter used to restart at zero whenever the app did: the request
// size lived only in the AgentLoop's compactor, so a reopened conversation was
// re-estimated from the (deliberately bounded) rehydrated working set. The
// session file now keeps the last known request size, and a reopen continues
// from it instead of inventing a smaller conversation.
// =============================================================================
const fs = __importStar(require("fs"));
const JsonStore_1 = require("../persistence/JsonStore");
const stripBom_1 = require("../persistence/stripBom");
function positive(value) {
    const numeric = Math.floor(Number(value) || 0);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}
/** Normalize a persisted record; anything malformed is simply absent. */
function normalizeContextUsage(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const value = raw;
    const usedTokens = positive(value.usedTokens);
    const contextWindow = positive(value.contextWindow);
    if (!usedTokens || !contextWindow)
        return null;
    return {
        usedTokens,
        contextWindow,
        compactThreshold: positive(value.compactThreshold) || Math.floor(contextWindow * 0.8),
        estimated: value.estimated !== false,
        updatedAt: positive(value.updatedAt) || Date.now(),
    };
}
/** A live status becomes a storable record, or null while the size is unknown. */
function contextUsageFromStatus(status) {
    if (!status)
        return null;
    return normalizeContextUsage({
        usedTokens: status.usedTokens,
        contextWindow: status.contextWindow,
        compactThreshold: status.compactThreshold,
        estimated: status.estimated,
        updatedAt: Date.now(),
    });
}
/** Rebuild the live status shape the renderer paints from. */
function contextUsageStatus(snapshot) {
    return {
        usedTokens: snapshot.usedTokens,
        contextWindow: snapshot.contextWindow,
        compactThreshold: snapshot.compactThreshold,
        estimated: snapshot.estimated,
        state: snapshot.usedTokens >= snapshot.compactThreshold ? 'near-limit' : 'ok',
    };
}
function readContextUsage(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return null;
        const state = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(filePath, 'utf-8')));
        return normalizeContextUsage(state.usage);
    }
    catch {
        return null;
    }
}
/**
 * Merge the record into the session file. Content and summary belong to the
 * caller that owns them, so a usage write must never replace them with blanks.
 */
function writeContextUsage(filePath, snapshot) {
    try {
        let state = {};
        if (fs.existsSync(filePath)) {
            try {
                const parsed = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(filePath, 'utf-8')));
                if (parsed && typeof parsed === 'object')
                    state = parsed;
            }
            catch { /* rebuild from the fields we own */ }
        }
        const next = { ...state, usage: snapshot, updatedAt: Date.now() };
        new JsonStore_1.JsonStore(filePath, () => next).saveSync(next);
    }
    catch { /* accounting is best effort; never break a turn for it */ }
}
/**
 * Turning every streaming status into a write would hammer the disk. Persist
 * once the size has moved by a meaningful amount; the turn end always writes.
 */
function shouldPersistContextUsage(previous, next) {
    if (!previous)
        return true;
    if (previous.contextWindow !== next.contextWindow)
        return true;
    if (previous.compactThreshold !== next.compactThreshold)
        return true;
    const step = Math.max(1000, Math.floor(next.contextWindow * 0.01));
    return Math.abs(next.usedTokens - previous.usedTokens) >= step;
}
//# sourceMappingURL=ContextUsageStore.js.map