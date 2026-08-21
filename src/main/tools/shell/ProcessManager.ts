import { spawn, ChildProcess } from 'child_process';
import * as iconv from 'iconv-lite';
import { ToolExecutionResult } from '../../providers/types';
import { IexaError } from '../../errors/IexaError';

export interface ProcessPolicy { timeoutMs: number; maxOutputBytes: number; killGracePeriodMs: number; }
export class ProcessManager {
  async run(command: string, cwd: string, signal: AbortSignal, policy: ProcessPolicy): Promise<ToolExecutionResult> {
    return new Promise((resolve) => {
      const env = { ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' };
      // Passing a command containing quotes as the final argument to cmd.exe
      // makes Node escape those quotes on Windows. CMD then passes literal
      // backslashes/quotes to child tools, breaking paths such as
      // `dir "C:\\Program Files"` and PowerShell's `-Command "..."` form.
      // Let Node invoke the complete command through ComSpec instead, so the
      // command string reaches CMD with its original quote structure intact.
      const child = process.platform === 'win32'
        ? spawn(command, { cwd, env, shell: process.env.ComSpec || 'cmd.exe', windowsHide: true })
        : spawn('/bin/sh', ['-lc', command], { cwd, env, windowsHide: true });
      const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = []; let outputBytes = 0; let settled = false; let timedOut = false;
      const finish = (result: ToolExecutionResult) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(result); };
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
}

function decodeOutput(value: Buffer): string {
  const utf8 = value.toString('utf8');
  // cmd.exe follows the active Windows console code page (commonly CP936 on
  // Chinese systems); UTF-8 subprocesses remain untouched when valid.
  return process.platform === 'win32' && utf8.includes('\uFFFD') ? iconv.decode(value, 'cp936') : utf8;
}
