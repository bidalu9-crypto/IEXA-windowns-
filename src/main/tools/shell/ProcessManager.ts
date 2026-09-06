import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutionResult } from '../../providers/types';
import { IexaError } from '../../errors/IexaError';

export interface ProcessPolicy { timeoutMs: number; maxOutputBytes: number; killGracePeriodMs: number; }

type TerminationReason = 'cancelled' | 'timeout' | 'output-limit';

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
      let outputBytes = 0; let settled = false;
      let terminationReason: TerminationReason | undefined;
      let terminationPromise: Promise<void> | undefined;
      let forceFinishTimer: ReturnType<typeof setTimeout> | undefined;

      const collectedOutput = (): string => [
        decodeOutput(Buffer.concat(stdoutChunks)),
        decodeOutput(Buffer.concat(stderrChunks)),
      ].filter(Boolean).join('\n').trim() || '(no output)';
      const boundedOutput = (): string => truncateUtf8(collectedOutput(), policy.maxOutputBytes);
      const terminatedResult = (reason: TerminationReason): ToolExecutionResult => ({
        output: reason === 'cancelled'
          ? 'Command cancelled.'
          : boundedOutput(),
        success: false,
        exitCode: -1,
        timedOut: reason === 'timeout',
      });
      const finish = (result: ToolExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceFinishTimer) clearTimeout(forceFinishTimer);
        signal.removeEventListener('abort', abort);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
        child.stdout?.destroy();
        child.stderr?.destroy();
        void Promise.resolve(terminationPromise)
          .catch(() => {})
          .then(() => launch.cleanup?.())
          .catch(() => {})
          .finally(() => resolve(result));
      };
      const append = (value: Buffer, target: 'stdout' | 'stderr') => {
        if (terminationReason) return;
        const remaining = policy.maxOutputBytes - outputBytes;
        if (remaining > 0) {
          const kept = value.subarray(0, remaining);
          (target === 'stdout' ? stdoutChunks : stderrChunks).push(kept);
          outputBytes += kept.length;
        }
        if (outputBytes >= policy.maxOutputBytes) terminate('output-limit');
      };
      const terminate = (reason: TerminationReason) => {
        if (terminationReason || settled) return;
        terminationReason = reason;
        // Stop consuming an unbounded producer immediately. More data events
        // must not launch another taskkill process for every output chunk.
        child.stdout?.pause();
        child.stderr?.pause();
        terminationPromise = terminateProcessTree(child, policy.killGracePeriodMs);
        forceFinishTimer = setTimeout(
          () => finish(terminatedResult(reason)),
          Math.max(50, policy.killGracePeriodMs),
        );
      };
      const abort = () => terminate('cancelled');
      const timer = setTimeout(() => {
        terminate('timeout');
      }, policy.timeoutMs);
      const onStdout = (chunk: Buffer) => append(chunk, 'stdout');
      const onStderr = (chunk: Buffer) => append(chunk, 'stderr');
      const onError = (error: Error) => finish(terminationReason
        ? terminatedResult(terminationReason)
        : { output: `Command execution error: ${error.message}`, success: false, exitCode: -1 });
      const onClose = (code: number | null) => finish(terminationReason
        ? terminatedResult(terminationReason)
        : { output: boundedOutput(), success: code === 0, exitCode: code ?? -1, timedOut: false });
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async launch(command: string, cwd: string): Promise<ProcessLaunch> {
    if (!fsSync.existsSync(cwd) || !fsSync.statSync(cwd).isDirectory()) {
      throw new Error(`Command working directory does not exist: ${cwd}`);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' };
    if (process.platform !== 'win32') {
      return { child: spawn('/bin/sh', ['-lc', command], { cwd, env, windowsHide: true, detached: true }) };
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

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  return encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

/** Terminate exactly one process tree and wait for the cleanup helper. */
function terminateProcessTree(child: ChildProcess, gracePeriodMs: number): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    let killer: ChildProcess | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child.exitCode === null) child.kill(); } catch {}
      resolve();
    };
    const timer = setTimeout(() => {
      try { killer?.kill(); } catch {}
      finish();
    }, Math.max(250, Math.min(2000, gracePeriodMs)));
    try {
      killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', finish);
      killer.once('close', finish);
    } catch {
      finish();
    }
  });
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
