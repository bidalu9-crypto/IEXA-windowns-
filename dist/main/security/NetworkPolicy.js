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
exports.NetworkPolicy = void 0;
exports.normalizeIp = normalizeIp;
exports.isPublicIp = isPublicIp;
const promises_1 = require("dns/promises");
const net = __importStar(require("net"));
const https = __importStar(require("https"));
const IexaError_1 = require("../errors/IexaError");
function error(code, message) { return new IexaError_1.IexaError(code, 'NETWORK', message); }
function ipv6Words(address) {
    // WHATWG URL canonicalizes dotted IPv4 tails as hex groups.
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const parts = normalized.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    return [...left, ...Array(parts.length === 2 ? 8 - left.length - right.length : 0).fill('0'), ...right].map((part) => parseInt(part, 16));
}
function normalizeIp(address) {
    const host = address.replace(/^\[|\]$/g, '').toLowerCase();
    if (!net.isIP(host) || host.includes('%'))
        throw error('IP_INVALID', 'Invalid IP address.');
    if (net.isIPv4(host))
        return host;
    const words = ipv6Words(host);
    if (words.slice(0, 5).every((n) => n === 0) && words[5] === 0xffff) {
        return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
    }
    return words.map((word) => word.toString(16)).join(':');
}
/** Conservative global-unicast allow policy; special-purpose ranges fail closed. */
function isPublicIp(address) {
    let normalized;
    try {
        normalized = normalizeIp(address);
    }
    catch {
        return false;
    }
    if (net.isIPv4(normalized)) {
        const [a, b, c] = normalized.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113));
    }
    const w = ipv6Words(normalized);
    return (w[0] & 0xe000) === 0x2000 &&
        !(w[0] === 0x2001 && (w[1] < 0x0200 || w[1] === 0x0db8)) &&
        w[0] !== 0x2002 && !(w[0] === 0x3fff && (w[1] & 0xf000) === 0);
}
function bounded(value, fallback, maximum, minimum = 1) {
    return value === undefined || !Number.isFinite(value) ? fallback : Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
function abortReason(signal) { return signal.reason instanceof Error ? signal.reason : error('NETWORK_ABORTED', 'Network request aborted.'); }
async function withAbort(operation, signal) {
    if (signal.aborted)
        throw abortReason(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(abortReason(signal)); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        operation.then((value) => { cleanup(); resolve(value); }, (reason) => { cleanup(); reject(reason); });
    });
}
class NetworkPolicy {
    hooks;
    constructor(hooks = {}) {
        this.hooks = hooks;
    }
    async verify(input, signal) {
        let url;
        try {
            // Only bare hosts get a default scheme. Never silently upgrade HTTP or reinterpret another scheme.
            url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
        }
        catch {
            throw error('URL_INVALID', 'Invalid URL.');
        }
        if (url.protocol !== 'https:')
            throw error('URL_PROTOCOL', 'Only HTTPS requests are allowed.');
        if (url.username || url.password)
            throw error('URL_CREDENTIALS', 'URL credentials are restricted.');
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const name = host.replace(/\.$/, '');
        if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local'))
            throw error('SSRF_PRIVATE', 'Local network target is restricted.');
        let records;
        if (net.isIP(host))
            records = [{ address: normalizeIp(host), family: net.isIP(normalizeIp(host)) }];
        else {
            try {
                const operation = this.hooks.lookup ? this.hooks.lookup(host) : (0, promises_1.lookup)(host, { all: true, verbatim: true });
                records = signal ? await withAbort(operation, signal) : await operation;
            }
            catch (cause) {
                if (signal?.aborted)
                    throw abortReason(signal);
                throw error('DNS_FAILED', 'Target DNS verification failed.');
            }
        }
        if (!records.length || records.some((record) => !isPublicIp(record.address)))
            throw error('SSRF_PRIVATE', 'Target resolves to a nonpublic address.');
        const addresses = records.map((record) => { const address = normalizeIp(record.address); return { address, family: net.isIP(address) }; })
            .filter((record, index, all) => all.findIndex((candidate) => candidate.address === record.address && candidate.family === record.family) === index);
        return { url, addresses };
    }
    /** Compatibility validation only. Use fetch() to bind validation to transport. */
    async assertAllowed(input) { return (await this.verify(input)).url; }
    /** One DNS verification per hop, pinned lookup, normal TLS validation and no pooled sockets. */
    async fetch(input, options = {}) {
        const controller = new AbortController();
        const parentAbort = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted)
            parentAbort();
        else
            options.signal?.addEventListener('abort', parentAbort, { once: true });
        const timer = setTimeout(() => controller.abort(error('NETWORK_TIMEOUT', 'Network request timed out.')), bounded(options.timeoutMs, 15000, 60000));
        const maxBytes = bounded(options.maxBytes, 1024 * 1024, 8 * 1024 * 1024);
        const maxRedirects = bounded(options.maxRedirects, 5, 10, 0);
        try {
            let next = input;
            for (let hop = 0;; hop++) {
                if (controller.signal.aborted)
                    throw abortReason(controller.signal);
                const target = await this.verify(next, controller.signal);
                let response;
                let lastError;
                for (const address of target.addresses) {
                    try {
                        response = await this.request(target.url, address, maxBytes, controller.signal, options.headers);
                        break;
                    }
                    catch (cause) {
                        lastError = cause;
                        if (controller.signal.aborted || !this.isRetryableAddressError(cause))
                            throw cause;
                    }
                }
                if (!response)
                    throw lastError instanceof Error ? lastError : error('NETWORK_CONNECT', 'All verified target addresses failed.');
                if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
                    if (hop >= maxRedirects)
                        throw error('REDIRECT_LIMIT', 'Too many redirects.');
                    next = new URL(response.headers.location, target.url).toString();
                    continue;
                }
                return response;
            }
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', parentAbort);
        }
    }
    isRetryableAddressError(cause) {
        const code = String(cause?.code || '');
        return ['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code);
    }
    request(url, pinned, maxBytes, signal, headers = {}) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(abortReason(signal));
                return;
            }
            const host = url.hostname.replace(/^\[|\]$/g, '');
            let settled = false;
            let responseStream;
            let req;
            const cleanup = () => signal.removeEventListener('abort', abort);
            const fail = (reason) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(reason);
                responseStream?.destroy();
                req?.destroy();
            };
            const abort = () => fail(abortReason(signal));
            signal.addEventListener('abort', abort, { once: true });
            try {
                req = (this.hooks.request || https.request)(url, {
                    method: 'GET', agent: false, rejectUnauthorized: true,
                    servername: net.isIP(host) ? '' : host,
                    // Node may request all addresses for family autoselection. Both forms
                    // return ONLY the verified address, never a second system DNS lookup.
                    lookup: ((_hostname, opts, callback) => {
                        if (opts?.all)
                            callback(null, [{ ...pinned }]);
                        else
                            callback(null, pinned.address, pinned.family);
                    }),
                    headers: { 'User-Agent': 'iExA/2.0 (+local desktop research client)', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept-Encoding': 'identity', Connection: 'close', ...headers },
                }, (response) => {
                    responseStream = response;
                    response.on('error', fail);
                    if (settled) {
                        response.destroy();
                        return;
                    }
                    const status = response.statusCode || 0;
                    const finish = (body) => {
                        if (settled)
                            return;
                        settled = true;
                        cleanup();
                        resolve({ url: url.toString(), status, statusText: response.statusMessage || '', headers: response.headers, body });
                    };
                    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                        finish(Buffer.alloc(0));
                        response.destroy();
                        req?.destroy();
                        return;
                    }
                    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                        fail(error('RESPONSE_ENCODING', 'Unexpected compressed response.'));
                        return;
                    }
                    const declared = response.headers['content-length'];
                    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
                        fail(error('RESPONSE_LIMIT', 'Response exceeds byte limit.'));
                        return;
                    }
                    const chunks = [];
                    let bytes = 0;
                    response.on('data', (chunk) => {
                        if (settled)
                            return;
                        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        bytes += data.length;
                        if (bytes > maxBytes) {
                            fail(error('RESPONSE_LIMIT', 'Response exceeds byte limit.'));
                            return;
                        }
                        chunks.push(data);
                    });
                    response.on('end', () => finish(Buffer.concat(chunks, bytes)));
                    response.on('aborted', () => fail(error('RESPONSE_ABORTED', 'Response ended prematurely.')));
                    response.on('close', () => { if (!settled)
                        fail(error('RESPONSE_ABORTED', 'Response closed prematurely.')); });
                });
                req.on('error', fail);
                req.end();
            }
            catch (cause) {
                fail(cause);
            }
        });
    }
}
exports.NetworkPolicy = NetworkPolicy;
//# sourceMappingURL=NetworkPolicy.js.map