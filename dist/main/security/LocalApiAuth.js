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
exports.LocalApiAuth = exports.DESKTOP_COOKIE = void 0;
exports.isLoopback = isLoopback;
exports.isTLS = isTLS;
exports.readCookie = readCookie;
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
const HttpServer_1 = require("../api/HttpServer");
exports.DESKTOP_COOKIE = 'iexa_desktop_session';
function isLoopback(req) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(req.socket.remoteAddress || '').toLowerCase());
}
function isTLS(req) { return req.socket.encrypted === true; }
function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const index = part.indexOf('=');
        if (index > 0 && part.slice(0, index).trim() === name) {
            try {
                return decodeURIComponent(part.slice(index + 1).trim());
            }
            catch {
                return '';
            }
        }
    }
    return '';
}
function equal(a, b) {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
/** Per-process desktop capability. It is never served by an unauthenticated endpoint. */
class LocalApiAuth {
    trustLoopback;
    token = crypto.randomBytes(32).toString('base64url');
    bootstrap = new Map();
    attempts = new Map();
    constructor(trustLoopback = false) {
        this.trustLoopback = trustLoopback;
    }
    validateRequest(req, opaqueAssetRead = false) {
        const host = String(req.headers.host || '');
        let url;
        try {
            url = new URL(`${isTLS(req) ? 'https' : 'http'}://${host}`);
        }
        catch {
            throw new HttpServer_1.HttpError(403, 'Host 校验失败。');
        }
        const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
        // new URL() lowercases the hostname; networkInterfaces() returns IPv6 in
        // uppercase hex, so both sides are normalized before comparing.
        for (const items of Object.values(os.networkInterfaces()))
            for (const item of items || [])
                allowed.add((item.family === 'IPv6' ? `[${item.address}]` : item.address).toLowerCase());
        if (url.username || url.password || url.pathname !== '/' || !allowed.has(url.hostname.toLowerCase()) || Number(url.port || (isTLS(req) ? 443 : 80)) !== req.socket.localPort || url.host.toLowerCase() !== host.toLowerCase())
            throw new HttpServer_1.HttpError(403, 'Host 校验失败。');
        const origin = req.headers.origin;
        const scopedOpaqueRead = opaqueAssetRead && req.method === 'GET' && /^\/plugin-assets\/[a-f0-9]{48}\//.test(req.url || '');
        if (origin && origin !== url.origin && !(scopedOpaqueRead && origin === 'null'))
            throw new HttpServer_1.HttpError(403, 'Origin 校验失败。');
        const site = req.headers['sec-fetch-site'];
        if (req.url?.startsWith('/api/') && site && site !== 'same-origin' && site !== 'none')
            throw new HttpServer_1.HttpError(403, '跨站 API 请求被拒绝。');
    }
    authenticated(req) {
        if (!isLoopback(req) || isTLS(req))
            return false;
        if (this.trustLoopback)
            return true;
        const bearer = String(req.headers.authorization || '');
        return equal(readCookie(req, `${exports.DESKTOP_COOKIE}_${req.socket.localPort}`), this.token) || equal(bearer, `Bearer ${this.token}`);
    }
    createBootstrap() {
        const now = Date.now();
        for (const [key, expiry] of this.bootstrap)
            if (expiry < now)
                this.bootstrap.delete(key);
        if (this.bootstrap.size >= 8)
            this.bootstrap.delete(this.bootstrap.keys().next().value);
        const value = crypto.randomBytes(32).toString('base64url');
        this.bootstrap.set(value, now + 5 * 60_000);
        return value;
    }
    acceptBootstrap(req, token) {
        if (!isLoopback(req) || isTLS(req))
            return false;
        const expiry = this.bootstrap.get(token);
        this.bootstrap.delete(token);
        return Boolean(expiry && expiry >= Date.now());
    }
    rateLimit(req, operation) {
        const now = Date.now();
        const key = `${req.socket.remoteAddress}:${operation}`;
        for (const [k, v] of this.attempts)
            if (now - v.at > 60_000)
                this.attempts.delete(k);
        let entry = this.attempts.get(key);
        if (!entry) {
            if (this.attempts.size >= 256)
                throw new HttpServer_1.HttpError(429, '请求过于频繁。');
            entry = { count: 0, at: now };
            this.attempts.set(key, entry);
        }
        if (++entry.count > 10)
            throw new HttpServer_1.HttpError(429, '请稍后重试。');
    }
    setCookie(res, port) { res.setHeader('Set-Cookie', `${exports.DESKTOP_COOKIE}_${port}=${this.token}; Path=/; HttpOnly; SameSite=Strict`); }
}
exports.LocalApiAuth = LocalApiAuth;
//# sourceMappingURL=LocalApiAuth.js.map