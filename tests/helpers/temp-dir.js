/**
 * Every scratch directory the suite creates, in one place.
 *
 * Tests that called `fs.mkdtempSync` directly leaked a 12–24 MB Chrome profile
 * per run: `node --test` gives each file its own process, and a failing
 * assertion skips the `t.after` hook that was supposed to delete it. This
 * module registers each root as it is made and sweeps them from the process
 * exit hook, so a crash cannot leave anything behind. The runner keeps its own
 * sweep as a second net for processes that get SIGKILLed.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = new Set();

/** Delete one root, retrying through the brief Windows handle release. */
function remove(dir) {
  if (!dir) return;
  created.delete(dir);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch {
      // A browser subprocess may still hold a handle; try again shortly.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
}

/** Create a scratch root under the OS temp directory and track it. */
function make(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}

function sweepAll() {
  for (const dir of [...created]) remove(dir);
}

process.on('exit', sweepAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { sweepAll(); process.exit(130); });
}

module.exports = { make, remove, sweepAll, created };
