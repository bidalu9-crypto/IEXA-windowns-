import * as http from 'http';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function jsonReply(res: http.ServerResponse, code: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
export async function readBody(req: http.IncomingMessage, maxLength = 10_000_000): Promise<string> {
  return (await readRawBody(req, maxLength)).toString('utf8');
}
export function readRawBody(req: http.IncomingMessage, maxLength = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0; let settled = false;
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); req.off('close', closed); };
    const fail = (err: Error) => { if (settled) return; settled = true; cleanup(); chunks.length = 0; req.resume(); reject(err); };
    const data = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maxLength) { fail(new HttpError(413, `请求体超过 ${maxLength} 字节上限。`)); return; }
      chunks.push(chunk);
    };
    const end = () => { if (!settled) { settled = true; cleanup(); resolve(Buffer.concat(chunks, total)); } };
    const error = (err: Error) => fail(err);
    const aborted = () => fail(new HttpError(400, '请求已中断。'));
    const closed = () => { if (!req.complete) aborted(); };
    const timer = setTimeout(() => fail(new HttpError(408, '请求体接收超时。')), 60_000); timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted); req.once('close', closed);
    if (req.aborted || req.destroyed) aborted();
    else if (Number(req.headers?.['content-length']) > maxLength) fail(new HttpError(413, '请求体超过大小上限。'));
  });
}
export function configureApiResponse(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  // No CORS headers: this application exposes only same-origin browser APIs.
}
export function handleHttpError(res: http.ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof HttpError ? error.status : error instanceof URIError || error instanceof SyntaxError ? 400 : 500;
  jsonReply(res, status, { error: status === 500 ? '请求处理失败。' : (error as Error).message });
}
