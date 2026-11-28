"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessManager = void 0;
exports.terminateProcessTree = terminateProcessTree;
const DiagnosticDecoder_1 = require("../../encoding/DiagnosticDecoder");
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const fsSync = __importStar(require("fs"));
const iconv = __importStar(require("iconv-lite"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const AbortWait_1 = require("../../runtime/AbortWait");
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
class ProcessManager {
    async run(command, cwd, signal, policy, shell = 'auto') {
        if (signal.aborted)
            return { output: 'Command cancelled.', success: false, exitCode: -1, cancelled: true };
        let launch;
        try {
            launch = await this.launch(command, cwd, shell, signal);
        }
        catch (error) {
            if (signal.aborted)
                return { output: 'Command cancelled.', success: false, exitCode: -1, cancelled: true };
            return {
                output: `Command execution error: ${error.message}`,
                success: false,
                exitCode: -1,
            };
        }
        return new Promise((resolve) => {
            const { child } = launch;
            const stdoutChunks = [];
            const stderrChunks = [];
            let outputBytes = 0;
            let settled = false;
            let terminationReason;
            let terminationPromise;
            let forceFinishTimer;
            const collectedOutput = () => [
                decodeOutput(Buffer.concat(stdoutChunks)),
                decodeOutput(Buffer.concat(stderrChunks)),
            ].filter(Boolean).join('\n').trim() || '(no output)';
            const boundedOutput = () => truncateUtf8(collectedOutput(), policy.maxOutputBytes);
            const terminatedResult = (reason) => ({
                output: reason === 'cancelled'
                    ? 'Command cancelled.'
                    : boundedOutput(),
                success: false,
                exitCode: -1,
                timedOut: reason === 'timeout',
            });
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (forceFinishTimer)
                    clearTimeout(forceFinishTimer);
                signal.removeEventListener('abort', abort);
                child.stdout?.off('data', onStdout);
                child.stderr?.off('data', onStderr);
                child.off('error', onError);
                child.off('close', onClose);
                child.stdout?.destroy();
                child.stderr?.destroy();
                void (0, AbortWait_1.settleWithin)(Promise.resolve(terminationPromise).then(() => launch.cleanup?.()), Math.max(250, Math.min(2500, policy.killGracePeriodMs + 250))).finally(() => resolve(result));
            };
            const append = (value, target) => {
                if (terminationReason)
                    return;
                const remaining = policy.maxOutputBytes - outputBytes;
                if (remaining > 0) {
                    const kept = value.subarray(0, remaining);
                    (target === 'stdout' ? stdoutChunks : stderrChunks).push(kept);
                    outputBytes += kept.length;
                }
                if (outputBytes >= policy.maxOutputBytes)
                    terminate('output-limit');
            };
            const terminate = (reason) => {
                if (terminationReason || settled)
                    return;
                terminationReason = reason;
                // Stop consuming an unbounded producer immediately. More data events
                // must not launch another taskkill process for every output chunk.
                child.stdout?.pause();
                child.stderr?.pause();
                terminationPromise = terminateProcessTree(child, policy.killGracePeriodMs);
                forceFinishTimer = setTimeout(() => finish(terminatedResult(reason)), Math.max(50, policy.killGracePeriodMs));
            };
            const abort = () => terminate('cancelled');
            const timer = setTimeout(() => {
                terminate('timeout');
            }, policy.timeoutMs);
            const onStdout = (chunk) => append(chunk, 'stdout');
            const onStderr = (chunk) => append(chunk, 'stderr');
            const onError = (error) => finish(terminationReason
                ? terminatedResult(terminationReason)
                : { output: `Command execution error: ${error.message}`, success: false, exitCode: -1 });
            const onClose = (code) => finish(terminationReason
                ? terminatedResult(terminationReason)
                : { output: boundedOutput(), success: code === 0, exitCode: code ?? -1, timedOut: false });
            child.stdout?.on('data', onStdout);
            child.stderr?.on('data', onStderr);
            child.on('error', onError);
            child.on('close', onClose);
            if (signal.aborted)
                abort();
            else
                signal.addEventListener('abort', abort, { once: true });
        });
    }
    async launch(command, cwd, shell, signal) {
        signal.throwIfAborted();
        if (!fsSync.existsSync(cwd) || !fsSync.statSync(cwd).isDirectory()) {
            throw new Error(`Command working directory does not exist: ${cwd}`);
        }
        const env = { ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' };
        if (process.platform !== 'win32') {
            return { child: (0, child_process_1.spawn)('/bin/sh', ['-lc', command], { cwd, env, windowsHide: true, detached: true }) };
        }
        // Electron sometimes inherits a stale/rewritten ComSpec value (or a PATH
        // that cannot resolve it). Resolving the executable ourselves prevents all
        // shell commands from failing with `spawn ...cmd.exe ENOENT` in that case.
        const cmdExecutable = resolveWindowsCmdExecutable();
        env.ComSpec = cmdExecutable;
        env.COMSPEC = cmdExecutable;
        const legacyPowerShell = shell === 'auto' ? parsePowerShellCommand(command) : null;
        if (shell === 'powershell' || shell === 'pwsh' || legacyPowerShell) {
            return createPowerShellLaunch(legacyPowerShell?.script ?? command, cwd, env, shell === 'pwsh' || legacyPowerShell?.executable.toLowerCase().startsWith('pwsh') ? 'pwsh.exe' : 'powershell.exe', signal);
        }
        // Materializing CMD input removes Node -> cmd.exe command-line quoting from
        // the equation. It also makes single-line and multi-line calls behave the
        // same for %, !, ^, &, pipes, parentheses and nested quotes.
        return createCmdLaunch(command, cwd, env, cmdExecutable, signal);
    }
}
exports.ProcessManager = ProcessManager;
async function createCmdLaunch(command, cwd, env, executable, signal) {
    const tempDir = await fs_1.promises.mkdtemp(path.join(os.tmpdir(), 'iexa-cmd-'));
    const scriptPath = path.join(tempDir, 'command.cmd');
    const pythonSource = extractMultilinePythonInlineSource(command);
    try {
        let batchCommand = normalizeCmdNewlines(command);
        if (pythonSource) {
            const pythonScriptPath = path.join(tempDir, 'inline-python.py');
            await fs_1.promises.writeFile(pythonScriptPath, pythonSource.source, 'utf8');
            batchCommand = `${pythonSource.prefix}${pythonSource.executable} "${pythonScriptPath}"${pythonSource.suffix}`;
        }
        await fs_1.promises.writeFile(scriptPath, `@echo off\r\n@chcp 65001 >nul\r\n${batchCommand}\r\n`, 'utf8');
        // File creation is asynchronous. Stop may have arrived while materializing
        // the command, before there is any child to receive the abort listener.
        signal.throwIfAborted();
    }
    catch (error) {
        await fs_1.promises.rm(tempDir, { recursive: true, force: true });
        throw error;
    }
    return {
        child: (0, child_process_1.spawn)(executable, ['/d', '/q', '/c', scriptPath], { cwd, env, windowsHide: true }),
        cleanup: () => fs_1.promises.rm(tempDir, { recursive: true, force: true }),
    };
}
async function createPowerShellLaunch(script, cwd, env, executable, signal) {
    const tempDir = await fs_1.promises.mkdtemp(path.join(os.tmpdir(), 'iexa-ps-'));
    const scriptPath = path.join(tempDir, 'command.ps1');
    const escapedCwd = cwd.replace(/'/g, "''");
    const source = `${POWERSHELL_UTF8_PREAMBLE}\r\nSet-Location -LiteralPath '${escapedCwd}'\r\n${script}\r\n`;
    try {
        // Windows PowerShell 5.1 needs a BOM to decode non-ASCII script source as UTF-8.
        await fs_1.promises.writeFile(scriptPath, `\uFEFF${source}`, 'utf8');
        signal.throwIfAborted();
    }
    catch (error) {
        await fs_1.promises.rm(tempDir, { recursive: true, force: true });
        throw error;
    }
    return {
        child: (0, child_process_1.spawn)(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            env,
            windowsHide: true,
        }),
        cleanup: () => fs_1.promises.rm(tempDir, { recursive: true, force: true }),
    };
}
function truncateUtf8(value, maxBytes) {
    const encoded = Buffer.from(value, 'utf8');
    if (encoded.length <= maxBytes)
        return value;
    return encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}
/**
 * Terminate exactly one process tree and wait for the cleanup helper.
 *
 * libuv resolves a bare executable name through PATH, and it throws
 * synchronously (`spawn UNKNOWN`) when the resolved file cannot be executed —
 * it never emits an asynchronous `error`. A rewritten or shadowed PATH
 * (Electron inherits one from its launcher) therefore used to skip taskkill
 * entirely: the catch block resolved at once, only the direct child was killed,
 * and the command's real work kept running while the caller was told it had
 * been cancelled. Retry with the absolute system path; only when no candidate
 * can start does the direct-child fallback stand.
 */
function terminateProcessTree(child, gracePeriodMs) {
    if (!child.pid)
        return Promise.resolve();
    if (process.platform !== 'win32') {
        try {
            process.kill(-child.pid, 'SIGTERM');
        }
        catch {
            try {
                child.kill('SIGTERM');
            }
            catch { }
        }
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let done = false;
        let killer;
        const finish = () => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            try {
                if (child.exitCode === null)
                    child.kill();
            }
            catch { }
            resolve();
        };
        const timer = setTimeout(() => {
            try {
                killer?.kill();
            }
            catch { }
            finish();
        }, Math.max(250, Math.min(2000, gracePeriodMs)));
        const candidates = taskkillCandidates();
        const attempt = (index) => {
            if (done)
                return;
            const executable = candidates[index];
            // Every candidate failed to start: kill what we own and stop waiting.
            if (!executable) {
                finish();
                return;
            }
            try {
                const started = (0, child_process_1.spawn)(executable, ['/pid', String(child.pid), '/t', '/f'], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer = started;
                let advanced = false;
                const retry = () => {
                    if (advanced || done)
                        return;
                    advanced = true;
                    try {
                        started.kill();
                    }
                    catch { }
                    attempt(index + 1);
                };
                started.once('error', retry);
                // A failed attempt also emits 'close'; it must not end the wait while a
                // retry is in flight.
                started.once('close', code => { if (!advanced) {
                    if (code === 0)
                        finish();
                    else
                        retry();
                } });
            }
            catch {
                // Synchronous spawn failure: try the next candidate.
                attempt(index + 1);
            }
        };
        attempt(0);
    });
}
/**
 * The bare name keeps the historical lookup order (and stays shadowable, which
 * is how the retry is exercised); the absolute paths are the candidate that
 * survives a rewritten PATH.
 */
function taskkillCandidates() {
    const absolute = [
        process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : undefined,
        process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'taskkill.exe') : undefined,
        'C:\\Windows\\System32\\taskkill.exe',
    ].filter((candidate) => Boolean(candidate && candidate.trim()));
    return ['taskkill.exe', ...absolute];
}
/** Locate a real cmd.exe instead of trusting a possibly stale ComSpec value. */
function resolveWindowsCmdExecutable() {
    const candidates = [
        process.env.ComSpec,
        process.env.COMSPEC,
        process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : undefined,
        process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'cmd.exe') : undefined,
        'C:\\Windows\\System32\\cmd.exe',
    ].filter((candidate) => Boolean(candidate && candidate.trim()));
    const executable = candidates.find((candidate) => fsSync.existsSync(candidate));
    if (!executable) {
        throw new Error(`Windows command processor not found. Checked: ${candidates.join(', ')}`);
    }
    return executable;
}
function parsePowerShellCommand(command) {
    const match = /^\s*(powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+([\s\S]+)$/i.exec(command);
    if (!match)
        return null;
    const rest = match[2];
    const commandMatch = /(?:^|\s)(?:-command|-c)\s+([\s\S]+)$/i.exec(rest);
    if (!commandMatch)
        return null;
    let script = commandMatch[1].trim();
    // cmd.exe uses double quotes to wrap a -Command payload. A leading/trailing
    // single quote is valid PowerShell source and must remain part of the script.
    if (hasMatchingOuterQuotes(script, '"'))
        script = script.slice(1, -1);
    return { executable: match[1], script };
}
function hasMatchingOuterQuotes(value, quote) {
    if (value.length < 2 || value[0] !== quote || value[value.length - 1] !== quote)
        return false;
    // The wrapper produced by models normally quotes the complete -Command body.
    // Only strip that pair when the final quote is not escaped with an odd run of
    // PowerShell backticks. Inner quotes remain untouched in the temporary file.
    let backticks = 0;
    for (let index = value.length - 2; index >= 0 && value[index] === '`'; index--)
        backticks++;
    return backticks % 2 === 0;
}
function normalizeCmdNewlines(command) {
    return command.replace(/\r\n|\r|\n/g, '\r\n');
}
/**
 * Extract `python -c "...multiline source..."` from a CMD command. The
 * optional prefix preserves wrappers such as `chcp 65001 >nul &&`; arguments
 * after the source remain attached to the generated script invocation.
 */
function extractMultilinePythonInlineSource(command) {
    const match = /^([\s\S]*?\b)((?:python(?:\d(?:\.\d+)?)?|py)(?:\.exe)?)\s+(?:-c|\/c)\s+(["'])([\s\S]*)\3([\s\S]*)$/i.exec(command);
    if (!match || !/[\r\n]/.test(match[4]))
        return null;
    return {
        prefix: match[1],
        executable: match[2],
        source: match[4].replace(/^\r?\n/, ''),
        suffix: match[5],
    };
}
function decodeOutput(value) {
    if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
        return repairMojibake(value.subarray(2).toString('utf16le'));
    }
    if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
        return repairMojibake(iconv.decode(value.subarray(2), 'utf16-be'));
    }
    if (looksLikeUtf16(value)) {
        return repairMojibake(iconv.decode(value, value[0] === 0 ? 'utf16-be' : 'utf16le'));
    }
    return repairMojibake((0, DiagnosticDecoder_1.decodeDiagnostic)(value));
}
/**
 * Repair text that was decoded once with the wrong character set before it
 * reached stdout. At that point the stdout byte stream is valid UTF-8, so a
 * replacement-character check alone cannot detect strings such as
 * `ä¸­æ–‡` (Latin-1) or `涓枃` (GBK). Only accept a reversible transform with
 * strong mojibake evidence and a clear reduction in that evidence.
 */
function repairMojibake(value) {
    if (!value || process.platform !== 'win32')
        return value;
    const repaired = repairMojibakeUnit(value);
    if (repaired !== value || !/[\r\n]/.test(value))
        return repaired;
    return value.split(/(\r\n|\r|\n)/).map((part) => /^(?:\r\n|\r|\n)$/.test(part) ? part : repairMojibakeUnit(part)).join('');
}
function repairMojibakeUnit(value) {
    const candidates = [];
    const latinEvidence = latinMojibakeEvidence(value);
    if (latinEvidence >= 2) {
        for (const encoding of ['latin1', 'windows-1252']) {
            const candidate = reverseDecode(value, encoding);
            if (candidate && textCharacterCount(candidate) >= 2) {
                candidates.push({ value: candidate, evidence: latinMojibakeEvidence(candidate) });
            }
        }
    }
    const gbkEvidence = gbkMojibakeEvidence(value);
    if (gbkEvidence >= 3) {
        const candidate = reverseDecode(value, 'gb18030');
        if (candidate && textCharacterCount(candidate) >= 2) {
            candidates.push({ value: candidate, evidence: gbkMojibakeEvidence(candidate) });
        }
    }
    if (candidates.length === 0)
        return value;
    const sourceEvidence = Math.max(latinEvidence, gbkEvidence);
    candidates.sort((a, b) => a.evidence - b.evidence);
    return candidates[0].evidence + 2 <= sourceEvidence ? candidates[0].value : value;
}
function reverseDecode(value, encoding) {
    const bytes = iconv.encode(value, encoding);
    // An encoding that cannot represent part of the source replaces it. Reject
    // that lossy route before attempting the reverse conversion.
    if (iconv.decode(bytes, encoding) !== value)
        return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return null;
    }
}
function latinMojibakeEvidence(value) {
    const controls = value.match(/[\u0080-\u009f]/g)?.length || 0;
    const common = value.match(/(?:Ã.|Â.|â€|ã€|ä.|å.|æ.|ç.|è.|é.|ï¼|ï»¿|ðŸ)/g)?.length || 0;
    return controls * 2 + common;
}
function gbkMojibakeEvidence(value) {
    const privateUse = value.match(/[\ue000-\uf8ff]/g)?.length || 0;
    const common = value.match(/(?:涓枃|鍏憡|锛氬|骞夸笢|娴嬭瘯|鏂囧瓧|鐨勬|鏄|鎴戜滑|杩欎釜|涓嶆槸|浠诲姟)/g)?.length || 0;
    return privateUse * 4 + common * 3;
}
function textCharacterCount(value) {
    return value.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length || 0;
}
/** Detect BOM-less UTF-16 by the NUL-byte distribution in its first bytes. */
function looksLikeUtf16(value) {
    const sampleLength = Math.min(value.length - (value.length % 2), 512);
    if (sampleLength < 4)
        return false;
    let evenNulls = 0;
    let oddNulls = 0;
    for (let i = 0; i < sampleLength; i += 2) {
        if (value[i] === 0)
            evenNulls++;
        if (value[i + 1] === 0)
            oddNulls++;
    }
    const pairs = sampleLength / 2;
    return (evenNulls / pairs > 0.3 && oddNulls / pairs < 0.05)
        || (oddNulls / pairs > 0.3 && evenNulls / pairs < 0.05);
}
//# sourceMappingURL=ProcessManager.js.map