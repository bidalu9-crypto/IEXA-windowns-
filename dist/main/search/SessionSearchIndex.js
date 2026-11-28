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
exports.SessionSearchIndex = void 0;
exports.tokenize = tokenize;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stripBom_1 = require("../persistence/stripBom");
const INDEX_VERSION = 1;
const MAX_BODY_CHARS = 200_000;
const MAX_INDEXED_MESSAGES = 20_000;
class SessionSearchIndex {
    directory;
    cache = new Map();
    constructor(directory) {
        this.directory = directory;
    }
    /** Create/refresh records for the supplied sessions and drop orphans. */
    sync(sources) {
        const stats = { scanned: 0, indexed: 0, skipped: 0, removed: 0, bytesRead: 0 };
        fs.mkdirSync(this.directory, { recursive: true });
        const live = new Set();
        for (const source of sources) {
            if (!isSafeId(source.id))
                continue;
            stats.scanned++;
            live.add(source.id);
            const fingerprint = this.fingerprint(source.filePath);
            if (!fingerprint)
                continue;
            const existing = this.read(source.id);
            if (existing && existing.fingerprint === fingerprint && existing.title === source.title) {
                stats.skipped++;
                continue;
            }
            try {
                const messages = this.extract(source.filePath);
                stats.bytesRead += Number(fingerprint.split(':')[0]) || 0;
                const record = {
                    v: INDEX_VERSION,
                    id: source.id,
                    title: source.title || '',
                    updated: Number(source.updated) || 0,
                    fingerprint,
                    messages,
                };
                this.write(record);
                stats.indexed++;
            }
            catch {
                // Unreadable or half-written transcript: leave the previous record in
                // place and retry on the next sync.
            }
        }
        for (const name of this.listRecordIds()) {
            if (live.has(name))
                continue;
            this.invalidate(name);
            stats.removed++;
        }
        return stats;
    }
    search(query, options = {}) {
        const terms = tokenize(query);
        if (!terms.length)
            return [];
        const limit = Math.max(1, Math.min(200, options.limit ?? 30));
        const perSession = Math.max(1, Math.min(20, options.perSession ?? 5));
        const context = Math.max(0, Math.min(200, options.contextChars ?? 40));
        const hits = [];
        for (const id of this.listRecordIds()) {
            const record = this.read(id);
            if (!record)
                continue;
            const matches = [];
            const titleLower = record.title.toLowerCase();
            let titleHit = false;
            for (const term of terms)
                if (titleLower.includes(term)) {
                    titleHit = true;
                    break;
                }
            for (const [index, role, timestamp, body] of record.messages) {
                const lower = body.toLowerCase();
                if (!terms.every(term => lower.includes(term)))
                    continue;
                matches.push({
                    role,
                    index,
                    timestamp: timestamp || undefined,
                    snippet: snippetAround(body, lower, terms, context),
                });
                if (matches.length >= perSession)
                    break;
            }
            if (!matches.length && !titleHit)
                continue;
            if (!matches.length)
                matches.push({ role: 'title', index: -1, snippet: record.title });
            hits.push({
                sessionId: record.id,
                title: record.title,
                updated: record.updated,
                matches,
                score: scoreMatch(titleHit, matches, record.updated),
            });
        }
        hits.sort((a, b) => b.score - a.score || b.updated - a.updated);
        return hits.slice(0, limit);
    }
    /** Drop a single record; the next sync rebuilds it. */
    invalidate(id) {
        if (!isSafeId(id))
            return;
        this.cache.delete(id);
        fs.rmSync(this.recordPath(id), { force: true });
    }
    stats() {
        const ids = this.listRecordIds();
        let bytes = 0;
        for (const id of ids)
            bytes += fs.statSync(this.recordPath(id)).size;
        return { records: ids.length, bytes };
    }
    recordPath(id) { return path.join(this.directory, `${id}.json`); }
    listRecordIds() {
        try {
            return fs.readdirSync(this.directory)
                .filter(name => name.endsWith('.json'))
                .map(name => name.slice(0, -5))
                .filter(isSafeId);
        }
        catch {
            return [];
        }
    }
    fingerprint(filePath) {
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile())
                return null;
            return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
        }
        catch {
            return null;
        }
    }
    read(id) {
        const cached = this.cache.get(id);
        if (cached)
            return cached;
        try {
            const raw = JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8'));
            if (!raw || raw.v !== INDEX_VERSION || raw.id !== id || !Array.isArray(raw.messages))
                return null;
            this.cache.set(id, raw);
            return raw;
        }
        catch {
            return null;
        }
    }
    write(record) {
        const file = this.recordPath(record.id);
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(record));
        fs.renameSync(temporary, file);
        this.cache.set(record.id, record);
    }
    /** Extract only the prose a user would search for; tool payloads are skipped. */
    extract(filePath) {
        const parsed = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(filePath, 'utf8')));
        if (!Array.isArray(parsed))
            return [];
        const out = [];
        const limit = Math.min(parsed.length, MAX_INDEXED_MESSAGES);
        for (let i = 0; i < limit; i++) {
            const message = parsed[i];
            if (!message || typeof message !== 'object')
                continue;
            const content = typeof message.content === 'string' ? message.content : '';
            if (!content)
                continue;
            const body = content.length > MAX_BODY_CHARS ? content.slice(0, MAX_BODY_CHARS) : content;
            out.push([i, typeof message.role === 'string' ? message.role : 'unknown', Number(message.timestamp) || 0, body]);
        }
        return out;
    }
}
exports.SessionSearchIndex = SessionSearchIndex;
function isSafeId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
/** Split a query into lowercase terms; quoted phrases stay together. */
function tokenize(query) {
    const raw = String(query ?? '').trim();
    if (!raw)
        return [];
    const terms = [];
    const pattern = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(raw))) {
        const term = (match[1] ?? match[2] ?? '').trim().toLowerCase();
        if (term && !terms.includes(term))
            terms.push(term);
    }
    return terms.slice(0, 8);
}
function snippetAround(body, lower, terms, context) {
    let at = -1;
    for (const term of terms) {
        const index = lower.indexOf(term);
        if (index >= 0 && (at < 0 || index < at))
            at = index;
    }
    if (at < 0)
        at = 0;
    const start = Math.max(0, at - context);
    const end = Math.min(body.length, at + context + 60);
    return `${start > 0 ? '...' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '...' : ''}`;
}
function scoreMatch(titleHit, matches, updated) {
    let score = titleHit ? 6 : 0;
    score += Math.min(matches.length, 5);
    for (const match of matches)
        if (match.role === 'user')
            score += 0.5;
    // Recency tiebreak: newer sessions edge out older ones at equal relevance.
    score += Math.min(2, Math.max(0, (updated - 1_600_000_000_000) / 1_000_000_000_000));
    return score;
}
//# sourceMappingURL=SessionSearchIndex.js.map