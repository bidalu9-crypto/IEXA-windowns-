import * as path from 'path';
import * as fs from 'fs';
import { IexaError } from '../errors/IexaError';

export interface ResolvedPath { input: string; path: string; workspace: string; }
export type PathMode = 'workspace' | 'selected-roots' | 'full';
export interface PathPolicy {
  workspaceDir: string;
  allowMissing?: boolean;
  writable?: boolean;
  mode?: PathMode;
  roots?: readonly string[];
  permissionMode?: 'ask' | 'risk' | 'full';
}

function reject(code: string, message: string): never { throw new IexaError(code, 'SECURITY', message); }

/** Reject alternate Windows namespaces on every platform, before normalization. */
function validatePath(input: string, full: boolean): void {
  if (typeof input !== 'string' || !input.trim()) reject('PATH_EMPTY', 'File path is empty.');
  if (/[\x00-\x1f]/.test(input)) reject('PATH_INVALID', 'Control characters in path.');
  const windows = input.replace(/\//g, '\\');
  if (windows.startsWith('\\\\') || windows.startsWith('\\??\\') || windows.startsWith('\\Device\\')) {
    reject('PATH_NETWORK', 'UNC and device paths are restricted.');
  }
  if (/^[a-z]:[^\\/]/i.test(input) || /^[a-z]:$/i.test(input)) reject('PATH_INVALID', 'Drive-relative path is ambiguous.');
  const body = input.replace(/^[a-z]:[\\/]/i, '');
  for (const component of body.split(/[\\/]/)) {
    if (!full && /^\.iexa-/i.test(component)) reject('PATH_INTERNAL', 'Internal application paths are restricted.');
    if (component.includes(':') || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component) ||
        (component !== '.' && component !== '..' && /[. ]$/.test(component))) {
      reject('PATH_INVALID', 'Alternate streams, device names and ambiguous path components are restricted.');
    }
  }
}

// A single algorithm driven by either sync or async filesystem operations keeps
// HTTP routes and tools consistent. Only ENOENT permits a missing suffix; a
// dangling link, ENOTDIR, EACCES, ELOOP, etc. fail closed.
type Operation = { kind: 'realpath' | 'lstat' | 'stat'; path: string };
type Result = string | fs.Stats;
function* canonical(input: string, allowMissing: boolean): Generator<Operation, string, Result> {
  let current = input;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = (yield { kind: 'realpath', path: current }) as string;
      if (suffix.length && !( (yield { kind: 'stat', path: real }) as fs.Stats).isDirectory()) {
        reject('PATH_PARENT', 'Existing path parent is not a directory.');
      }
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let exists = false;
      try { yield { kind: 'lstat', path: current }; exists = true; }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      if (exists) reject('PATH_LINK', 'Unresolvable symbolic link or junction.');
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function* resolvePolicy(input: string, policy: PathPolicy): Generator<Operation, ResolvedPath, Result> {
  const full = policy.permissionMode === 'full';
  if (policy.mode === 'full' && !full) reject('PATH_MODE', 'Full path access requires explicit full permission mode.');
  validatePath(input, full);
  validatePath(policy.workspaceDir, full);
  const workspace = yield* canonical(path.resolve(policy.workspaceDir), false);
  const candidate = path.resolve(workspace, input);
  const resolved = yield* canonical(candidate, policy.allowMissing === true);
  validatePath(resolved, full);
  if (!full) {
    const roots = policy.mode === 'selected-roots' ? policy.roots || [] : [policy.workspaceDir];
    let allowed = false;
    for (const root of roots) {
      validatePath(root, false);
      const realRoot = yield* canonical(path.resolve(root), false);
      validatePath(realRoot, false);
      if (!((yield { kind: 'stat', path: realRoot }) as fs.Stats).isDirectory()) reject('PATH_ROOT', 'Scope root is not a directory.');
      if (contains(realRoot, resolved)) allowed = true;
    }
    if (!allowed) reject('PATH_OUTSIDE', 'Path is outside the authorized roots.');
  }
  return { input, path: resolved, workspace };
}

function runSync<T>(steps: Generator<Operation, T, Result>): T {
  let step = steps.next();
  while (!step.done) {
    try {
      const op = step.value;
      const result = op.kind === 'realpath' ? fs.realpathSync.native(op.path) : op.kind === 'stat' ? fs.statSync(op.path) : fs.lstatSync(op.path);
      step = steps.next(result);
    } catch (error) { step = steps.throw(error); }
  }
  return step.value;
}
async function runAsync<T>(steps: Generator<Operation, T, Result>): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    try {
      const op = step.value;
      const result = op.kind === 'realpath' ? await fs.promises.realpath(op.path) : op.kind === 'stat' ? await fs.promises.stat(op.path) : await fs.promises.lstat(op.path);
      step = steps.next(result);
    } catch (error) { step = steps.throw(error); }
  }
  return step.value;
}

/** HTTP routes: relative inputs use the first root, all roots are realpath boundaries. */
export function resolveScopedPath(input: string, roots: readonly string[], allowMissing = false): string {
  if (!roots.length) reject('PATH_ROOT', 'At least one authorized root is required.');
  return runSync(resolvePolicy(input, { workspaceDir: roots[0], mode: 'selected-roots', roots, allowMissing })).path;
}
export async function resolveScopedPathAsync(input: string, roots: readonly string[], allowMissing = false): Promise<string> {
  if (!roots.length) reject('PATH_ROOT', 'At least one authorized root is required.');
  return (await runAsync(resolvePolicy(input, { workspaceDir: roots[0], mode: 'selected-roots', roots, allowMissing }))).path;
}

/** Revalidate at the point of use; path resolution alone is not an atomic file handle sandbox. */
export class PathSandbox {
  resolveSync(input: string, policy: PathPolicy): ResolvedPath { return runSync(resolvePolicy(input, policy)); }
  resolve(input: string, policy: PathPolicy): Promise<ResolvedPath> { return runAsync(resolvePolicy(input, policy)); }
}
