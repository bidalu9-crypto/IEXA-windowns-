// =============================================================================
// IEXA PC - Tool Definitions
// Mirrors iOS AIChatViewModel+ToolDefinitions.swift
// =============================================================================

import { AgentToolDefinition } from '../providers/types';

export function makeAgentTools(memoryEnabled: boolean = true): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    {
      name: 'desktop_control',
      description: 'Operate real Windows applications using persistent native input, not scripts or JSON files. Never use shell/curl or write observe results to disk for desktop tasks. Activate the requested app, observe its current controls, then use short batch actions to avoid model round-trips. Re-observe after navigation; do not guess stale element IDs. Use verifyText to verify completion, and frame for fresh visual evidence when controls are unavailable. OCR is opt-in. If the user changes foreground, stop rather than steal focus. Use minimize instead of closing apps. Report concrete actions and verification, never claim success from input dispatch alone.',
      parameters: {
        tool_title: { type: 'string', description: 'A concise 5-10 word summary of the desktop action.' },
        detail: { type: 'string', description: 'Compact human-readable output by default; raw JSON only for explicit debugging.', enumValues: ['compact', 'raw'] },
        action: { type: 'string', description: 'Desktop operation.', enumValues: ['observe', 'frame', 'activate', 'minimize', 'bind_window', 'session_state', 'move', 'click', 'drag', 'click_element', 'type', 'type_element', 'find_element', 'read_focused', 'key', 'hotkey', 'scroll', 'wait', 'wait_change', 'batch'] },
        window: { type: 'string', description: 'Partial title of the target window.' },
        process: { type: 'string', description: 'Process-name filter for window activation, useful when title text is unavailable.' },
        handle: { type: 'integer', description: 'Exact native window handle returned by observe.' },
        elementId: { type: 'string', description: 'Semantic element ID returned by the latest observe.' },
        role: { type: 'string', description: 'Role filter for find_element, such as button, search, edit, icon.' },
        replace: { type: 'boolean', description: 'For type_element, select existing content before typing (default true).' },
        threshold: { type: 'integer', description: 'Frame-change threshold expressed as thousandths, e.g. 15 means 0.015.' },
        x: { type: 'integer', description: 'Absolute virtual-screen X coordinate; relative coordinates are preferred.' },
        y: { type: 'integer', description: 'Absolute virtual-screen Y coordinate; relative coordinates are preferred.' },
        relativeX: { type: 'integer', description: 'X coordinate relative to the bound window left edge.' },
        relativeY: { type: 'integer', description: 'Y coordinate relative to the bound window top edge.' },
        toX: { type: 'integer', description: 'Drag destination absolute virtual-screen X coordinate.' },
        toY: { type: 'integer', description: 'Drag destination absolute virtual-screen Y coordinate.' },
        toRelativeX: { type: 'integer', description: 'Drag destination X relative to the bound window left edge.' },
        toRelativeY: { type: 'integer', description: 'Drag destination Y relative to the bound window top edge.' },
        observationToken: { type: 'string', description: 'Token returned by the latest observe; stale tokens fail closed.' },
        autoActivate: { type: 'boolean', description: 'Restore target to foreground before input. Default false respects user focus changes; use activate explicitly.' },
        allowGeometryChange: { type: 'boolean', description: 'Allow window move/resize; default false requires a fresh observe.' },
        settleMs: { type: 'integer', description: 'Short delay before capturing post-action evidence.' },
        durationMs: { type: 'integer', description: 'Human-like pointer movement duration.' },
        button: { type: 'string', description: 'Mouse button.', enumValues: ['left', 'right', 'middle'] },
        count: { type: 'integer', description: 'Click or key repeat count.' },
        text: { type: 'string', description: 'Text to type, or visible text to wait for.' },
        intervalMs: { type: 'integer', description: 'Delay between typed characters.' },
        key: { type: 'string', description: 'Key name such as ENTER, TAB, ESC, CTRL, F5.' },
        keys: { type: 'array', description: 'Hotkey sequence such as [CTRL, L].', items: { type: 'string', description: 'Key name.' } },
        allowClose: { type: 'boolean', description: 'Explicitly allow a close-window hotkey such as ALT+F4. Default false.' },
        delta: { type: 'integer', description: 'Mouse wheel notches; negative scrolls down.' },
        timeoutMs: { type: 'integer', description: 'Wait timeout in milliseconds.' },
        includeElements: { type: 'boolean', description: 'Include visible UI Automation elements in observe.' },
        includeOcr: { type: 'boolean', description: 'Run local OCR only when UI controls are insufficient (default false).' },
        includeRegions: { type: 'boolean', description: 'Detect unlabeled regions when needed (default false).' },
        captureFrame: { type: 'boolean', description: 'Attach a fresh PNG of all monitors. Default false so non-vision models receive only the compact semantic map.' },
        limit: { type: 'integer', description: 'Maximum UI elements returned by observe.' },
        actions: { type: 'array', description: 'Ordered action objects for a low-latency continuous batch.', items: { type: 'object', description: 'One action object.' } },
        verifyText: { type: 'string', description: 'After a batch, verify this text is visible in the foreground UI tree.' },
      },
      required: ['tool_title', 'action'],
      propertyOrdering: ['tool_title', 'action', 'window', 'process', 'handle', 'observationToken', 'elementId', 'role', 'relativeX', 'relativeY', 'toRelativeX', 'toRelativeY', 'x', 'y', 'toX', 'toY', 'autoActivate', 'allowGeometryChange', 'settleMs', 'durationMs', 'button', 'count', 'text', 'replace', 'intervalMs', 'key', 'keys', 'allowClose', 'delta', 'timeoutMs', 'threshold', 'includeElements', 'includeOcr', 'includeRegions', 'captureFrame', 'limit', 'actions', 'verifyText'],
    },
    {
      name: 'todo_write',
      description:
        'Create or replace the complete task plan for the current user request. Use this for multi-step work: call it at the start with a concise checklist, update it as work progresses, and mark items completed only after verification. Every call replaces the entire list. Keep exactly one item in_progress unless work is genuinely parallel.',
      parameters: {
        todos: {
          type: 'array',
          description: 'Complete checklist array. Each item must be { content: string, status: pending | in_progress | completed }. Send the full list on every update, not partial edits.',
          items: {
            type: 'object',
            description: 'One task plan item.',
            properties: {
              content: { type: 'string', description: 'Concise task description.' },
              status: { type: 'string', description: 'Task state.', enumValues: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
      propertyOrdering: ['todos'],
    },
    {
      name: 'shell_execute',
      description:
        'Execute a command in a shell process. The command runs via the system shell (cmd.exe on Windows, /bin/sh on Unix) with stdout and stderr captured separately. Each invocation spawns a fresh process — there is no shared terminal session. Default timeout is 15 minutes (900s).',
      parameters: {
        tool_title: {
          type: 'string',
          description:
            "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Install Python packages', 'List files in directory'). Use the same language as the user.",
        },
        command: {
          type: 'string',
          description:
            'The shell command to execute. Supports multi-line commands. Keep under 4000 chars; for longer scripts, write to a file with file_write first, then run it.',
        },
        timeout: {
          type: 'integer',
          description:
            'Timeout in seconds (default: 900, max: 3600). Use a larger value for long-running commands like package installs.',
        },
      },
      required: ['tool_title', 'command'],
      propertyOrdering: ['tool_title', 'command', 'timeout'],
    },
    {
      name: 'file_read',
      description:
        'Read a file from the local filesystem. Returns file content with metadata. Rejects binary files. Faster than shell_execute for reading files.',
      parameters: {
        tool_title: {
          type: 'string',
          description:
            "A concise 5-10 word summary (e.g. 'Read Python script', 'Check config file').",
        },
        path: {
          type: 'string',
          description: 'Absolute or relative path to read (e.g. C:\\Users\\...\\file.txt or /home/user/file.txt)',
        },
        offset: {
          type: 'integer',
          description: '1-based line number to start reading from (default: 1).',
        },
        lines: {
          type: 'integer',
          description: 'Maximum number of lines to return (default: all lines up to max_length).',
        },
        max_length: {
          type: 'integer',
          description: 'Maximum character length of returned content (default: 15000).',
        },
        direction: {
          type: 'string',
          description: "Read direction: 'head' (from start, default) or 'tail' (from end of file).",
          enumValues: ['head', 'tail'],
        },
      },
      required: ['tool_title', 'path'],
      propertyOrdering: ['tool_title', 'path', 'offset', 'lines', 'direction', 'max_length'],
    },
    {
      name: 'file_write',
      description:
        'Write content to a file on the local filesystem. Creates the file if it does not exist. Use append mode to add to existing files.',
      parameters: {
        tool_title: {
          type: 'string',
          description:
            "A concise 5-10 word summary (e.g. 'Create Python script', 'Write config file').",
        },
        path: {
          type: 'string',
          description: 'Absolute or relative path to write (e.g. C:\\Users\\...\\output.txt)',
        },
        content: {
          type: 'string',
          description: 'The text content to write to the file.',
        },
        append: {
          type: 'boolean',
          description: 'If true, append to existing file instead of overwriting (default: false).',
        },
        create_dirs: {
          type: 'boolean',
          description:
            'If true, create parent directories if they do not exist (default: false). Set true when creating a new Skill under the skills directory.',
        },
      },
      required: ['tool_title', 'path', 'content'],
      propertyOrdering: ['tool_title', 'path', 'content', 'append', 'create_dirs'],
    },
    {
      name: 'file_edit',
      description:
        'Make targeted edits to an existing file using exact string replacement. ALWAYS use file_read first to see the current file contents before editing. Prefer file_edit over file_write when modifying existing files. The old_string must match exactly one location in the file (including whitespace/indentation), unless replace_all is true.',
      parameters: {
        tool_title: {
          type: 'string',
          description:
            "A concise 5-10 word summary (e.g. 'Fix typo in script', 'Update config value').",
        },
        path: {
          type: 'string',
          description: 'Absolute path to the file to edit.',
        },
        old_string: {
          type: 'string',
          description:
            'The exact text to find in the file. Must match precisely including whitespace and indentation. Must be unique unless replace_all is true.',
        },
        new_string: {
          type: 'string',
          description: "The replacement text. Use empty string to delete old_string.",
        },
        replace_all: {
          type: 'boolean',
          description: 'If true, replace ALL occurrences of old_string (default: false).',
        },
      },
      required: ['tool_title', 'path', 'old_string', 'new_string'],
      propertyOrdering: ['tool_title', 'path', 'old_string', 'new_string', 'replace_all'],
    },
    {
      name: 'browser_fetch',
      description:
        'Fetch content from a URL. Returns the page content as text (HTML converted to readable text). Use this to retrieve web pages, API responses, or download files.',
      parameters: {
        tool_title: {
          type: 'string',
          description: "A concise summary (e.g. 'Fetch documentation page', 'Download JSON data').",
        },
        url: {
          type: 'string',
          description: 'The URL to fetch content from. HTTP is upgraded to HTTPS.',
        },
        max_length: {
          type: 'integer',
          description: 'Maximum character length of returned content (default: 25000).',
        },
      },
      required: ['tool_title', 'url'],
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
          description: 'Absolute or relative path to the media file to display (e.g. C:\Users\...\image.png or workspace/attachments/clip.mp4)',
        },
      },
      required: ['tool_title', 'path'],
      propertyOrdering: ['tool_title', 'path'],
    },
  ];

  if (memoryEnabled) {
    tools.push({
      name: 'memory_write',
      description:
        'Write a memory entry to persistent storage. Memories persist across all sessions. Each entry is prepended with a timestamp. Save: user preferences, recurring patterns, key facts, project conventions, reusable knowledge.',
      parameters: {
        tool_title: {
          type: 'string',
          description:
            "A concise 5-10 word summary (e.g. 'Save user preference', 'Note project context').",
        },
        content: {
          type: 'string',
          description:
            'The memory content to write. Use concise Markdown with a short heading (## Topic) and context about what was done/learned.',
        },
      },
      required: ['tool_title', 'content'],
      propertyOrdering: ['tool_title', 'content'],
    });

    tools.push({
      name: 'memory_get',
      description:
        'Retrieve memories from persistent storage. Supports keyword-based fuzzy search. Returns matching entries with context.',
      parameters: {
        tool_title: {
          type: 'string',
          description:
            "A concise summary (e.g. 'Recall user preferences', 'Search past notes').",
        },
        keywords: {
          type: 'string',
          description:
            "Space-separated keywords for matching (e.g. 'python preference'). Leave empty to return recent memories.",
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 20).',
        },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title', 'keywords', 'limit'],
    });
  }

  return tools;
}
