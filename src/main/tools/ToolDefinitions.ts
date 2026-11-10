// =============================================================================
// IEXA PC - Tool Definitions
// Mirrors iOS AIChatViewModel+ToolDefinitions.swift
// =============================================================================

import { AgentToolDefinition } from '../providers/types';

/**
 * Optional tool families. They are only advertised when the server can actually
 * back them (a terminal manager, the job audit trail, the goal store), so a
 * provider never receives a tool the runtime cannot execute.
 */
export interface ToolSurfaceOptions { shellSession?: boolean; jobs?: boolean; goal?: boolean; bots?: boolean; scheduledTasks?: boolean; }

export function makeAgentTools(memoryEnabled: boolean = true, surface: ToolSurfaceOptions = {}): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    {
      name: 'project_instructions',
      description: 'Read scoped AGENTS.md project guidance before editing files or running directory-specific commands. Returns source paths, scope, SHA256 and full bounded content. Re-read after switching directories, session recovery or context compaction. This does not grant permissions.',
      parameters: {
        tool_title: { type: 'string', description: 'Short description of the scope being inspected.' },
        path: { type: 'string', description: 'Target file path relative to the project, or a directory when kind=directory.' },
        kind: { type: 'string', enumValues: ['file', 'directory'], description: 'Target type; defaults to file. Use directory for an existing or new directory.' },
      },
      required: ['tool_title', 'path'],
      propertyOrdering: ['tool_title', 'path', 'kind'],
    },
    {
      name: 'desktop_control',
      description: 'Operate real Windows applications through a persistent perception-action loop. Background mode is the default and persists for this owner; omitted mode/background arguments never enable physical input. Start with list_windows, then observe, act, and verify. A new background launch without a selected backend uses native-isolated and requires a direct executable; existing windows remain on their selected backend. Unsupported background actions return without physical input or foreground fallback. Generic native UIA uses semantic patterns only, but an application provider may change focus; use an isolated workspace for strict separation. For physical input explicitly select controlMode=foreground; its default focusPolicy=stop never activates an unfocused target. focusPolicy=wait waits for the user; activate reclaims focus only when explicitly selected in foreground mode. Use this for actual GUI observation and input, not tasks a supported CLI, PowerShell command or public API performs directly. Never proxy GUI observation/input through shell/curl or write observations to disk. Re-observe after navigation; do not guess stale element IDs or replay uncertain input. UI Automation patterns run first. forcePointer is foreground-only and requires fresh evidence of a missing effect. Use verifyText or fresh observations to verify business completion. For download/save/rename, inspect the filename field and selection before typing: Explorer may hide extensions or select only the basename. Verify the actual full path, extension and file type through Properties or an Open/Save dialog, then reopen it to check content; a display name or input acknowledgement is insufficient. On file-not-found or partial batch failure, observe current state and correct the actual path or missing step instead of replaying the same input. Ordinary pointer movement does not revoke the operation lease.',
      parameters: {
        tool_title: { type: 'string', description: 'A concise 5-10 word summary of the desktop action.' },
        detail: { type: 'string', description: 'Compact human-readable output by default; raw JSON only for explicit debugging.', enumValues: ['compact', 'raw'] },
        action: { type: 'string', description: 'Desktop operation. chromium-cdp also supports select_option, set_value, insert_text and observed-node renderer key/hotkey/drag; these never use Windows physical input.', enumValues: ['list_windows', 'launch', 'observe', 'frame', 'activate', 'minimize', 'bind_window', 'session_state', 'move', 'click', 'drag', 'click_element', 'type', 'type_element', 'select_option', 'set_value', 'insert_text', 'find_element', 'read_focused', 'key', 'hotkey', 'scroll', 'wait', 'wait_change', 'batch'] },
        controlMode: { type: 'string', description: 'Persistent mode for this control owner. background is the default: semantic operations only, no physical input, activation or foreground fallback. foreground explicitly permits physical input on the bound foreground window; focusPolicy defaults to stop. Omitting this and background retains the previous mode. Conflicting mode/background values fail before dispatch.', enumValues: ['background', 'foreground'] },
        backend: { type: 'string', description: 'Select the backend explicitly requested for this task: native can launch apps AND control existing windows on the normal desktop; pair it with controlMode=foreground when physical input is authorized. native-isolated launches on a separate Windows desktop and permits background semantic operations only; never select native-isolated with foreground mode. chromium-cdp targets an explicitly supplied browser page. New app launch does not require native-isolated when the user requested native foreground control. Isolation is UI separation, not a file/network sandbox.', enumValues: ['native', 'native-isolated', 'chromium-cdp'] },
        focusPolicy: { type: 'string', description: 'Foreground focus behaviour; default stop. stop dispatches no physical input when the target is unfocused. wait waits up to focusWaitMs for the user to return focus, then observes again. activate explicitly opts into foreground activation/reacquisition; it never activates in background mode.', enumValues: ['stop', 'wait', 'activate'] },
        focusWaitMs: { type: 'integer', description: 'Maximum user-focus wait when focusPolicy=wait, 1–60000 ms; default 30000. Timeout sends no input.' },
        cdpTargetId: { type: 'string', description: 'Exact Chromium page ID returned by list_windows. Required to disambiguate tabs; changing target invalidates old observations.' },
        cdpEndpoint: { type: 'string', description: 'Loopback Chromium DevTools HTTP endpoint, for example http://127.0.0.1:9222. Never use a public endpoint.' },
        app: { type: 'string', description: 'Application name, executable, document, URI, or full path for launch, such as notepad, calculator, settings, chrome, or C:\\Path\\App.exe.' },
        executable: { type: 'string', description: 'Explicit executable path or command for launch; app is preferred for common applications.' },
        arguments: { type: 'string', description: 'Optional command-line arguments passed directly to the launched application.' },
        workingDirectory: { type: 'string', description: 'Optional working directory for launch.' },
        waitForWindowMs: { type: 'integer', description: 'How long launch waits for a controllable top-level window. Default 15000; the client timeout follows it.' },
        forceNew: { type: 'boolean', description: 'Start a second instance even when the app is already running. Ignored for single-instance apps, which never open a second window.' },
        window: { type: 'string', description: 'Partial title of the target window.' },
        process: { type: 'string', description: 'Process-name filter for window activation, useful when title text is unavailable.' },
        pid: { type: 'integer', description: 'Exact process ID for disambiguating multiple instances.' },
        handle: { type: 'integer', description: 'Exact native window handle returned by observation or foregroundRecovery.nextObservation. After an action opens a popup, explicitly observe its actual foreground handle, including untitled windows, before further input; do not repeat the opener or activate the parent to recover.' },
        target: { type: 'object', description: 'Exact observed selector for click/type and chromium-cdp component, keyboard, scroll or drag actions; prefer automationId, otherwise name+role. Ambiguous targets fail before input. CDP key/hotkey may omit target only when the observed actual control remains focused.', properties: {
          automationId: { type: 'string', description: 'Exact UIA AutomationId.' },
          name: { type: 'string', description: 'Exact visible control name.' },
          role: { type: 'string', description: 'Exact role or ControlType.' },
          elementId: { type: 'string', description: 'ID from this session’s latest observation.' },
        } },
        elementId: { type: 'string', description: 'Semantic element ID from the latest observe. Optional: pass text instead to locate the control at click time, which is the reliable path for apps whose UI Automation tree is empty (Qt, canvas, games).' },
        role: { type: 'string', description: 'Role filter for find_element/click_element, such as button, search, edit, icon.' },
        label: { type: 'string', description: 'Visible label of the control to locate. Use with click_element/type_element when elementId is unknown; resolution tries UI Automation, then OCR. This is how self-drawn UIs (Qt, canvas, games) are driven without coordinates.' },
        replace: { type: 'boolean', description: 'For type/type_element, replace existing content by default. Verify caret and selected range before partial document replacement; moving down does not imply line start. For Save As, select the format first, then enter the complete filename and observe filename, directory and type together. CDP insert_text appends at the actual caret unless replace=true; Monaco/xterm use renderer keyboard input.' },
        value: { type: 'string', description: 'chromium-cdp: exact option value for select_option, or serialized input value for set_value. For an exact option label use text instead. Range/number values must satisfy min/max/step.' },
        forcePointer: { type: 'boolean', description: 'For click_element only, bypass UIA patterns and issue one managed physical click after a fresh observe. Use only when the prior pattern action returned effectObserved=false.' },
        rendererInput: { type: 'boolean', description: 'chromium-cdp click/click_element only: use actual CDP renderer mouse events against the observed node and validated coordinates. Useful for file-picker triggers and other trusted-click handlers. Default false keeps ordinary left click semantic. Never uses Windows physical input or bypasses current-node/token/visibility checks.' },
        threshold: { type: 'integer', description: 'Frame-change threshold expressed as thousandths, e.g. 15 means 0.015.' },
        x: { type: 'integer', description: 'Absolute virtual-screen X coordinate; relative coordinates are preferred.' },
        y: { type: 'integer', description: 'Absolute virtual-screen Y coordinate; relative coordinates are preferred.' },
        relativeX: { type: 'integer', description: 'X coordinate relative to the bound window left edge; chromium-cdp uses CSS viewport X and requires the start inside an observed target.' },
        relativeY: { type: 'integer', description: 'Y coordinate relative to the bound window top edge; chromium-cdp uses CSS viewport Y and requires the start inside an observed target.' },
        toX: { type: 'integer', description: 'Drag destination absolute virtual-screen X coordinate.' },
        toY: { type: 'integer', description: 'Drag destination absolute virtual-screen Y coordinate.' },
        toRelativeX: { type: 'integer', description: 'Drag destination X relative to the bound window left edge.' },
        toRelativeY: { type: 'integer', description: 'Drag destination Y relative to the bound window top edge.' },
        observationToken: { type: 'string', description: 'Token returned by the latest observe; stale tokens fail closed.' },
        background: { type: 'boolean', description: 'Compatibility alias for controlMode: true=background (default), false=explicit foreground. Persists for this owner when later calls omit it. Background bind/observe never activates; input uses semantic patterns with no physical or legacy fallback. native-isolated can launch a direct executable. Native UIA providers/page handlers may still change focus; this is not a universal no-interference guarantee. Never restore focus or replay an uncertain action.' },
        autoActivate: { type: 'boolean', description: 'Managed control requires false; use explicit activate followed by observe instead of stealing user focus.' },
        allowGeometryChange: { type: 'boolean', description: 'Allow window move/resize; default false requires a fresh observe.' },
        settleMs: { type: 'integer', description: 'Short delay before capturing post-action evidence.' },
        durationMs: { type: 'integer', description: 'Human-like pointer movement duration.' },
        button: { type: 'string', description: 'Mouse button.', enumValues: ['left', 'right', 'middle'] },
        count: { type: 'integer', description: 'Click, key or hotkey repeat count. hotkey repeats the complete chord 1–50 times (default 1); count must be an integer.' },
        text: { type: 'string', description: 'Text to type, visible text to wait for, or — with click_element/type_element/find_element — the label of the control to locate. Targeting resolves UI Automation first, then OCR, so no coordinates are needed.' },
        intervalMs: { type: 'integer', description: 'Delay between typed characters.' },
        key: { type: 'string', description: 'One key for action=key, such as ENTER, TAB, ESC or F5. Never pass a chord such as CTRL+S or ALT+F4 here; use action=hotkey with a keys array. Native key/hotkey uses the observed window and focus without target. A confirmed focused native dropdown may support first-letter selection; observe its exact value afterward instead of blindly scrolling or repeating selection.' },
        keys: { type: 'array', description: 'Separate simultaneous key names for action=hotkey, e.g. ["CTRL","S"] or ["ALT","F4"]. Closing chords require allowClose=true. Do not pass the chord as a single string or use action=key.', items: { type: 'string', description: 'One key name, not a chord.' } },
        allowClose: { type: 'boolean', description: 'Explicitly allow a close-window hotkey such as ALT+F4. Default false.' },
        expectWindowClosed: { type: 'boolean', description: 'Explicit click/key/hotkey closure expectation: foreground native checks the exact original handle including hidden windows and confirms disappearance, including the last app window; chromium-cdp confirms the exact observed cdpTargetId disappeared from the same endpoint. Only a completed, acknowledged input can produce verified window_closed. Clears the observation capability and never binds/activates/selects a replacement. Observe the intended remaining window explicitly to verify business results. Default false.' },
        delta: { type: 'integer', description: 'Mouse wheel notches; negative scrolls down.' },
        deltaX: { type: 'integer', description: 'chromium-cdp scroll: horizontal CSS pixels inside the observed scroll container, bounded to 10000 in magnitude.' },
        deltaY: { type: 'integer', description: 'chromium-cdp scroll: vertical CSS pixels inside the observed scroll container; positive scrolls down. Overrides delta. Without target only the observed document scroller is eligible.' },
        timeoutMs: { type: 'integer', description: 'Wait timeout in milliseconds.' },
        includeElements: { type: 'boolean', description: 'Include visible UI Automation elements in observe.' },
        includeOcr: { type: 'boolean', description: 'Run local OCR only when UI controls are insufficient (default false). OCR elements expose confidence:null when the recognizer provides no calibrated confidence; cross-check the current frame before acting on OCR-only targets.' },
        includeRegions: { type: 'boolean', description: 'Detect unlabeled regions when needed (default false).' },
        captureFrame: { type: 'boolean', description: 'Attach the PNG bound to the observe token, not a later independent screenshot. Defaults true for vision-capable profiles and false for text-only profiles.' },
        includeHidden: { type: 'boolean', description: 'Include hidden titled windows in list_windows. Default false.' },
        limit: { type: 'integer', description: 'Maximum UI elements collected by observe. Native limit is capped at 200; automatic post-action observations use at least 100 and retain a larger requested limit for this session. The post-action display summary is separately capped at 40 controls; exact target resolution uses the full fresh collection.' },
        actions: { type: 'array', description: '1–24 input actions, executed serially with a fresh observation after every step. Each object MUST have an action field, not type. Example: [{"action":"type","text":"hello"},{"action":"key","key":"ENTER"}]. Single key uses key; a chord uses action=hotkey with keys=["CTRL","S"]. click_element/type_element require target or elementId. Semantic targets are resolved per step; stale IDs fail. Bind/launch separately. Batch receipts are action acknowledgements, not proof of saved or renamed files. After a partial failure, observe and verify completed effects before sending only a missing step; never replay the whole batch.', items: { type: 'object', description: 'One input action object with action and its arguments, using the same field names as a single desktop call.' } },
        verifyText: { type: 'string', description: 'After any input action or batch, require this text in a fresh UIA/OCR observation. A mismatch reports failure without retrying input. Visible text alone does not prove an exact filename/path or saved content; inspect the full path and reopen the file when those are the goal.' },
      },
      required: ['tool_title', 'action'],
      propertyOrdering: ['tool_title', 'action', 'controlMode', 'backend', 'focusPolicy', 'focusWaitMs', 'cdpEndpoint', 'cdpTargetId', 'app', 'executable', 'arguments', 'workingDirectory', 'waitForWindowMs', 'forceNew', 'window', 'process', 'pid', 'handle', 'observationToken', 'target', 'elementId', 'role', 'label', 'relativeX', 'relativeY', 'toRelativeX', 'toRelativeY', 'x', 'y', 'toX', 'toY', 'autoActivate', 'background', 'allowGeometryChange', 'settleMs', 'durationMs', 'button', 'count', 'text', 'value', 'replace', 'forcePointer', 'rendererInput', 'intervalMs', 'key', 'keys', 'allowClose', 'expectWindowClosed', 'delta', 'deltaX', 'deltaY', 'timeoutMs', 'threshold', 'includeElements', 'includeOcr', 'includeRegions', 'captureFrame', 'includeHidden', 'limit', 'actions', 'verifyText'],
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
      name: 'ask_user',
      description:
        'Pause the turn and ask the user through an interactive card in the conversation, then wait for their answers before continuing. Supports single choice (options), multiple choice (multi_select: true), free text (no options, or allow_free_text: true) and a lightweight confirmation (confirm). Use it when a decision, preference, missing detail or explicit confirmation is required — especially before risky or irreversible actions — instead of guessing. One card may contain several questions; the user answers them one by one and submits once. Do not use it for small talk or when the answer is already available.',
      parameters: {
        tool_title: { type: 'string', description: 'Short card title summary, e.g. 「部署确认」.' },
        title: { type: 'string', description: 'Card title. Falls back to tool_title when omitted.' },
        confirm: { type: 'string', description: 'Confirmation question rendered with 确认/取消 buttons. Use either confirm or questions, not both.' },
        questions: {
          type: 'array',
          description: 'Question list (1-8 items). The user answers them one by one.',
          items: {
            type: 'object',
            description: 'One card question.',
            properties: {
              id: { type: 'string', description: 'Stable answer id (optional; defaults to q1, q2…).' },
              header: { type: 'string', description: 'Short label chip (≤16 chars).' },
              question: { type: 'string', description: 'Full question text.' },
              options: {
                type: 'array',
                description: 'Choice list. Omit for a plain text-input question.',
                items: {
                  type: 'object',
                  description: 'One option.',
                  properties: {
                    label: { type: 'string', description: 'Option text shown to the user.' },
                    description: { type: 'string', description: 'Optional supporting detail.' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean', description: 'Allow selecting several options.' },
              allow_free_text: { type: 'boolean', description: 'Also accept a typed answer. Defaults to true when no options are given.' },
              placeholder: { type: 'string', description: 'Placeholder for the free-text input.' },
            },
            required: ['question'],
          },
        },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title', 'title', 'confirm', 'questions'],
    },
    {
      name: 'shell_execute',
      description:
        'Execute a command in a fresh shell process with stdout and stderr captured. Prefer direct CLI, PowerShell and public APIs for application tasks they support; use desktop_control for real GUI observation/input. On Windows, set shell to cmd for CMD/batch syntax or powershell/pwsh for raw PowerShell source. auto remains compatible with commands that start with powershell -Command. Default timeout is 15 minutes (900s).',
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
        shell: {
          type: 'string',
          description: 'Interpreter for this command. On Windows use cmd for batch syntax and powershell or pwsh for raw PowerShell source. auto detects a top-level powershell -Command invocation and otherwise uses CMD.',
          enumValues: ['auto', 'cmd', 'powershell', 'pwsh'],
        },
        timeout: {
          type: 'integer', minimum: 1, maximum: 3600,
          description:
            'Timeout in seconds (default: 900, max: 3600). Use a larger value for long-running commands like package installs.',
        },
      },
      required: ['tool_title', 'command'],
      propertyOrdering: ['tool_title', 'shell', 'command', 'timeout'],
    },
    {
      name: 'file_read',
      description:
        'Read a file from the local filesystem. Returns file content with metadata. Rejects binary files. Faster than shell_execute for reading files. Paged reads end with a [Paged] trailer: the shown line range and the exact offset to continue from.',
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
          type: 'integer', minimum: 1,
          description: '1-based line number to start reading from (default: 1).',
        },
        lines: {
          type: 'integer', minimum: 1, maximum: 10000,
          description: 'Maximum number of lines to return (default: all lines up to max_length).',
        },
        max_length: {
          type: 'integer', minimum: 1, maximum: 200000,
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
        'Make targeted edits to an existing file using exact string replacement. ALWAYS use file_read first to see the current file contents before editing. Prefer file_edit over file_write when modifying existing files. The old_string must match exactly one location in the file (including whitespace/indentation), unless replace_all is true. The tool name is exactly file_edit (never edit).',
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
      name: 'grep',
      description:
        'Search file contents in the workspace with a regular expression (or literal text when fixed_strings is true). Returns matches as "path:line: text" and supports up to 3 context lines. Skips dependencies, build output, binaries and paths ignored by the workspace-root .gitignore. Prefer this over shell_execute for locating code, symbols or log lines: it is bounded, ranked deterministically and does not flood the context.',
      parameters: {
        tool_title: { type: 'string', description: "A concise 5-10 word summary (e.g. 'Find tool registration', 'Locate config reads')." },
        pattern: { type: 'string', description: 'Regular expression (JavaScript syntax) to match, or literal text when fixed_strings is true.' },
        path: { type: 'string', description: 'File or directory to search, relative to the workspace root (default: workspace root).' },
        glob: { type: 'string', description: "Only search files whose workspace-relative path matches this glob, e.g. '*.ts' or 'src/**/*.js'." },
        ignore_case: { type: 'boolean', description: 'Case-insensitive matching (default: false).' },
        fixed_strings: { type: 'boolean', description: 'Treat pattern as literal text instead of a regular expression (default: false).' },
        context_lines: { type: 'integer', minimum: 0, maximum: 3, description: 'Lines of context before and after each match (default: 0, max: 3).' },
        max_results: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum matching lines to return (default: 100, max: 500).' },
      },
      required: ['tool_title', 'pattern'],
      propertyOrdering: ['tool_title', 'pattern', 'path', 'glob', 'ignore_case', 'fixed_strings', 'context_lines', 'max_results'],
    },
    {
      name: 'glob',
      description:
        'List files in the workspace matching a glob pattern, newest first. Supports **, *, ? and {a,b}; returned paths are workspace-relative with "/" separators. Skips dependencies, build output and paths ignored by the workspace-root .gitignore. Use it to discover files before reading them.',
      parameters: {
        tool_title: { type: 'string', description: "A concise 5-10 word summary (e.g. 'List TypeScript tests', 'Find build scripts')." },
        pattern: { type: 'string', description: "Glob pattern matched against workspace-relative paths, e.g. 'src/**/*.ts' or '**/*.test.js'." },
        path: { type: 'string', description: 'Directory to search, relative to the workspace root (default: workspace root).' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum files to return (default: 200, max: 1000).' },
      },
      required: ['tool_title', 'pattern'],
      propertyOrdering: ['tool_title', 'pattern', 'path', 'limit'],
    },
    {
      name: 'web_search',
      description: 'Search the public web and return ranked titles, URLs, snippets, and source domains. Search first, then use browser_fetch on a selected complete URL. Never treat a blocked page as a failed search.',
      parameters: {
        tool_title: { type: 'string', description: 'Concise search purpose.' },
        query: { type: 'string', description: 'Natural-language web search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 12, description: 'Maximum results, default 8, maximum 12.' },
        recency_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Optional freshness window in days.' },
      }, required: ['tool_title', 'query'], propertyOrdering: ['tool_title', 'query', 'limit', 'recency_days'],
    },
    {
      name: 'browser_fetch',
      description:
        'Fetch content from a complete URL. Returns the page content as text (HTML converted to readable text). Use this to retrieve web pages, API responses, or download files. Never invent or truncate an article URL; if a request returns HTTP 404, verify the exact URL and search again for the complete resource ID.',
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
          type: 'integer', minimum: 1, maximum: 120000,
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
          type: 'integer', minimum: 1, maximum: 50,
          description: 'Maximum number of results to return (default: 20, max: 50).',
        },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title', 'keywords', 'limit'],
    });
  }

  tools.push(...sessionToolDefinitions(surface));
  return tools;
}

export function sessionToolDefinitions(surface: ToolSurfaceOptions = {}): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [];
  if (surface.shellSession) {
    tools.push({
      name: 'shell_session',
      description:
        'Persistent shell session for multi-step work: one long-lived shell whose cwd, environment variables and activated virtualenv survive between commands. Use shell_execute for a one-off command; use open once then send repeatedly when state must persist (cd through a repo, activate a venv, start a server). action=send waits for the command to finish and returns its exit code; a command that never returns leaves the session open, so use action=read for later output and action=close to stop it.',
      parameters: {
        tool_title: { type: 'string', description: "A concise 5-10 word summary (e.g. 'Open build shell', 'Run tests in session')." },
        action: { type: 'string', description: 'open creates a shell; send runs a command and waits; read drains output since the last call; close terminates; list shows this conversation\'s sessions.', enumValues: ['open', 'send', 'read', 'close', 'list'] },
        session_id: { type: 'string', description: 'Session id returned by action=open. Required for send / read / close.' },
        command: { type: 'string', description: 'Command text for action=send. Multi-line input is submitted line by line.' },
        shell: { type: 'string', description: 'Shell for action=open. auto picks PowerShell on Windows (or bash elsewhere).', enumValues: ['auto', 'cmd', 'powershell', 'bash', 'wsl'] },
        cwd: { type: 'string', description: 'Working directory for action=open. Relative paths resolve against the project root; defaults to the project root.' },
        timeout: { type: 'integer', minimum: 1, maximum: 900, description: 'Seconds to wait for the completion marker on send (default 120, max 900).' },
      },
      required: ['tool_title', 'action'],
      propertyOrdering: ['tool_title', 'action', 'session_id', 'command', 'shell', 'cwd', 'timeout'],
    });
  }
  if (surface.jobs) {
    tools.push({
      name: 'job_list',
      description:
        'List recent jobs of this conversation (every tool call and turn) with job id, tool, status, duration and a short preview. Use it to find the id for job_output, especially after an earlier tool result was compacted out of the context.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'List recent jobs')." },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum rows to return (default 12, max 50).' },
        tool: { type: 'string', description: 'Only jobs whose tool name contains this text.' },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title', 'limit', 'tool'],
    });
    tools.push({
      name: 'job_output',
      description:
        'Return the full output recorded for an earlier tool call or turn in this conversation. Accepts a job id from job_list or the tool_call_id visible in the transcript. Use it when a previous result was truncated, compacted, or the call was interrupted before you read it.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'Recover build log')." },
        job_id: { type: 'string', description: 'Job id from job_list, or the tool_call_id of the call.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start from (default 0).' },
        max_length: { type: 'integer', minimum: 1, maximum: 120000, description: 'Maximum characters to return (default 20000).' },
      },
      required: ['tool_title', 'job_id'],
      propertyOrdering: ['tool_title', 'job_id', 'offset', 'max_length'],
    });
  }
  if (surface.goal) {
    tools.push({
      name: 'goal',
      description:
        'Maintain the durable objective of this conversation. The goal is re-injected into every turn and survives context compaction and restarts, so long multi-step tasks keep their destination after older turns are summarized away. Set it once the task is clear, append a progress note at milestones, and mark it done when finished.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'Record task objective', 'Mark goal done')." },
        action: { type: 'string', description: 'set replaces the objective; update appends a note or changes status; get prints the current goal; clear removes it.', enumValues: ['set', 'update', 'get', 'clear'] },
        objective: { type: 'string', description: 'What the user ultimately wants, in one or two sentences. Required for action=set.' },
        done_when: { type: 'string', description: 'Observable completion criteria (tests green, build artifact present, user confirmed).' },
        status: { type: 'string', description: 'Goal status for action=update.', enumValues: ['active', 'done', 'blocked'] },
        note: { type: 'string', description: 'Progress note appended for action=update (kept to the most recent 12).' },
      },
      required: ['tool_title', 'action'],
      propertyOrdering: ['tool_title', 'action', 'objective', 'done_when', 'status', 'note'],
    });
  }
  if (surface.bots) {
    tools.push({
      name: 'bot_list',
      description:
        'List the Bots the user has created in this workspace: name, id, model and which tools each is allowed to use. Read this before creating or deleting one so names are not guessed.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'List Bots', 'Check Bot roster')." },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title'],
    });
    tools.push({
      name: 'bot_create',
      description:
        'Create a Bot: a separate agent with its own name, persona, long-term memory file and model. Use it when the user asks for a dedicated assistant for a recurring job. The tools granted to the new Bot must be a subset of the tools you can use yourself. Do not create one to work around a permission you were refused.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'Create research Bot')." },
        name: { type: 'string', description: 'Display name, up to 80 characters. Must be unique.' },
        description: { type: 'string', description: 'One line describing what this Bot is for, up to 600 characters.' },
        persona: { type: 'string', description: 'The Bot identity and response style, up to 12000 characters. This becomes part of that Bot system prompt.' },
        memory: { type: 'string', description: 'Explicit long-term notes for this Bot, up to 16000 characters. Leave empty unless the user supplied facts worth keeping.' },
        profileId: { type: 'string', description: 'Model profile for the Bot. Omit to reuse the model of the current conversation.' },
        allowedTools: {
          type: 'array',
          description: 'Tool names this Bot may call. Each must already be available to you. Omit for a chat-only Bot with no tools.',
          items: { type: 'string', description: 'A tool name, e.g. file_read.' },
        },
      },
      required: ['tool_title', 'name'],
      propertyOrdering: ['tool_title', 'name', 'description', 'persona', 'memory', 'profileId', 'allowedTools'],
    });
    tools.push({
      name: 'bot_delete',
      description:
        'Delete a Bot by id or by exact name. Chat history under that Bot is kept and stays readable; only the Bot configuration and its memory directory are removed. Always requires confirm: true.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'Delete research Bot')." },
        botId: { type: 'string', description: 'Bot id from bot_list. Preferred over name.' },
        name: { type: 'string', description: 'Exact Bot name, used only when botId is omitted.' },
        confirm: { type: 'boolean', description: 'Must be true. Without it the call returns a description of what would be deleted.' },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title', 'botId', 'name', 'confirm'],
    });
  }
  if (surface.scheduledTasks) {
    tools.push({
      name: 'schedule_list',
      description:
        'List scheduled tasks: title, id, when they run, whether they are enabled, and the outcome of the last run. Read this before creating or changing one.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'List scheduled tasks')." },
      },
      required: ['tool_title'],
      propertyOrdering: ['tool_title'],
    });
    tools.push({
      name: 'schedule_create',
      description:
        'Create a scheduled task: a prompt that will be sent to a model automatically at a fixed local time. The task is created DISABLED on purpose, because it runs later with nobody reviewing it; tell the user to enable it, or call schedule_manage with action=enable after they agree. Never schedule something that writes, deletes or sends without the user saying so explicitly.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'Schedule daily digest')." },
        prompt: { type: 'string', description: 'The prompt to send at run time, up to 20000 characters. Write it self-contained: the run has no access to this conversation.' },
        title: { type: 'string', description: 'Short label shown in the list, up to 80 characters. Derived from the prompt when omitted.' },
        profileId: { type: 'string', description: 'Model profile for the run. Omit to reuse the model of the current conversation.' },
        sessionMode: { type: 'string', description: 'new opens a fresh conversation per run; existing appends to one session.', enumValues: ['new', 'existing'] },
        sessionId: { type: 'string', description: 'Target session when sessionMode=existing. Omit to reuse the current conversation.' },
        schedule: {
          type: 'object',
          description: 'When it runs. Times are local wall clock.',
          properties: {
            frequency: { type: 'string', description: 'daily, weekly or monthly.', enumValues: ['daily', 'weekly', 'monthly'] },
            time: { type: 'string', description: 'HH:mm, 24-hour local time, e.g. 09:30.' },
            weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0=Sunday … 6=Saturday. Required when frequency=weekly.' },
            dayOfMonth: { type: 'integer', minimum: 1, maximum: 31, description: 'Day of month. Required when frequency=monthly.' },
          },
          required: ['frequency', 'time'],
        },
      },
      required: ['tool_title', 'prompt', 'schedule'],
      propertyOrdering: ['tool_title', 'prompt', 'title', 'profileId', 'sessionMode', 'sessionId', 'schedule'],
    });
    tools.push({
      name: 'schedule_manage',
      description:
        'Enable, disable or delete a scheduled task. Every action requires confirm: true so an unattended prompt is never switched on by accident.',
      parameters: {
        tool_title: { type: 'string', description: "A concise summary (e.g. 'Enable daily digest')." },
        taskId: { type: 'string', description: 'Task id from schedule_list.' },
        action: { type: 'string', description: 'enable, disable or delete.', enumValues: ['enable', 'disable', 'delete'] },
        confirm: { type: 'boolean', description: 'Must be true. Without it the call only describes what would happen.' },
      },
      required: ['tool_title', 'taskId', 'action'],
      propertyOrdering: ['tool_title', 'taskId', 'action', 'confirm'],
    });
  }
  return tools;
}
