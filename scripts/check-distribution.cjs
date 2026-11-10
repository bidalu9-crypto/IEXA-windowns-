#!/usr/bin/env node
'use strict';

// Read-only verification of the directory assembled by build-dist.js. Hashing
// is streamed and serial, using the same marker exclusions as the build itself.
// Usage: node scripts/check-distribution.cjs --package release/IEXA --output report.json
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { fileHashes, sha256 } = require('../download_electron.js');
const { root: ROOT, electronVersion } = require('./electron-config.cjs');
const SOURCE_INPUTS = ['src/renderer', 'dist', 'resources', 'desktop-agent/publish', 'electron-entry.js', 'preload.js', 'package-lock.json'];
const APP_PREFIX = 'resources/app/';
const exists = filename => fs.existsSync(filename);
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const safeRelative = value => typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && !/^[a-z]:/i.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');

function compare(expected, actual, scope, report) {
  for (const relative of Object.keys(expected).sort()) {
    if (!Object.hasOwn(actual, relative)) report.missing.push({ scope, path: relative });
    else if (expected[relative] !== actual[relative]) report.mismatches.push({ scope, path: relative, expected: expected[relative], actual: actual[relative] });
  }
  for (const relative of Object.keys(actual).sort()) if (!Object.hasOwn(expected, relative)) report.extra.push({ scope, path: relative });
}

function forbiddenArtifact(relative) {
  if (/(?:^|\/)code[-_]?oss(?:[./_-]|$)/i.test(relative)) return 'CodeOSS resource';
  if (/(?:^|\/)vs\/(?:workbench|code)(?:\/|$)/i.test(relative) || /(?:^|\/)workbench\.(?:desktop|web)\.main\.(?:js|css)$/i.test(relative)) return 'CodeOSS workbench frontend';
  if (/(?:^|\/)(?:extension[-_]host|extensionHost(?:Process|Worker(?:Main)?|Starter|Main)?)(?:[./_-]|$)/i.test(relative)) return 'extension host';
  return '';
}

function inspectDirectories(directory, report, current = directory) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(current, entry.name), relative = path.relative(directory, filename).replace(/\\/g, '/');
    const reason = forbiddenArtifact(relative);
    if (reason) report.forbidden.push({ path: relative + '/', reason });
    else inspectDirectories(directory, report, filename);
  }
}

async function verifyDistribution({ sourceRoot = ROOT, directory = path.join(ROOT, 'release/IEXA') } = {}) {
  const started = Date.now();
  sourceRoot = path.resolve(sourceRoot); directory = path.resolve(directory);
  const report = {
    success: false, checkedAt: new Date().toISOString(), sourceRoot, directory,
    sourceFileCount: 0, manifestFileCount: 0, actualFileCount: 0, packages: null,
    manifestSHA256: null, electron: null,
    ignored: ['build-manifest.json', '**/.iexa-verified.json'],
    sourceInputs: SOURCE_INPUTS, packageJsonFields: ['name', 'version', 'main', 'dependencies'],
    productionPackages: { expected: 0, verified: 0 },
    mismatches: [], missing: [], extra: [], forbidden: [], errors: [],
  };
  try {
    if (!exists(directory)) { report.missing.push({ scope: 'distribution', path: directory }); return report; }
    const manifestFile = path.join(directory, 'build-manifest.json');
    if (!exists(manifestFile)) { report.missing.push({ scope: 'manifest', path: 'build-manifest.json' }); return report; }
    report.manifestSHA256 = await sha256(manifestFile);
    const manifest = json(manifestFile);
    report.packages = manifest.packages ?? null; report.electron = manifest.electron ?? null;
    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw Error('build-manifest.json has no file hash map');
    const expectedManifest = Object.create(null);
    for (const [relative, hash] of Object.entries(manifest.files)) {
      if (!safeRelative(relative) || relative === 'build-manifest.json' || path.posix.basename(relative) === '.iexa-verified.json' || !/^[a-f0-9]{64}$/i.test(hash)) {
        report.errors.push(`Invalid manifest entry: ${relative}`); continue;
      }
      expectedManifest[relative] = hash.toLowerCase();
    }
    report.manifestFileCount = Object.keys(manifest.files).length;
    const actual = await fileHashes(directory);
    delete actual['build-manifest.json'];
    report.actualFileCount = Object.keys(actual).length;
    compare(expectedManifest, actual, 'manifest', report);

    for (const relative of Object.keys(actual)) {
      const reason = forbiddenArtifact(relative);
      if (reason) report.forbidden.push({ path: relative, reason });
    }
    // Include empty directories, which do not appear in a file hash manifest.
    inspectDirectories(directory, report);
    const expectedElectron = electronVersion();
    if (manifest.electron !== expectedElectron) report.mismatches.push({ scope: 'metadata', path: 'electron', expected: expectedElectron, actual: manifest.electron });

    for (const input of SOURCE_INPUTS) {
      const source = path.join(sourceRoot, input), target = APP_PREFIX + input;
      if (!exists(source)) { report.missing.push({ scope: 'source', path: input }); continue; }
      if (fs.lstatSync(source).isSymbolicLink()) throw Error(`Unexpected symlink in source input: ${input}`);
      if (fs.statSync(source).isDirectory()) {
        const sourceHashes = await fileHashes(source), expected = {}, packaged = {};
        for (const [relative, hash] of Object.entries(sourceHashes)) expected[`${target}/${relative}`] = hash;
        for (const [relative, hash] of Object.entries(actual)) if (relative.startsWith(target + '/')) packaged[relative] = hash;
        report.sourceFileCount += Object.keys(expected).length;
        compare(expected, packaged, 'source', report);
      } else {
        report.sourceFileCount++;
        const expected = { [target]: await sha256(source) };
        compare(expected, Object.hasOwn(actual, target) ? { [target]: actual[target] } : {}, 'source', report);
      }
    }

    const sourcePackage = json(path.join(sourceRoot, 'package.json'));
    const packagedPackageFile = path.join(directory, APP_PREFIX, 'package.json');
    if (!exists(packagedPackageFile)) report.missing.push({ scope: 'package-json', path: APP_PREFIX + 'package.json' });
    else {
      const packagedPackage = json(packagedPackageFile);
      for (const field of report.packageJsonFields) if (!isDeepStrictEqual(sourcePackage[field], packagedPackage[field])) report.mismatches.push({ scope: 'package-json', path: field, expected: sourcePackage[field], actual: packagedPackage[field] });
    }

    const lock = json(path.join(sourceRoot, 'package-lock.json'));
    if (lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== 'object') throw Error('A modern npm lockfile is required');
    for (const [relative, metadata] of Object.entries(lock.packages)) {
      if (!relative || metadata.dev || !relative.startsWith('node_modules/')) continue;
      if (!safeRelative(relative) || metadata.link) { report.errors.push(`Invalid production dependency path: ${relative}`); continue; }
      const source = path.join(sourceRoot, relative);
      if (metadata.optional && !exists(source)) continue; // same platform-specific exclusion as the packager
      report.productionPackages.expected++;
      const packaged = path.join(directory, APP_PREFIX, relative, 'package.json');
      if (!exists(packaged)) { report.missing.push({ scope: 'production-package', path: relative + '/package.json' }); continue; }
      const installed = json(packaged);
      if (installed.version !== metadata.version) report.mismatches.push({ scope: 'production-package', path: relative, expected: metadata.version, actual: installed.version });
      else report.productionPackages.verified++;
    }
    if (manifest.packages !== report.productionPackages.expected) report.mismatches.push({ scope: 'metadata', path: 'packages', expected: report.productionPackages.expected, actual: manifest.packages });
    report.success = !['mismatches', 'missing', 'extra', 'forbidden', 'errors'].some(key => report[key].length);
  } catch (error) { report.errors.push(error.message); }
  finally { report.elapsedMs = Date.now() - started; }
  return report;
}

async function main(argv = process.argv.slice(2)) {
  let directory = path.join(ROOT, 'release/IEXA'), output;
  for (let i = 0; i < argv.length; i++) {
    if (!['--package', '--output'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Usage: node scripts/check-distribution.cjs [--package directory] [--output report.json]');
    const flag = argv[i++], value = path.resolve(argv[i]);
    if (flag === '--package') directory = value; else output = value;
  }
  if (output) {
    const relative = path.relative(directory, output);
    if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw Error('Write the verification report outside the distribution directory');
  }
  const report = await verifyDistribution({ directory });
  const content = JSON.stringify(report, null, 2) + '\n';
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content);
    console.log(JSON.stringify({ success: report.success, report: output, sourceFileCount: report.sourceFileCount, manifestFileCount: report.manifestFileCount, packages: report.packages, mismatches: report.mismatches.length, missing: report.missing.length, extra: report.extra.length, forbidden: report.forbidden.length, errors: report.errors.length }));
  } else process.stdout.write(content);
  return report.success ? 0 : 1;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyDistribution, main };
