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
// 2 keeps the whole suite green; 4 still loses one timing-sensitive browser
// test per round, so it stays an experiment rather than the default.
const concurrency = String(value('--concurrency', '2'));

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


async function main() {
  console.log(`[tests] ${files.length} file(s), concurrency ${concurrency}${onlyFast ? ', browser excluded' : onlyBrowser ? ', browser only' : ''}`);
  const started = Date.now();

  // One Chrome for every browser test in this run: each test still gets its own
  // tab on its own port, so origin-scoped state stays isolated, but the ~2 s cold
  // start is paid once instead of 52 times.
  const needsBrowser = files.some((file) => path.basename(file).startsWith('browser-'));
  let shared = null;
  const env = { ...process.env };
  if (needsBrowser && !has('--no-shared-browser')) {
    const { startSharedChrome } = require(path.join(root, 'tests', 'helpers', 'shared-chrome.js'));
    shared = await startSharedChrome();
    env.IEXA_TEST_CDP_HTTP = shared.http;
    console.log(`[tests] shared Chrome at ${shared.http}`);
  }

  let status = 1;
  try {
    const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...files], {
      cwd: root,
      stdio: 'inherit',
      env,
    });
    status = result.status ?? 1;
  } finally {
    if (shared) await shared.stop();
  }
  console.log(`[tests] ${((Date.now() - started) / 1000).toFixed(1)}s, exit ${status}`);
  process.exit(status);
}

main().catch((error) => { console.error(error); process.exit(1); });
