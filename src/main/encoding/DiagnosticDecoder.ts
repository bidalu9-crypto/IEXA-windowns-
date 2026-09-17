import * as iconv from 'iconv-lite';

/** Decode raw diagnostic bytes once. Valid UTF-8 (including literal U+FFFD)
 * must not be reinterpreted as GBK. A declared encoding takes precedence. */
export function decodeDiagnostic(bytes: Buffer, encoding?: string): string {
  if (!bytes.length) return '';
  if (encoding && iconv.encodingExists(encoding)) return iconv.decode(bytes, encoding);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes.subarray(2), 'utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes.subarray(2), 'utf16be');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return iconv.decode(bytes, 'gb18030'); }
}

/** Line buffering keeps GBK/UTF-8 characters intact across arbitrary pipe
 * chunks. The cap bounds unbroken diagnostic lines from a noisy process. */
export class DiagnosticDecoder {
  private pending = Buffer.alloc(0);
  write(chunk: Buffer): string {
    this.pending = Buffer.concat([this.pending, chunk]);
    const end = this.pending.lastIndexOf(10);
    if (end >= 0) {
      const text = decodeDiagnostic(this.pending.subarray(0, end + 1));
      this.pending = this.pending.subarray(end + 1);
      return text;
    }
    if (this.pending.length > 65536) {
      // Prefer a prefix with complete UTF-8/GB18030 characters. Keep at most
      // four trailing bytes so the next chunk can finish the last character.
      for (let keep = 0; keep <= 4; keep++) {
        const bytes = this.pending.subarray(0, this.pending.length - keep);
        const text = decodeDiagnostic(bytes);
        if (!text.endsWith('\uFFFD')) { this.pending = this.pending.subarray(bytes.length); return text; }
      }
      // Invalid bytes are still diagnostics: emit a bounded replacement rather
      // than retaining an ever-growing undecodable line indefinitely.
      const prefix = this.pending.subarray(0, this.pending.length - 4);
      this.pending = this.pending.subarray(prefix.length);
      return decodeDiagnostic(prefix);
    }
    return '';
  }
  end(): string { const text = decodeDiagnostic(this.pending); this.pending = Buffer.alloc(0); return text; }
}

export async function readDiagnosticResponse(response: Response): Promise<string> {
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  return decodeDiagnostic(Buffer.from(await response.arrayBuffer()), charset);
}
