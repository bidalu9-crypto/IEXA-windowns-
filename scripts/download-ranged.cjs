'use strict';
const fs = require('node:fs/promises');
// Optional bounded range transport for networks that stall on large release assets.
// Integrity is still decided by download_electron.js using the official SHASUMS.
async function downloadRanged(url, destination, limit = 600 * 1024 * 1024) {
  let current = new URL(url), head;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (current.protocol !== 'https:') throw Error('Range download requires HTTPS');
    head = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if ([301, 302, 303, 307, 308].includes(head.status) && head.headers.get('location')) {
      current = new URL(head.headers.get('location'), current); continue;
    }
    break;
  }
  const size = Number(head.headers.get('content-length'));
  if (head.status !== 200 || !Number.isSafeInteger(size) || size < 1 || size > limit) throw Error('Invalid range download metadata');
  const temporary = `${destination}.${process.pid}.download`;
  const file = await fs.open(temporary, 'wx');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('Range download total timeout')), 600000);
  const chunkSize = 256 * 1024;
  let next = 0, completed = 0;
  async function worker() {
    while (next < size && !controller.signal.aborted) {
      const start = next; next += chunkSize;
      const end = Math.min(size - 1, start + chunkSize - 1);
      let bytes;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(current, { redirect: 'error', headers: { Range: `bytes=${start}-${end}` },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
            await response.body?.cancel(); throw Error('Server returned an unexpected range');
          }
          const chunks = []; let length = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              length += part.value.length;
              if (length > end - start + 1) throw Error('Oversized range response');
              chunks.push(Buffer.from(part.value));
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          bytes = Buffer.concat(chunks, length);
          if (bytes.length !== end - start + 1) throw Error('Truncated range');
          break;
        } catch (error) { if (attempt === 1 || controller.signal.aborted) throw error; }
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, start + written);
        if (result.bytesWritten === 0) throw Error('Short archive write');
        written += result.bytesWritten;
      }
      completed += bytes.length;
      if (Math.floor(completed / (16 * 1024 * 1024)) !== Math.floor((completed - bytes.length) / (16 * 1024 * 1024))) {
        console.log(`Electron range download: ${Math.round(completed / size * 100)}%`);
      }
    }
  }
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => worker().catch(error => { controller.abort(error); throw error; })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (completed !== size) throw Error('Incomplete range download');
    await file.close();
    await fs.rename(temporary, destination);
  } finally {
    clearTimeout(timer); await file.close().catch(() => {}); await fs.rm(temporary, { force: true });
  }
}
module.exports = { downloadRanged };
