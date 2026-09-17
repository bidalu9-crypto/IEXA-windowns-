import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';
import { HttpError } from '../api/HttpServer';

export const DESKTOP_COOKIE = 'iexa_desktop_session';
export function isLoopback(req: http.IncomingMessage): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(req.socket.remoteAddress || '').toLowerCase());
}
export function isTLS(req: http.IncomingMessage): boolean { return (req.socket as { encrypted?: boolean }).encrypted === true; }
export function readCookie(req: http.IncomingMessage, name: string): string {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) { try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; } }
  }
  return '';
}
function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
/** Per-process desktop capability. It is never served by an unauthenticated endpoint. */
export class LocalApiAuth {
  readonly token = crypto.randomBytes(32).toString('base64url');
  private bootstrap = new Map<string, number>();
  private attempts = new Map<string, { count: number; at: number }>();
  constructor(private readonly trustLoopback = false) {}
  validateRequest(req: http.IncomingMessage, opaqueAssetRead = false): void {
    const host = String(req.headers.host || '');
    let url: URL;
    try { url = new URL(`${isTLS(req) ? 'https' : 'http'}://${host}`); } catch { throw new HttpError(403, 'Host 校验失败。'); }
    const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
    for (const items of Object.values(os.networkInterfaces())) for (const item of items || []) allowed.add(item.family === 'IPv6' ? `[${item.address}]` : item.address);
    if (url.username || url.password || url.pathname !== '/' || !allowed.has(url.hostname.toLowerCase()) || Number(url.port || (isTLS(req) ? 443 : 80)) !== req.socket.localPort || url.host.toLowerCase() !== host.toLowerCase()) throw new HttpError(403, 'Host 校验失败。');
    const origin = req.headers.origin;
    const scopedOpaqueRead = opaqueAssetRead && req.method === 'GET' && /^\/plugin-assets\/[a-f0-9]{48}\//.test(req.url || '');
    if (origin && origin !== url.origin && !(scopedOpaqueRead && origin === 'null')) throw new HttpError(403, 'Origin 校验失败。');
    const site = req.headers['sec-fetch-site'];
    if (req.url?.startsWith('/api/') && site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '跨站 API 请求被拒绝。');
  }
  authenticated(req: http.IncomingMessage): boolean {
    if (!isLoopback(req) || isTLS(req)) return false;
    if (this.trustLoopback) return true;
    const bearer = String(req.headers.authorization || '');
    return equal(readCookie(req, `${DESKTOP_COOKIE}_${req.socket.localPort}`), this.token) || equal(bearer, `Bearer ${this.token}`);
  }
  createBootstrap(): string {
    const now = Date.now(); for (const [key, expiry] of this.bootstrap) if (expiry < now) this.bootstrap.delete(key);
    if (this.bootstrap.size >= 8) this.bootstrap.delete(this.bootstrap.keys().next().value!);
    const value = crypto.randomBytes(32).toString('base64url'); this.bootstrap.set(value, now + 5 * 60_000); return value;
  }
  acceptBootstrap(req: http.IncomingMessage, token: string): boolean {
    if (!isLoopback(req) || isTLS(req)) return false;
    const expiry = this.bootstrap.get(token); this.bootstrap.delete(token);
    return Boolean(expiry && expiry >= Date.now());
  }
  rateLimit(req: http.IncomingMessage, operation: string): void {
    const now = Date.now(); const key = `${req.socket.remoteAddress}:${operation}`;
    for (const [k, v] of this.attempts) if (now - v.at > 60_000) this.attempts.delete(k);
    let entry = this.attempts.get(key);
    if (!entry) { if (this.attempts.size >= 256) throw new HttpError(429, '请求过于频繁。'); entry = { count: 0, at: now }; this.attempts.set(key, entry); }
    if (++entry.count > 10) throw new HttpError(429, '请稍后重试。');
  }
  setCookie(res: http.ServerResponse, port: number): void { res.setHeader('Set-Cookie', `${DESKTOP_COOKIE}_${port}=${this.token}; Path=/; HttpOnly; SameSite=Strict`); }
}
