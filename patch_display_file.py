# -*- coding: utf-8 -*-
"""Add a display_file tool so the agent can show any local media file."""

import os

ROOT = r'C:\Users\Administrator\Desktop\iEXA-WIN'

# ---- 1. ToolDefinitions.ts: add display_file tool definition ----
fp = os.path.join(ROOT, 'src', 'main', 'tools', 'ToolDefinitions.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

old_insert = '''      required: ['tool_title', 'url'],
      propertyOrdering: ['tool_title', 'url', 'max_length'],
    },
  ];'''

new_insert = '''      required: ['tool_title', 'url'],
      propertyOrdering: ['tool_title', 'url', 'max_length'],
    },
    {
      name: 'display_file',
      description:
        'Display a local media file (image, video, or audio) to the user in the chat. Use this to show ANY file on disk regardless of where it was generated: generated images, downloaded videos, audio clips, etc. The path can be absolute or relative to the workspace. Call this whenever you create or download an image/video/audio that the user should see or play.',
      parameters: {
        tool_title: {
          type: 'string',
          description: "A concise 5-10 word summary (e.g. 'Show generated image', 'Play downloaded video').",
        },
        path: {
          type: 'string',
          description: 'Absolute or relative path to the media file to display (e.g. C:\\Users\\...\\image.png or workspace/attachments/clip.mp4)',
        },
      },
      required: ['tool_title', 'path'],
      propertyOrdering: ['tool_title', 'path'],
    },
  ];'''

c = src.count(old_insert)
assert c == 1, f'ToolDefinitions insert: expected 1, got {c}'
src = src.replace(old_insert, new_insert)
with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE ToolDefinitions.ts')

# ---- 2. ToolExecutors.ts: add displayFile result builder helper ----
# We'll add a static helper that builds a ToolExecutionResult for a media file.
fp = os.path.join(ROOT, 'src', 'main', 'tools', 'ToolExecutors.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

# Add a media mime helper function near the top after imports
old_fn = '''function changeSummary(filePath: string, before: string, after: string): ToolExecutionResult['fileChange'] {'''
new_fn = '''const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac', '.aac': 'audio/aac',
};

/** Build a ToolExecutionResult that surfaces a local media file to the UI. */
export async function buildMediaDisplayResult(filePath: string, workspaceDir: string): Promise<ToolExecutionResult> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      return { output: `Display failed: not a file: ${absolute}`, success: false };
    }
    const ext = path.extname(absolute).toLowerCase();
    const mimeType = MEDIA_MIME[ext];
    if (!mimeType) {
      return { output: `Display failed: unsupported media type (${ext || 'no extension'}) for ${absolute}`, success: false };
    }
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file' as const;
    // Load image bytes for immediate inline preview; audio/video stream via URL.
    let imageData: Buffer | undefined;
    let imageMimeType: string | undefined;
    if (kind === 'image' && stat.size <= 10 * 1024 * 1024) {
      imageData = await fs.readFile(absolute);
      imageMimeType = mimeType;
    }
    return {
      output: kind === 'image' ? `Displaying image: ${absolute}` : `Displaying ${kind}: ${absolute}`,
      success: true,
      imageData,
      imageMimeType,
      artifacts: [{ kind, path: absolute, mimeType, size: stat.size }],
    };
  } catch (err) {
    return { output: `Display failed: ${(err as Error).message}`, success: false };
  }
}

function changeSummary(filePath: string, before: string, after: string): ToolExecutionResult['fileChange'] {'''
c = src.count(old_fn)
assert c == 1, f'ToolExecutors helper: expected 1, got {c}'
src = src.replace(old_fn, new_fn)
with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE ToolExecutors.ts')

# ---- 3. AgentLoop.ts: handle display_file tool ----
fp = os.path.join(ROOT, 'src', 'main', 'agent', 'AgentLoop.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

# 3a. Import buildMediaDisplayResult
old_imp = "import { ShellExecutor, FileTools, MemoryTools, BrowserFetch } from '../tools/ToolExecutors';"
new_imp = "import { ShellExecutor, FileTools, MemoryTools, BrowserFetch, buildMediaDisplayResult } from '../tools/ToolExecutors';"
c = src.count(old_imp)
assert c == 1, f'AgentLoop import: expected 1, got {c}'
src = src.replace(old_imp, new_imp)

# 3b. Add case in executeTool switch
old_case = '''      case 'browser_fetch': {
        const url = String(args.url || '');
        const maxLength = Number(args.max_length) || 25000;
        return await this.browser.fetch(url, maxLength);
      }'''
new_case = '''      case 'browser_fetch': {
        const url = String(args.url || '');
        const maxLength = Number(args.max_length) || 25000;
        return await this.browser.fetch(url, maxLength);
      }

      case 'display_file': {
        const filePath = String(args.path || '');
        return await buildMediaDisplayResult(filePath, this.config.workspaceDir);
      }'''
c = src.count(old_case)
assert c == 1, f'AgentLoop case: expected 1, got {c}'
src = src.replace(old_case, new_case)

with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE AgentLoop.ts')

# ---- 4. server.ts: ensure artifact path is reachable via /api/fs/raw even outside workspace ----
fp = os.path.join(ROOT, 'src', 'main', 'server.ts')
with open(fp, 'r', encoding='utf-8') as f:
    src = f.read()

# The artifact registry already stores absolute path and streams via /api/artifacts/{id}.
# In onToolResult we already register artifacts with absolute path. Confirm the
# artifact registry entry uses absolute path (it does: path.resolve). No change needed.
# But we should verify the onToolResult keeps audio/video artifacts (it does).

# Ensure fs/raw can serve any absolute path the agent registers. Currently /api/fs/raw
# restricts to project root / workspace. But artifacts use /api/artifacts which is unrestricted.
# So no server change needed for display_file (it uses artifactRegistry). Confirm.

with open(fp, 'w', encoding='utf-8') as f:
    f.write(src)
print('DONE server.ts (no change needed - artifacts already stream absolute paths)')

print('ALL DISPLAY_FILE PATCHES APPLIED')