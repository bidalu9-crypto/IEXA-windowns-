// =============================================================================
// IEXA PC - Tool lifecycle hooks
//
// Workspace-level configuration in `<workspace>/.iexa-hooks.json`:
//
//   {
//     "preToolUse":  { "script": ".iexa-hooks/pre.js",  "tools": ["file_write"], "timeoutMs": 5000 },
//     "postToolUse": { "script": ".iexa-hooks/post.js" }
//   }
//
// A hook is a Node script that receives one JSON payload on stdin and may print
// `{ "block": true, "reason": "..." }` on stdout. Only preToolUse can block; a
// postToolUse result is advisory. Hooks never receive the ability to rewrite
// tool arguments, so the schema that was validated is the schema that runs.
// =============================================================================

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { stripBom } from '../persistence/stripBom';

export type HookPhase = 'preToolUse' | 'postToolUse';

export interface HookSpec {
  phase: HookPhase;
  script: string;
  tools?: string[];
  timeoutMs: number;
}

export interface HookPayload {
  phase: HookPhase;
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
  result?: { success: boolean; output: string; executionStatus?: string };
}

export interface HookOutcome {
  block: boolean;
  reason?: string;
  errors: string[];
}

const CONFIG_FILE = '.iexa-hooks.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_HOOK_STDOUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Read and validate the workspace hook configuration. Invalid entries fail closed. */
export function loadHookSpecs(workspaceDir: string): HookSpec[] {
  let root: string;
  try { root = fs.realpathSync.native(workspaceDir); } catch { return []; }
  const configPath = path.join(root, CONFIG_FILE);
  let source: unknown;
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return [];
    source = JSON.parse(stripBom(fs.readFileSync(configPath, 'utf8')));
  } catch { return []; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];

  const specs: HookSpec[] = [];
  for (const phase of ['preToolUse', 'postToolUse'] as const) {
    const entry = (source as Record<string, unknown>)[phase];
    if (entry == null) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['script', 'tools', 'timeoutMs'].includes(key))) continue;

    const relativeScript = String(raw.script || '').trim();
    if (!relativeScript) continue;
    const absolute = path.resolve(root, relativeScript);
    if (!inside(root, absolute)) continue;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || !['.js', '.cjs', '.mjs'].includes(path.extname(absolute).toLowerCase())) continue;
    } catch { continue; }

    let tools: string[] | undefined;
    if (raw.tools !== undefined) {
      if (!Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.length > 64) continue;
      tools = raw.tools.map((value) => String(value)).filter((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value));
      if (!tools.length) continue;
    }

    const requested = Number(raw.timeoutMs);
    const timeoutMs = Number.isFinite(requested) ? Math.max(100, Math.min(30_000, Math.floor(requested))) : DEFAULT_TIMEOUT_MS;
    specs.push({ phase, script: absolute, tools, timeoutMs });
  }
  return specs;
}

function runOne(spec: HookSpec, payload: HookPayload, cwd: string, signal: AbortSignal): Promise<{ block: boolean; reason?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { block: boolean; reason?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => { try { child.kill(); } catch { /* already gone */ } finish({ block: false, error: 'hook 已取消' }); };

    const child = spawn(process.execPath, [spec.script], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IEXA_HOOK_PHASE: spec.phase, IEXA_SESSION_ID: payload.sessionId },
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ block: false, error: `hook 超时（${spec.timeoutMs}ms）` });
    }, spec.timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });

    let stdout = '';
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_HOOK_STDOUT) { overflow = true; try { child.kill(); } catch { /* already gone */ } }
    });
    child.stderr.on('data', () => { /* diagnostics are intentionally discarded */ });
    child.on('error', (error) => finish({ block: false, error: `hook 启动失败：${error.message}` }));
    child.on('close', (code) => {
      if (overflow) return finish({ block: false, error: 'hook 输出超过 64 KB' });
      const text = stdout.trim();
      if (!text) return finish({ block: false });
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (spec.phase === 'preToolUse' && parsed.block === true) {
          return finish({ block: true, reason: String(parsed.reason || 'hook 阻止了该工具').slice(0, 500) });
        }
        return finish({ block: false });
      } catch {
        return finish({ block: false, error: `hook 输出不是有效 JSON（exit ${code ?? '?'}）` });
      }
    });
    try { child.stdin.end(JSON.stringify(payload)); } catch { /* child exited early */ }
  });
}

/** Run every matching hook in order. preToolUse blocking stops the chain. */
export async function runHooks(specs: HookSpec[], payload: HookPayload, cwd: string, signal?: AbortSignal): Promise<HookOutcome> {
  const errors: string[] = [];
  const matching = specs.filter((spec) => spec.phase === payload.phase && (!spec.tools || spec.tools.includes(payload.tool)));
  if (!matching.length) return { block: false, errors };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (const spec of matching) {
      if (controller.signal.aborted) break;
      const outcome = await runOne(spec, payload, cwd, controller.signal);
      if (outcome.error) errors.push(outcome.error);
      if (outcome.block) return { block: true, reason: outcome.reason, errors };
    }
    return { block: false, errors };
  } finally { signal?.removeEventListener('abort', onAbort); }
}
