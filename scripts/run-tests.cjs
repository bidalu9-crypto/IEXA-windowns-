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

  // Second net for scratch directories: the temp-dir helper sweeps from each
  // test process, but a watchdog SIGKILL never runs its exit hook. Remember what
  // already existed and delete only what this run created.
  const os = require('node:os');
  const tempRoot = os.tmpdir();
  const scratchPrefixes = ['iexa-'];
  const existingScratch = new Set(
    fs.readdirSync(tempRoot).filter((name) => scratchPrefixes.some((prefix) => name.startsWith(prefix))),
  );
  const sweepScratch = () => {
    let removed = 0;
    for (const name of fs.readdirSync(tempRoot)) {
      if (existingScratch.has(name)) continue;
      if (!scratchPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      try {
        fs.rmSync(path.join(tempRoot, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
        removed += 1;
      } catch { /* another process still holds it; leave it for the next run */ }
    }
    if (removed) console.log(`[tests] swept ${removed} scratch director${removed === 1 ? 'y' : 'ies'}`);
  };

  // One Chrome for every browser test in this run: each test still gets its own
  // tab on its own port, so origin-scoped state stays isolated, but the ~2 s cold
  // start is paid once instead of 52 times.
  //
  // It is started lazily, right before the browser pass. Booting it up front left
  // an idle renderer parked through the whole ~70 s plain pass; Chrome then froze
  // the tab and the first navigation could miss its state deadlines.
  let shared = null;
  const env = { ...process.env };
  const startBrowser = async () => {
    if (shared || has('--no-shared-browser')) return;
    const { startSharedChrome } = require(path.join(root, 'tests', 'helpers', 'shared-chrome.js'));
    shared = await startSharedChrome();
    env.IEXA_TEST_CDP_HTTP = shared.http;
    console.log(`[tests] shared Chrome at ${shared.http}`);
  };

  // Three passes, most to least CPU-sensitive. Browser tests wait on real
  // timers and real rendering, so running them beside a CPU-bound unit test
  // (streaming benchmarks, transcript simulations) makes them flap: the page
  // misses its own deadline and a 30 s wait expires. Electron comes last for
  // the same reason it always did.
  const electronFiles = files.filter((file) => path.basename(file).startsWith('electron-'));
  const browserFiles = files.filter((file) => !electronFiles.includes(file) && path.basename(file).startsWith('browser-'));
  const plainFiles = files.filter((file) => !electronFiles.includes(file) && !browserFiles.includes(file));

  const runPass = (subset, passConcurrency = concurrency) => {
    if (!subset.length) return 0;
    // spawnSync blocks forever if a test leaves a socket open against the shared
    // Chrome; the run then looks hung with no output. A hard ceiling turns that
    // into a failure with an explicit exit code.
    const watchdogMs = Number(value('--watchdog-minutes', '20')) * 60_000;
    const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${passConcurrency}`, ...subset], {
      cwd: root,
      stdio: 'inherit',
      env,
      timeout: watchdogMs,
      killSignal: 'SIGKILL',
    });
    if (result.error && result.error.code === 'ETIMEDOUT') {
      console.error(`[tests] watchdog fired after ${watchdogMs / 60000} min — a test left a socket open`);
      return 124;
    }
    return result.status ?? 1;
  };

  let status = 0;
  try {
    const plainStatus = runPass(plainFiles);
    if (plainStatus !== 0) status = plainStatus;
    await startBrowser();
    const browserStatus = runPass(browserFiles, '1');
    if (browserStatus !== 0) status = browserStatus;
    if (shared) { await shared.stop(); shared = null; }
    const electronStatus = runPass(electronFiles);
    if (electronStatus !== 0) status = electronStatus;
  } finally {
    if (shared) await shared.stop();
    sweepScratch();
  }
  console.log(`[tests] ${((Date.now() - started) / 1000).toFixed(1)}s, exit ${status}`);
  process.exit(status);
}

main().catch((error) => { console.error(error); process.exit(1); });
