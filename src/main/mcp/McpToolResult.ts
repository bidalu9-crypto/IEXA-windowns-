import type { ToolExecutionResult } from '../providers/types';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_STRUCTURED_BYTES = 1024 * 1024;
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Adapt MCP CallToolResult, not its JSON-RPC envelope. Never execute/fetch content.
 * Keep screenshot bytes on the model image channel and respect isError independently
 * of transport success. See docs/CODEX_SOURCE_AUDIT_2026-09-15.md for upstream evidence.
 */
export function normalizeMcpToolResult(value: unknown): ToolExecutionResult {
  if (!object(value) || (!Array.isArray(value.content) && !object(value.structuredContent))) {
    return { success: false, output: 'MCP returned an invalid tools/call result; no action was retried.' };
  }
  const text: string[] = [];
  const problems: string[] = [];
  const images: NonNullable<ToolExecutionResult['images']> = [];
  let retainedBytes = 0; let textBytes = 0;
  const appendText = (value: string, label: string): void => {
    const bytes = Buffer.byteLength(value);
    if (textBytes + bytes > MAX_TEXT_BYTES) { problems.push(`${label} exceeds the 1 MB text limit`); return; }
    textBytes += bytes; text.push(value);
  };
  if (value.isError !== undefined && typeof value.isError !== 'boolean') problems.push('isError must be a boolean');
  if (value.content !== undefined && !Array.isArray(value.content)) problems.push('content must be an array');
  for (const item of Array.isArray(value.content) ? value.content : []) {
    if (!object(item)) { problems.push('invalid content block'); continue; }
    switch (item.type) {
      case 'text':
        if (typeof item.text === 'string') appendText(item.text, 'text content');
        else problems.push('text block has no text');
        break;
      case 'image': {
        try {
          if (images.length >= MAX_IMAGES) throw new Error(`more than ${MAX_IMAGES} images`);
          if (typeof item.data !== 'string' || item.data.length === 0 || item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
            throw new Error('image data must be bounded inline base64');
          }
          const mimeType = String(item.mimeType || '').toLowerCase();
          const data = Buffer.from(item.data, 'base64');
          const signatureValid = mimeType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
            : mimeType === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
            : mimeType === 'image/gif' ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))
            : mimeType === 'image/webp' ? data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' : false;
          if (!signatureValid) throw new Error('unsupported or mismatched image format');
          if (data.toString('base64') !== item.data) throw new Error('non-canonical base64 image');
          if (retainedBytes + data.length > MAX_IMAGE_BYTES) throw new Error('combined images exceed 6 MiB');
          retainedBytes += data.length;
          images.push({ data, mimeType });
          text.push(`[MCP image ${images.length}: ${mimeType}; pixels attached separately]`);
        } catch (error) { problems.push((error as Error).message); }
        break;
      }
      case 'resource':
        if (object(item.resource) && typeof item.resource.text === 'string') {
          text.push(`[MCP resource: ${String(item.resource.uri || '')}]\n${item.resource.text}`);
        } else {
          // Binary resources are references, not a reason to paste opaque bytes into context.
          text.push(`[MCP resource not decoded: ${object(item.resource) ? String(item.resource.uri || '') : 'invalid resource'}]`);
          problems.push('resource content was not fully interpreted');
        }
        break;
      case 'resource_link':
        if (typeof item.uri === 'string') text.push(`[MCP resource link: ${typeof item.name === 'string' ? item.name : ''}] ${item.uri}`);
        else problems.push('resource link has no URI');
        break;
      default:
        text.push(`[MCP content type not interpreted: ${String(item.type || 'unknown')}]`);
        problems.push('tool response includes unsupported content');
    }
  }
  if (value.structuredContent !== undefined) {
    if (object(value.structuredContent)) {
      try {
        const structured = JSON.stringify(value.structuredContent, null, 2);
        if (Buffer.byteLength(structured) > MAX_STRUCTURED_BYTES) problems.push('structuredContent exceeds the 1 MB limit');
        else appendText(`[MCP structured result]\n${structured}`, 'structuredContent');
      } catch { problems.push('structuredContent is not JSON serializable'); }
    } else problems.push('structuredContent must be an object');
  }
  // A failed invocation may still include the screenshot needed to diagnose it.
  if (value.isError === true) text.unshift('[MCP tool reported an error; action effects are not inferred from this status.]');
  if (problems.length) text.unshift(`[MCP response interpretation incomplete: ${problems.join('; ')}. Do not repeat input solely because response interpretation failed.]`);
  return {
    success: value.isError !== true && problems.length === 0,
    output: text.join('\n\n') || '[MCP tool returned no content]',
    ...(images.length ? { images, imageData: images[0].data, imageMimeType: images[0].mimeType } : {}),
    metadata: { mcp: { reportedError: value.isError === true, imageCount: images.length, interpretationErrors: problems } },
  };
}
