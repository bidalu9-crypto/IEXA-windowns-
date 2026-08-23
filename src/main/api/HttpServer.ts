import * as http from 'http';

export function jsonReply(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function readBody(req: http.IncomingMessage, maxLength = 10_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bodyBytes += Buffer.byteLength(chunk);
      body += chunk;
      if (bodyBytes > maxLength) {
        settled = true;
        reject(new Error(`请求体过大（上限 ${maxLength} 字节）。`));
        req.destroy();
      }
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(body); } });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

export function readRawBody(req: http.IncomingMessage, maxLength = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxLength) {
        settled = true;
        reject(new Error(`上传分块过大（上限 ${maxLength} 字节）。`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

export function configureApiResponse(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
