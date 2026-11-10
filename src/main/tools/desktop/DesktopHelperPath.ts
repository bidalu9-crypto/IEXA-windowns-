import * as fs from 'fs';
import * as path from 'path';

interface DesktopHelperEnvironment {
  moduleDirectory?: string;
  resourcesPath?: string;
  execPath?: string;
}

export interface DesktopHelperBinary {
  executable?: string;
  dll?: string;
}

/** src/main/tools/desktop and dist/main/tools/desktop share this depth. */
export function desktopApplicationRoot(moduleDirectory: string = __dirname): string {
  if (!path.isAbsolute(moduleDirectory)) throw new Error('Desktop helper module directory must be absolute.');
  return path.resolve(moduleDirectory, '../../../..');
}

/** Only the running application/module and executable supply installation roots.
 * A project directory (or its parent/cwd) must never select another helper. */
export function desktopHelperCandidates(environment: DesktopHelperEnvironment = {}): string[] {
  const moduleRoot = desktopApplicationRoot(environment.moduleDirectory);
  const resources = environment.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const execPath = environment.execPath ?? process.execPath;
  // A native executable inside an asar archive cannot be passed to spawn.
  const roots = [moduleRoot.replace(/\.asar$/i, '.asar.unpacked')];
  if (resources && path.isAbsolute(resources)) {
    roots.push(path.join(resources, 'app.asar.unpacked'), path.join(resources, 'app'), resources);
  }
  if (path.isAbsolute(execPath)) roots.push(path.dirname(execPath));
  const seen = new Set<string>();
  return roots.filter(root => {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(root => path.join(root, 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'));
}

/** Select one installation directory, keeping the apphost and DLL together. */
export function resolveDesktopHelper(environment: DesktopHelperEnvironment = {}): DesktopHelperBinary | undefined {
  const isFile = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  for (const executable of desktopHelperCandidates(environment)) {
    const dll = executable.replace(/\.exe$/i, '.dll');
    const hasExecutable = isFile(executable), hasDll = isFile(dll);
    if (hasExecutable || hasDll) return { executable: hasExecutable ? executable : undefined, dll: hasDll ? dll : undefined };
  }
  return undefined;
}
