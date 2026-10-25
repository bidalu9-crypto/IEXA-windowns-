// A packaged build must never derive its workspace from __dirname. In an asar that
// path is inside the archive (mkdirSync throws and the app dies with an error
// dialog); in a portable build it is a temp extraction that vanishes on exit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const entry = fs.readFileSync(path.join(root, 'electron-entry.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the workspace is resolved from the runtime, not from __dirname alone', () => {
  assert.match(entry, /function resolveWorkspaceDir\(\)/, 'there is an explicit resolver');
  const resolver = entry.slice(entry.indexOf('function resolveWorkspaceDir()'));
  const body = resolver.slice(0, resolver.indexOf('function ensureInstanceWorkspace'));

  assert.match(body, /process\.env\.IEXA_WORKSPACE/, 'an explicit override still wins');
  assert.match(body, /PORTABLE_EXECUTABLE_DIR/, 'the portable target keeps data beside the exe');
  assert.match(body, /app\.isPackaged/, 'a packaged build falls back to appData');
  assert.match(body, /app\.getPath\('appData'\)/, 'never inside app.asar');
  // The dev fallback stays last: it is the only case where __dirname is writable.
  const devAt = body.indexOf("path.join(__dirname, 'workspace')");
  assert.ok(devAt > body.indexOf('app.isPackaged'), 'the __dirname path is the last resort');
});

test('a portable build is declared with a stable artifact name', () => {
  assert.equal(pkg.build.portable.artifactName, 'IEXA-WIN-Portable-${version}.${ext}');
  assert.equal(pkg.scripts['dist:portable'], 'npm run build && electron-builder --win portable --publish never');
  // The installer target must survive: both are shipped.
  assert.equal(pkg.build.win.target, 'nsis');
  assert.ok(pkg.build.nsis.artifactName.includes('Setup'));
});

test('the packaged payload still carries the desktop agent and native modules', () => {
  const unpacked = pkg.build.asarUnpack.join('\n');
  assert.match(unpacked, /desktop-agent\/publish/, 'the UIA agent cannot live inside an asar');
  assert.match(unpacked, /node-pty/, 'node-pty ships prebuilt binaries');
  for (const entryPoint of ['dist/**/*', 'src/renderer/**/*', 'electron-entry.js', 'preload.js', 'resources/**/*']) {
    assert.ok(pkg.build.files.includes(entryPoint), `files is missing ${entryPoint}`);
  }
});
