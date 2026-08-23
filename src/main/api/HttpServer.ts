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

export function configureApiResponse(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
