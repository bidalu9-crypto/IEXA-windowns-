'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root: ROOT, electronVersion, runtimeDir, assertInside } = require('./scripts/electron-config.cjs');
const { ensureNative, probe } = require('./scripts/rebuild-native.cjs');
const { copyProductionDependencies } = require('./scripts/package-production.cjs');
const { fileHashes } = require('./download_electron.js');
const RELEASE = path.join(ROOT, 'release');
function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || Error(`Build command failed: node ${args.join(' ')}`);
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Distribution target is Windows x64');
  const agent = path.join(ROOT, 'desktop-agent/publish/Iexa.DesktopAgent.exe');
  if (!fs.existsSync(agent)) throw Error('Publish the desktop-agent before assembling the distribution');
  runNode(['scripts/vendor-renderer.cjs', '--check']);
  runNode(['node_modules/typescript/bin/tsc']);
  // The installer entry point verifies official SHASUMS and installed file hashes.
  runNode(['download_electron.js', '--install']);
  await ensureNative();
  fs.mkdirSync(RELEASE, { recursive: true });
  const staging = assertInside(RELEASE, path.join(RELEASE, `IEXA.staging-${process.pid}`));
  const destination = assertInside(RELEASE, path.join(RELEASE, 'IEXA'));
  if (fs.existsSync(staging)) throw Error(`Staging path already exists: ${staging}`);
  try {
    fs.cpSync(runtimeDir(), staging, { recursive: true }); // preserve all runtime files/locales
    fs.renameSync(path.join(staging, 'electron.exe'), path.join(staging, 'IEXA.exe'));
    const app = path.join(staging, 'resources/app');
    fs.mkdirSync(app, { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, main: pkg.main, dependencies: pkg.dependencies,
    }, null, 2) + '\n');
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(app, 'package-lock.json'));
    for (const relative of ['electron-entry.js', 'preload.js', 'dist', 'src/renderer', 'resources', 'desktop-agent/publish']) {
      const source = path.join(ROOT, relative);
      if (!fs.existsSync(source)) throw Error(`Missing required distribution input: ${relative}`);
      fs.cpSync(source, path.join(app, relative), { recursive: true });
    }
    const packages = copyProductionDependencies(ROOT, app);
    if (!probe(app, path.join(staging, 'IEXA.exe'))) throw Error('Packaged Electron native smoke failed');
    for (const name of ['selfsigned', 'webdav', 'dompurify']) {
      const check = spawnSync(path.join(staging, 'IEXA.exe'), ['-e', `import(require('node:url').pathToFileURL(require.resolve(${JSON.stringify(name)})).href).catch(e=>{console.error(e);process.exitCode=1})`],
        { cwd: app, windowsHide: true, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      if (check.status !== 0) throw Error(`Packaged dependency import failed (${name}): ${check.stderr}`);
    }
    const manifest = { electron: electronVersion(), packages, files: await fileHashes(staging) };
    fs.writeFileSync(path.join(staging, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Preserve previous output for rollback, never recursively delete the release directory.
    let previous;
    if (fs.existsSync(destination)) {
      previous = assertInside(RELEASE, path.join(RELEASE, `IEXA.previous-${Date.now()}`));
      fs.renameSync(destination, previous);
    }
    try { fs.renameSync(staging, destination); }
    catch (error) { if (previous) fs.renameSync(previous, destination); throw error; }
    console.log(`Distribution verified: ${destination}; Electron ${electronVersion()}; ${packages} production packages`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
