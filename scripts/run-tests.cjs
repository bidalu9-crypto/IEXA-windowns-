#!/usr/bin/env node
/**
 * Run a slice of the suite without shell-specific globbing.
 *
 * The browser tests are 52 of 207 files but take ~80% of the wall clock: each
 * one spawns Chromium, waits for a real server, and tears it down. Daily work
 * rarely needs them, so `--fast` gives a 35 s signal instead of 200 s.
 *
 * Usage:
 *   node scripts/run-tests.cjs            # everything
 *   node scripts/run-tests.cjs --fast     # everything except browser-*
 *   node scripts/run-tests.cjs --browser  # only browser-*
 *   node scripts/run-tests.cjs --fast --concurrency 6
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const onlyFast = has('--fast');
const onlyBrowser = has('--browser');
if (onlyFast && onlyBrowser) {
  console.error('--fast and --browser are mutually exclusive');
  process.exit(2);
}

// 4 is the highest setting that still passed the full suite; 6 exposes latent
// races in three timing-sensitive browser tests (see the README of the task).
const concurrency = String(value('--concurrency', '4'));

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'tests');
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => (onlyFast ? !name.startsWith('browser-') : onlyBrowser ? name.startsWith('browser-') : true))
  .sort()
  .map((name) => path.join('tests', name));

if (!files.length) {
  console.error('no test files matched');
  process.exit(2);
}

console.log(`[tests] ${files.length} file(s), concurrency ${concurrency}${onlyFast ? ', browser excluded' : onlyBrowser ? ', browser only' : ''}`);
const started = Date.now();
const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...files], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`[tests] ${((Date.now() - started) / 1000).toFixed(1)}s, exit ${result.status ?? 1}`);
process.exit(result.status ?? 1);
