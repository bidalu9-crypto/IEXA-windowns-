// =============================================================================
// IEXA PC - Distribution Builder
// Assembles a full Electron app folder for packaging
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const DIST = path.join(ROOT, 'release', 'IEXA');
const ELECTRON_SRC = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache', 'electron-v28.0.0-win32-x64');

console.log('=== IEXA Distribution Builder ===\n');
console.log('Root:', ROOT);
console.log('Electron:', ELECTRON_SRC);
console.log('Output:', DIST);

// Clean
if (fs.existsSync(path.join(ROOT, 'release'))) {
  fs.rmSync(path.join(ROOT, 'release'), { recursive: true, force: true });
}

// Create directories
fs.mkdirSync(path.join(DIST, 'resources', 'app'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'locales'), { recursive: true });

// ---- Copy Electron binaries ----
console.log('\n[1/5] Copying Electron runtime...');
const electronFiles = fs.readdirSync(ELECTRON_SRC).filter(f => {
  return !['resources', ' locales'].includes(f.toLowerCase()) &&
         f !== 'swiftshader' &&
         !f.startsWith('locales');
});

for (const f of electronFiles) {
  const src = path.join(ELECTRON_SRC, f);
  if (fs.statSync(src).isFile()) {
    fs.copyFileSync(src, path.join(DIST, f));
  }
}

// Rename electron.exe → IEXA.exe
const electronExe = path.join(DIST, 'electron.exe');
const IEXAExe = path.join(DIST, 'IEXA.exe');
if (fs.existsSync(electronExe)) {
  fs.renameSync(electronExe, IEXAExe);
  console.log('  Renamed electron.exe → IEXA.exe');
}

// Copy locales
console.log('[2/5] Copying locales...');
const localesSrc = path.join(ELECTRON_SRC, 'locales');
if (fs.existsSync(localesSrc)) {
  const localeFiles = fs.readdirSync(localesSrc).filter(f => f.endsWith('.pak'));
  for (const f of localeFiles.slice(0, 5)) {  // Just a few for size
    fs.copyFileSync(path.join(localesSrc, f), path.join(DIST, 'locales', f));
  }
}

// ---- Copy app files ----
console.log('[3/5] Copying application code...');
const APP = path.join(DIST, 'resources', 'app');

// package.json for Electron
const appPkg = {
  name: 'IEXA',
  version: '1.0.0',
  main: 'electron-entry.js',
};
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(appPkg, null, 2));

// electron-entry.js
fs.copyFileSync(path.join(ROOT, 'electron-entry.js'), path.join(APP, 'electron-entry.js'));

// dist (compiled TypeScript)
copyDir(path.join(ROOT, 'dist'), path.join(APP, 'dist'));

// src/renderer (UI files)
copyDir(path.join(ROOT, 'src', 'renderer'), path.join(APP, 'src', 'renderer'));

// resources (icons)
const resourcesDir = path.join(ROOT, 'resources');
if (fs.existsSync(resourcesDir)) {
  copyDir(resourcesDir, path.join(APP, 'resources'));
  console.log('  Copied resources (icons)');
} else {
  fs.mkdirSync(path.join(APP, 'resources'), { recursive: true });
}

// node_modules — copy all production deps recursively
console.log('[4/5] Copying node_modules...');
const pkg = require(path.join(ROOT, 'package.json'));

// Recursively collect all transitive dependencies
function collectDeps(modName, collected) {
  if (collected.has(modName)) return;
  const pkgPath = path.join(ROOT, 'node_modules', modName, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  collected.add(modName);
  try {
    const modPkg = require(pkgPath);
    const deps = Object.keys(modPkg.dependencies || {});
    for (const dep of deps) {
      collectDeps(dep, collected);
    }
  } catch { /* skip */ }
}

const allDeps = new Set();
for (const mod of Object.keys(pkg.dependencies || {})) {
  collectDeps(mod, allDeps);
}

fs.mkdirSync(path.join(APP, 'node_modules'), { recursive: true });
let copied = 0;
for (const mod of allDeps) {
  const src = path.join(ROOT, 'node_modules', mod);
  const dest = path.join(APP, 'node_modules', mod);
  if (fs.existsSync(src)) {
    copyDir(src, dest);
    copied++;
  }
}
console.log(`  Copied ${copied} packages (${allDeps.size} total deps)`);

// ---- Create app icon (simple placeholder) ----
console.log('[5/5] Creating launcher...');

// Create a VBS launcher for desktop shortcut
const vbsLauncher = `
Set WshShell = CreateObject("WScript.Shell")
Dim appDir
appDir = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\IEXA"
WshShell.CurrentDirectory = appDir
WshShell.Run """" & appDir & "\\IEXA.exe" & """", 1, False
`;
fs.writeFileSync(path.join(ROOT, 'release', 'launcher.vbs'), vbsLauncher.trim());

// Copy launcher to dist folder too
fs.writeFileSync(path.join(DIST, 'launcher.vbs'), vbsLauncher.trim());

// ---- Summary ----
console.log('\n=== Build Complete ===');
console.log('Output:', DIST);

const dirs = getDirSize(DIST);
console.log('Total size:', (dirs / 1024 / 1024).toFixed(1), 'MB');

// ---- Helpers ----
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function getDirSize(dir) {
  let size = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) size += getDirSize(p);
      else size += fs.statSync(p).size;
    }
  } catch { /* skip */ }
  return size;
}
