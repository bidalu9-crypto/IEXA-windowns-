// =============================================================================
// iExA PC - Local image reader (native vision input)
//
// Returns the original bytes as a ToolExecutionResult.imageData, which AgentLoop
// forwards as an independent `imageData` part. Every provider adapter already
// serialises that part as a model-visible image (OpenAI image_url / Responses
// input_image, Anthropic base64 block, Gemini inline data).
//
// A configured vision profile still wins: the server registers a different
// implementation for text-only chat models that delegates to VisionFallback.
// =============================================================================

import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';
import { resolveScopedPathAsync } from '../security/PathSandbox';
import { imageDimensions } from '../vision/ImageMetadata';

/** Conservative ceiling: base64 inflates by ~4/3, and providers cap images around 5 MB. */
export const MAX_READ_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Detect the real format from magic bytes; never trust the extension alone. */
export function sniffImageMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return undefined;
}

export function imageMimeTypeForPath(filePath: string): string | undefined {
  return EXTENSION_MIME[path.extname(filePath).toLowerCase()];
}

export const readImageParameters = {
  tool_title: { type: 'string', description: "A concise 5-10 word summary (e.g. 'Inspect design mock', 'Read error screenshot')." },
  path: { type: 'string', description: 'Image path relative to the workspace root (or an absolute path inside an authorized root).' },
  prompt: { type: 'string', description: 'Optional question to keep in mind when the image is attached. Text-only models use it to steer the vision proxy.' },
} as const;

export const readImageToolDefinition: AgentToolDefinition = {
  name: 'read_image',
  description:
    'Read a local image file (PNG/JPEG/GIF/WebP/BMP) and attach its actual pixels to the conversation so the model can look at it. Use this for screenshots, design mocks, diagrams and error captures that live in the workspace. The image is returned at its original resolution; keep files under 5 MB. When the active model cannot see images, the server replaces this tool with a vision-model description proxy.',
  parameters: readImageParameters,
  required: ['tool_title', 'path'],
  propertyOrdering: ['tool_title', 'path', 'prompt'],
};

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function readImageNative(input: Record<string, unknown>, roots: readonly string[]): Promise<ToolExecutionResult> {
  const requested = String(input.path ?? '').trim();
  if (!requested) return { output: 'Error: path is required.', success: false };

  let absolute: string;
  try { absolute = await resolveScopedPathAsync(requested, roots); }
  catch (error) { return { output: `图片路径不可用：${(error as Error).message}`, success: false }; }

  let handle;
  try {
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) return { output: '图片路径不是普通文件。', success: false };
    if (before.size > MAX_READ_IMAGE_BYTES) {
      return { output: `图片超过 ${formatBytes(MAX_READ_IMAGE_BYTES)}（${formatBytes(before.size)}）；请先缩小后再读取。`, success: false };
    }
    handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_READ_IMAGE_BYTES) return { output: '图片在读取前发生变化或超过大小上限。', success: false };

    const data = Buffer.alloc(stat.size);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) return { output: '图片读取不完整，请重试。', success: false };

    const bytes = data.subarray(0, length);
    const mimeType = sniffImageMime(bytes);
    const declared = imageMimeTypeForPath(absolute);
    if (!mimeType) return { output: '无法识别的图片格式（支持 PNG/JPEG/GIF/WebP/BMP）。', success: false };
    if (declared && declared !== mimeType) {
      return { output: `文件扩展名与实际格式不一致（扩展名 ${declared}，实际 ${mimeType}），已拒绝。`, success: false };
    }

    const dimensions = imageDimensions(bytes, mimeType);
    const sizeLine = dimensions ? `${dimensions.width}×${dimensions.height} · ${formatBytes(length)}` : formatBytes(length);
    const relative = path.relative(roots[0], absolute).split(path.sep).join('/') || path.basename(absolute);
    const prompt = String(input.prompt ?? '').trim();

    return {
      output: [
        `Image: ${relative}`,
        `Format: ${mimeType} · ${sizeLine}`,
        prompt ? `Question: ${prompt}` : undefined,
        '[Attached as image input; the model receives the original pixels.]',
      ].filter(Boolean).join('\n'),
      success: true,
      imageData: Buffer.from(bytes),
      imageMimeType: mimeType,
      artifacts: [{ kind: 'image', path: absolute, mimeType, size: length }],
    };
  } catch (error) {
    return { output: `读取图片失败：${(error as Error).message}`, success: false };
  } finally { try { await handle?.close(); } catch { /* already closed */ } }
}
