import { lookup } from 'dns/promises';
import * as net from 'net';
import * as https from 'https';
import { IncomingHttpHeaders } from 'http';
import { IexaError } from '../errors/IexaError';

type Address = { address: string; family: number };
export interface NetworkHooks {
  lookup?: (hostname: string) => Promise<readonly Address[]>;
  request?: typeof https.request;
}
export interface NetworkFetchOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; }
export interface NetworkResponse { url: string; status: number; statusText: string; headers: IncomingHttpHeaders; body: Buffer; }

function error(code: string, message: string): IexaError { return new IexaError(code, 'NETWORK', message); }
function ipv6Words(address: string): number[] {
  // WHATWG URL canonicalizes dotted IPv4 tails as hex groups.
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const parts = normalized.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  return [...left, ...Array(parts.length === 2 ? 8 - left.length - right.length : 0).fill('0'), ...right].map((part) => parseInt(part, 16));
}
export function normalizeIp(address: string): string {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (!net.isIP(host) || host.includes('%')) throw error('IP_INVALID', 'Invalid IP address.');
  if (net.isIPv4(host)) return host;
  const words = ipv6Words(host);
  if (words.slice(0, 5).every((n) => n === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return words.map((word) => word.toString(16)).join(':');
}

/** Conservative global-unicast allow policy; special-purpose ranges fail closed. */
export function isPublicIp(address: string): boolean {
  let normalized: string;
  try { normalized = normalizeIp(address); } catch { return false; }
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

function bounded(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
function abortReason(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : error('NETWORK_ABORTED', 'Network request aborted.'); }
async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (reason) => { cleanup(); reject(reason); });
  });
}

export class NetworkPolicy {
  constructor(private readonly hooks: NetworkHooks = {}) {}

  private async verify(input: string, signal?: AbortSignal): Promise<{ url: URL; address: Address }> {
    let url: URL;
    try {
      // Only bare hosts get a default scheme. Never silently upgrade HTTP or reinterpret another scheme.
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch { throw error('URL_INVALID', 'Invalid URL.'); }
    if (url.protocol !== 'https:') throw error('URL_PROTOCOL', 'Only HTTPS requests are allowed.');
    if (url.username || url.password) throw error('URL_CREDENTIALS', 'URL credentials are restricted.');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const name = host.replace(/\.$/, '');
    if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) throw error('SSRF_PRIVATE', 'Local network target is restricted.');
    let records: readonly Address[];
    if (net.isIP(host)) records = [{ address: normalizeIp(host), family: net.isIP(normalizeIp(host)) }];
    else {
      try {
        const operation = this.hooks.lookup ? this.hooks.lookup(host) : lookup(host, { all: true, verbatim: true });
        records = signal ? await withAbort(operation, signal) : await operation;
      } catch (cause) {
        if (signal?.aborted) throw abortReason(signal);
        throw error('DNS_FAILED', 'Target DNS verification failed.');
      }
    }
    if (!records.length || records.some((record) => !isPublicIp(record.address))) throw error('SSRF_PRIVATE', 'Target resolves to a nonpublic address.');
    const address = normalizeIp(records[0].address);
    return { url, address: { address, family: net.isIP(address) } };
  }

  /** Compatibility validation only. Use fetch() to bind validation to transport. */
  async assertAllowed(input: string): Promise<URL> { return (await this.verify(input)).url; }

  /** One DNS verification per hop, pinned lookup, normal TLS validation and no pooled sockets. */
  async fetch(input: string, options: NetworkFetchOptions = {}): Promise<NetworkResponse> {
    const controller = new AbortController();
    const parentAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) parentAbort();
    else options.signal?.addEventListener('abort', parentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(error('NETWORK_TIMEOUT', 'Network request timed out.')), bounded(options.timeoutMs, 15000, 60000));
    const maxBytes = bounded(options.maxBytes, 1024 * 1024, 8 * 1024 * 1024);
    const maxRedirects = bounded(options.maxRedirects, 5, 10, 0);
    try {
      let next = input;
      for (let hop = 0; ; hop++) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        const target = await this.verify(next, controller.signal);
        const response = await this.request(target.url, target.address, maxBytes, controller.signal);
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          if (hop >= maxRedirects) throw error('REDIRECT_LIMIT', 'Too many redirects.');
          next = new URL(response.headers.location, target.url).toString();
          continue;
        }
        return response;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', parentAbort);
    }
  }

  private request(url: URL, pinned: Address, maxBytes: number, signal: AbortSignal): Promise<NetworkResponse> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortReason(signal)); return; }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let settled = false;
      let responseStream: import('http').IncomingMessage | undefined;
      let req: import('http').ClientRequest | undefined;
      const cleanup = () => signal.removeEventListener('abort', abort);
      const fail = (reason: Error) => {
        if (settled) return;
        settled = true; cleanup(); reject(reason);
        responseStream?.destroy(); req?.destroy();
      };
      const abort = () => fail(abortReason(signal));
      signal.addEventListener('abort', abort, { once: true });
      try {
        req = (this.hooks.request || https.request)(url, {
          method: 'GET', agent: false, rejectUnauthorized: true,
          servername: net.isIP(host) ? '' : host,
          // Node may request all addresses for family autoselection. Both forms
          // return ONLY the verified address, never a second system DNS lookup.
          lookup: ((_hostname: string, opts: { all?: boolean }, callback: (...args: any[]) => void) => {
            if (opts?.all) callback(null, [{ ...pinned }]);
            else callback(null, pinned.address, pinned.family);
          }) as import('net').LookupFunction,
          headers: { 'User-Agent': 'IEXA-BrowserFetch/1.0', 'Accept-Encoding': 'identity', Connection: 'close' },
        }, (response) => {
          responseStream = response;
          response.on('error', fail);
          if (settled) { response.destroy(); return; }
          const status = response.statusCode || 0;
          const finish = (body: Buffer) => {
            if (settled) return;
            settled = true; cleanup();
            resolve({ url: url.toString(), status, statusText: response.statusMessage || '', headers: response.headers, body });
          };
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            finish(Buffer.alloc(0)); response.destroy(); req?.destroy(); return;
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            fail(error('RESPONSE_ENCODING', 'Unexpected compressed response.')); return;
          }
          const declared = response.headers['content-length'];
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
            fail(error('RESPONSE_LIMIT', 'Response exceeds byte limit.')); return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;
            if (bytes > maxBytes) { fail(error('RESPONSE_LIMIT', 'Response exceeds byte limit.')); return; }
            chunks.push(data);
          });
          response.on('end', () => finish(Buffer.concat(chunks, bytes)));
          response.on('aborted', () => fail(error('RESPONSE_ABORTED', 'Response ended prematurely.')));
          response.on('close', () => { if (!settled) fail(error('RESPONSE_ABORTED', 'Response closed prematurely.')); });
        });
        req.on('error', fail);
        req.end();
      } catch (cause) { fail(cause as Error); }
    });
  }
}
