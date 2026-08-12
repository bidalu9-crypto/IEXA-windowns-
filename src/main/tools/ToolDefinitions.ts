// =============================================================================
// IEXA PC - Tool Definitions
// Mirrors iOS AIChatViewModel+ToolDefinitions.swift
// =============================================================================

import { AgentToolDefinition } from '../providers/types';

export function makeAgentTools(memoryEnabled: boolean = true): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
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
