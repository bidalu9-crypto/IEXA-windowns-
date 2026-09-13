'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
    fs.cpSync(source, path.join(app, relative), { recursive: true, filter: (file) => {
      const local = path.relative(source, file).split(path.sep);
      if (local.includes('node_modules')) return false; // copied from its own lock entry
      if (fs.lstatSync(file).isSymbolicLink()) throw Error(`Unexpected package symlink: ${file}`);
      return true;
    } });
    count++;
  }
  return count;
}
module.exports = { copyProductionDependencies };
