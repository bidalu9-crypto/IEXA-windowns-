'use strict';
const fs = require('node:fs');
const path = require('node:path');
const copyRetryWait = new Int32Array(new SharedArrayBuffer(4));
function copyLockedPackage(source, destination, filter) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.cpSync(source, destination, { recursive: true, filter });
      return;
    } catch (error) {
      // Windows scanners can briefly retain newly copied files. Recopy the
      // entire package, including its checks, rather than omitting a file or
      // accepting a partial package. Structural/lockfile errors still fail.
      const transient = ['EPERM', 'EBUSY', 'EACCES'].includes(error.code)
        || error.code === 'UNKNOWN' && error.syscall === 'copyfile';
      if (!transient || attempt >= 5) throw error;
      Atomics.wait(copyRetryWait, 0, 0, 150 * (attempt + 1));
    }
  }
}
// Lockfile paths preserve nested and optional package layout, unlike name-only traversal.
function copyProductionDependencies(root, app) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  if (lock.lockfileVersion < 2) throw Error('A modern npm lockfile is required');
  let count = 0;
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    if (!relative || metadata.dev || !relative.startsWith('node_modules/')) continue;
    if (relative.split('/').includes('..') || metadata.link) throw Error(`Unsupported dependency path: ${relative}`);
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) {
      if (metadata.optional) continue; // platform-specific optional dependency
      throw Error(`Missing locked production package: ${relative}`);
    }
    const actual = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    if (actual.version !== metadata.version) throw Error(`Installed/locked version differs: ${relative}`);
    copyLockedPackage(source, path.join(app, relative), (file) => {
      const local = path.relative(source, file).split(path.sep);
      if (local.includes('node_modules')) return false; // copied from its own lock entry
      if (fs.lstatSync(file).isSymbolicLink()) throw Error(`Unexpected package symlink: ${file}`);
      return true;
    });
    count++;
  }
  return count;
}
module.exports = { copyProductionDependencies };
