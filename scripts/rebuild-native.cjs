'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, electronVersion, runtimeExe } = require('./electron-config.cjs');
function probe(buildPath = root, executable = runtimeExe()) {
  const program = `
    const pty = require(${JSON.stringify(path.join(buildPath, 'node_modules/node-pty'))});
    const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo IEXA_NATIVE_ABI_OK'], {
      name: 'xterm-color', cols: 80, rows: 24, cwd: ${JSON.stringify(buildPath)}, env: process.env,
    });
    let output = '';
    const timeout = setTimeout(() => { terminal.kill(); console.error('Native PTY timeout'); process.exit(1); }, 15000);
    terminal.onData(data => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      setTimeout(() => {
        console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, output }));
        process.exit(exitCode === 0 && output.includes('IEXA_NATIVE_ABI_OK') && process.versions.electron === ${JSON.stringify(electronVersion())} ? 0 : 1);
      }, 150);
    });
  `;
  const result = spawnSync(executable, ['-e', program], { cwd: buildPath, encoding: 'utf8', windowsHide: true,
    timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return !result.error && result.status === 0;
}
async function ensureNative(buildPath = root, executable = runtimeExe(), force = false) {
  // node-pty 1.1 uses Node-API. A matching prebuild may work across Electron ABIs;
  // prove this in the actual target executable, not the host Node installation.
  if (!force && probe(buildPath, executable)) return;
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({ buildPath, electronVersion: electronVersion(), arch: 'x64', onlyModules: ['node-pty'], force: true });
  if (!probe(buildPath, executable)) throw Error('Native node-pty failed under target Electron after rebuild');
}
if (require.main === module) ensureNative(root, runtimeExe(), process.argv.includes('--force'))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { probe, ensureNative };
