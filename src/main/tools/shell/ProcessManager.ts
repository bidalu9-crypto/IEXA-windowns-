import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as iconv from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutionResult } from '../../providers/types';
import { IexaError } from '../../errors/IexaError';

export interface ProcessPolicy { timeoutMs: number; maxOutputBytes: number; killGracePeriodMs: number; }

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
      const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = []; let outputBytes = 0; let settled = false; let timedOut = false;
      const finish = (result: ToolExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
      const kill = () => { if (child.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); else child.kill('SIGTERM'); };
      const abort = () => { kill(); finish({ output: 'Command cancelled.', success: false, exitCode: -1, timedOut: false }); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, policy.timeoutMs);
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
    const env = { ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' };
    if (process.platform !== 'win32') {
      return { child: spawn('/bin/sh', ['-lc', command], { cwd, env, windowsHide: true }) };
    }

    // cmd.exe executes only the first physical line supplied through /c.  Use a
    // short-lived batch file for true multi-line input so command blocks,
    // conditionals and one-command-per-line snippets retain CMD semantics.
    if (/\r|\n/.test(command)) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iexa-cmd-'));
      const scriptPath = path.join(tempDir, 'command.cmd');
      try {
        // No UTF-8 BOM: CMD treats it as part of the first token.  The command
        // prefix supplied by ShellExecutor switches to UTF-8 before user input.
        await fs.writeFile(scriptPath, `@echo off\r\n${normalizeCmdNewlines(command)}\r\n`, 'utf8');
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
        child: spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', scriptPath], {
          cwd,
          env,
          windowsHide: true,
        }),
        cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
      };
    }

    // Passing a command containing quotes as the final argument to cmd.exe
    // makes Node escape those quotes on Windows. CMD then passes literal
    // backslashes/quotes to child tools, breaking paths such as
    // `dir "C:\\Program Files"` and PowerShell's `-Command "..."` form.
    // Let Node invoke the complete command through ComSpec instead, so the
    // command string reaches CMD with its original quote structure intact.
    return {
      child: spawn(command, { cwd, env, shell: process.env.ComSpec || 'cmd.exe', windowsHide: true }),
    };
  }
}

function normalizeCmdNewlines(command: string): string {
  return command.replace(/\r\n|\r|\n/g, '\r\n');
}

function decodeOutput(value: Buffer): string {
  const utf8 = value.toString('utf8');
  // cmd.exe follows the active Windows console code page (commonly CP936 on
  // Chinese systems); UTF-8 subprocesses remain untouched when valid.
  return process.platform === 'win32' && utf8.includes('\uFFFD') ? iconv.decode(value, 'cp936') : utf8;
}
