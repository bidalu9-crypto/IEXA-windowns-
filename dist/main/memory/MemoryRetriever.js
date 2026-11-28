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
exports.MemoryRetriever = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
function terms(value) {
    return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).filter((term) => term.length > 1))];
}
function excerpt(content, queryTerms, limit) {
    if (content.length <= limit)
        return content;
    const lower = content.toLowerCase();
    const matchAt = queryTerms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
    const start = Math.max(0, matchAt - Math.floor(limit * 0.3));
    const end = Math.min(content.length, start + limit);
    return `${start > 0 ? '...\n' : ''}${content.slice(start, end)}${end < content.length ? '\n...' : ''}`;
}
/** Ranks the existing Markdown memory log without injecting the whole directory. */
class MemoryRetriever {
    root;
    constructor(root) {
        this.root = root;
    }
    async search(query = '', options = {}) {
        const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
        const maxFiles = Math.max(limit, Math.min(options.maxFiles ?? 60, 180));
        const maxChars = Math.max(400, Math.min(options.maxCharsPerHit ?? 3000, 8000));
        await fs_1.promises.mkdir(this.root, { recursive: true });
        const queryTerms = terms(query);
        const entries = await fs_1.promises.readdir(this.root, { withFileTypes: true });
        const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
        const candidates = await Promise.all(files.slice(-maxFiles).map(async (file) => {
            const fullPath = path.join(this.root, file);
            const [content, stat] = await Promise.all([fs_1.promises.readFile(fullPath, 'utf8'), fs_1.promises.stat(fullPath)]);
            const normalized = content.toLowerCase();
            let score = 0;
            for (const term of queryTerms) {
                const occurrences = normalized.split(term).length - 1;
                if (occurrences > 0)
                    score += 20 + Math.min(occurrences, 8) * 4;
            }
            // Deterministic recency tie-breaker; it must never outweigh a real match.
            score += Math.min(9, Math.max(0, (stat.mtimeMs - Date.now() + 30 * 86400_000) / (30 * 86400_000) * 9));
            return { file, content, score, updatedAt: stat.mtimeMs };
        }));
        const matched = queryTerms.length === 0 ? candidates : candidates.filter((item) => item.score >= 20);
        return matched
            .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
            .slice(0, limit)
            .map((item) => ({ ...item, content: excerpt(item.content, queryTerms, maxChars) }));
    }
}
exports.MemoryRetriever = MemoryRetriever;
//# sourceMappingURL=MemoryRetriever.js.map