import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutionResult } from '../../providers/types';
import { IexaError } from '../../errors/IexaError';

export interface ProcessPolicy { timeoutMs: number; maxOutputBytes: number; killGracePeriodMs: number; }

const POWERSHELL_UTF8_PREAMBLE = [
  "$utf8 = [System.Text.UTF8Encoding]::new($false)",
  '[Console]::InputEncoding = $utf8',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  // Windows PowerShell 5.1 treats UTF-8 files without a BOM as ANSI unless
  // the encoding is supplied. Source files created by modern editors are
  // normally UTF-8 without a BOM, so make that the default for Get-Content.
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'",
].join('; ');

interface ProcessLaunch {
  child: ChildProcess;
  cleanup?: () => Promise<void>;
}

export class ProcessManager {
  async run(command: string, cwd: string, signal: AbortSignal, policy: ProcessPolicy): Promise<ToolExecutionResult> {
    let launch: ProcessLaunch;
    try {
      launch = await this.launch(command, cwd);
    } catch (error) {
      return {
        output: `Command execution error: ${(error as Error).message}`,
        success: false,
        exitCode: -1,
      };
    }

    return new Promise((resolve) => {
      const { child } = launch;
      const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = [];
      let outputBytes = 0; let settled = false; let timedOut = false;
      let timeoutFinishTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: ToolExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timeoutFinishTimer) clearTimeout(timeoutFinishTimer);
        signal.removeEventListener('abort', abort);
        void (launch.cleanup?.() ?? Promise.resolve()).finally(() => resolve(result));
      };
      const append = (value: Buffer, target: 'stdout' | 'stderr') => {
        const remaining = policy.maxOutputBytes - outputBytes;
        if (remaining > 0) {
          const kept = value.subarray(0, remaining);
          (target === 'stdout' ? stdoutChunks : stderrChunks).push(kept);
          outputBytes += kept.length;
        }
        if (outputBytes >= policy.maxOutputBytes) kill();
      };
      const kill = () => {
        if (child.pid && process.platform === 'win32') {
          // taskkill is asynchronous and a child can keep the shell open even
          // after the kill request succeeds. Also ask Node to terminate the
          // direct process; the forced settle timer below prevents a stuck
          // close event from blocking the agent forever.
          try { child.kill(); } catch { /* process may already have exited */ }
          try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch { /* best effort */ }
        } else {
          try { child.kill('SIGTERM'); } catch { /* process may already have exited */ }
        }
      };
      const abort = () => { kill(); finish({ output: 'Command cancelled.', success: false, exitCode: -1, timedOut: false }); };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
        // Do not wait indefinitely for a misbehaving shell/GUI child to emit
        // `close`. Preserve any output received so far and report a normal
        // timeout result after the configured grace period.
        timeoutFinishTimer = setTimeout(() => {
          const output = [decodeOutput(Buffer.concat(stdoutChunks)), decodeOutput(Buffer.concat(stderrChunks))]
            .filter(Boolean).join('\n').trim() || '(no output)';
          finish({ output, success: false, exitCode: -1, timedOut: true });
        }, Math.max(0, policy.killGracePeriodMs));
      }, policy.timeoutMs);
      child.stdout?.on('data', (chunk) => append(chunk, 'stdout')); child.stderr?.on('data', (chunk) => append(chunk, 'stderr'));
      child.on('error', (error) => finish({ output: `Command execution error: ${error.message}`, success: false, exitCode: -1 }));
      child.on('close', (code) => {
        const output = [decodeOutput(Buffer.concat(stdoutChunks)), decodeOutput(Buffer.concat(stderrChunks))].filter(Boolean).join('\n').trim() || '(no output)';
        finish({ output, success: !timedOut && code === 0, exitCode: code ?? -1, timedOut });
      });
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async launch(command: string, cwd: string): Promise<ProcessLaunch> {
    if (!fsSync.existsSync(cwd) || !fsSync.statSync(cwd).isDirectory()) {
      throw new Error(`Command working directory does not exist: ${cwd}`);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' };
    if (process.platform !== 'win32') {
      return { child: spawn('/bin/sh', ['-lc', command], { cwd, env, windowsHide: true }) };
    }
    // Electron sometimes inherits a stale/rewritten ComSpec value (or a PATH
    // that cannot resolve it). Resolving the executable ourselves prevents all
    // shell commands from failing with `spawn ...cmd.exe ENOENT` in that case.
    const cmdExecutable = resolveWindowsCmdExecutable();
    env.ComSpec = cmdExecutable;
    env.COMSPEC = cmdExecutable;

    // cmd.exe executes only the first physical line supplied through /c.  Use a
    // short-lived batch file for true multi-line input so command blocks,
    // conditionals and one-command-per-line snippets retain CMD semantics.
    if (/\r|\n/.test(command)) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iexa-cmd-'));
      const scriptPath = path.join(tempDir, 'command.cmd');
      const pythonSource = extractMultilinePythonInlineSource(command);
      try {
        let batchCommand = normalizeCmdNewlines(command);
        if (pythonSource) {
          const pythonScriptPath = path.join(tempDir, 'inline-python.py');
          // A Python -c body with physical newlines cannot survive CMD parsing:
          // after the first line CMD treats the remaining Python statements as
          // commands. Materialize only that body as a short-lived script while
          // leaving an optional CMD prefix/suffix (for example `chcp &&`) intact.
          await fs.writeFile(pythonScriptPath, pythonSource.source, 'utf8');
          batchCommand = `${pythonSource.prefix}${pythonSource.executable} "${pythonScriptPath}"${pythonSource.suffix}`;
        }
        // No UTF-8 BOM: CMD treats it as part of the first token.  The command
        // prefix supplied by ShellExecutor switches to UTF-8 before user input.
        await fs.writeFile(scriptPath, `@echo off\r\n${batchCommand}\r\n`, 'utf8');
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      }

      return {
        // Pass the script path as the command argument rather than constructing
        // `call "..."`.  Node quotes a single argv item that contains embedded
        // quotes when it builds the Windows command line; CMD then sees those
        // quotes literally and tries to execute a command whose name includes
        // quote characters.  CMD's /c accepts a batch-file path directly and
        // preserves the batch file's final errorlevel.
        child: spawn(cmdExecutable, ['/d', '/c', scriptPath], {
          cwd,
          env,
          windowsHide: true,
        }),
        cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
      };
    }

    // PowerShell's nested `-Command "..."` quoting is fragile when it passes
    // through Node's extra CMD shell layer. Detect only a top-level PowerShell
    // invocation and pass its script as a dedicated argv item; ordinary CMD
    // commands keep the existing shell behavior and quoting semantics.
    const powershell = parsePowerShellCommand(command);
    if (powershell) {
      // Windows PowerShell can reject a restricted temp directory when Node
      // assigns it as the process cwd. Start from the inherited cwd and move
      // inside PowerShell instead; this preserves command semantics while
      // avoiding the startup-time access check.
      const escapedCwd = cwd.replace(/'/g, "''");
      const scriptIndex = powershell.args.length - 1;
      powershell.args[scriptIndex] = `${POWERSHELL_UTF8_PREAMBLE}; Set-Location -LiteralPath '${escapedCwd}'; ${powershell.args[scriptIndex]}`;
      return { child: spawn(powershell.executable, powershell.args, { env, windowsHide: true }) };
    }

    return {
      child: spawn(command, { cwd, env, shell: cmdExecutable, windowsHide: true }),
    };
  }
}

/** Locate a real cmd.exe instead of trusting a possibly stale ComSpec value. */
function resolveWindowsCmdExecutable(): string {
  const candidates = [
    process.env.ComSpec,
    process.env.COMSPEC,
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : undefined,
    process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'cmd.exe') : undefined,
    'C:\\Windows\\System32\\cmd.exe',
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
  const executable = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!executable) {
    throw new Error(`Windows command processor not found. Checked: ${candidates.join(', ')}`);
  }
  return executable;
}

function parsePowerShellCommand(command: string): { executable: string; args: string[] } | null {
  const match = /^\s*(powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+([\s\S]+)$/i.exec(command);
  if (!match) return null;
  const rest = match[2];
  const commandMatch = /(?:^|\s)(-command|-c)\s+([\s\S]+)$/i.exec(rest);
  if (!commandMatch) return null;
  const prefix = rest.slice(0, commandMatch.index).trim();
  const prefixArgs = prefix.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g)?.map((arg) => {
    return arg.length >= 2 && ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'")))
      ? arg.slice(1, -1)
      : arg;
  }) || [];
  let script = commandMatch[2].trim();
  if (script.length >= 2 && script.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1);
  return { executable: match[1], args: [...prefixArgs, '-Command', script] };
}

function normalizeCmdNewlines(command: string): string {
  return command.replace(/\r\n|\r|\n/g, '\r\n');
}

interface MultilinePythonInlineSource {
  prefix: string;
  executable: string;
  source: string;
  suffix: string;
}

/**
 * Extract `python -c "...multiline source..."` from a CMD command. The
 * optional prefix preserves wrappers such as `chcp 65001 >nul &&`; arguments
 * after the source remain attached to the generated script invocation.
 */
function extractMultilinePythonInlineSource(command: string): MultilinePythonInlineSource | null {
  const match = /^([\s\S]*?\b)((?:python(?:\d(?:\.\d+)?)?|py)(?:\.exe)?)\s+(?:-c|\/c)\s+(["'])([\s\S]*)\3([\s\S]*)$/i.exec(command);
  if (!match || !/[\r\n]/.test(match[4])) return null;
  return {
    prefix: match[1],
    executable: match[2],
    source: match[4].replace(/^\r?\n/, ''),
    suffix: match[5],
  };
}

function decodeOutput(value: Buffer): string {
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
    return value.subarray(2).toString('utf16le');
  }
  if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
    return iconv.decode(value.subarray(2), 'utf16-be');
  }
  if (looksLikeUtf16(value)) {
    return iconv.decode(value, value[0] === 0 ? 'utf16-be' : 'utf16le');
  }
  const utf8 = value.toString('utf8');
  // cmd.exe follows the active Windows console code page (commonly CP936 on
  // Chinese systems); UTF-8 subprocesses remain untouched when valid.
  return process.platform === 'win32' && utf8.includes('\uFFFD') ? iconv.decode(value, 'cp936') : utf8;
}

/** Detect BOM-less UTF-16 by the NUL-byte distribution in its first bytes. */
function looksLikeUtf16(value: Buffer): boolean {
  const sampleLength = Math.min(value.length - (value.length % 2), 512);
  if (sampleLength < 4) return false;
  let evenNulls = 0;
  let oddNulls = 0;
  for (let i = 0; i < sampleLength; i += 2) {
    if (value[i] === 0) evenNulls++;
    if (value[i + 1] === 0) oddNulls++;
  }
  const pairs = sampleLength / 2;
  return (evenNulls / pairs > 0.3 && oddNulls / pairs < 0.05)
    || (oddNulls / pairs > 0.3 && evenNulls / pairs < 0.05);
}
