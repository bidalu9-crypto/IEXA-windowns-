const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function electronVersion() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Electron must be an exact stable version');
  return version;
}
function runtimeDir() { return path.join(root, 'node_modules/electron/dist'); }
function runtimeExe() { return path.join(runtimeDir(), 'electron.exe'); }
function assertInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error(`Unsafe output path: ${target}`);
  return path.resolve(target);
}
module.exports = { root, electronVersion, runtimeDir, runtimeExe, assertInside };
if (require.main === module) console.log(process.argv.includes('--version') ? electronVersion() : runtimeExe());
