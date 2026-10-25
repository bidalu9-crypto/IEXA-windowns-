#!/usr/bin/env node
/**
 * Reclaim space in %TEMP% from this project's own scratch data.
 *
 * Why this exists: the portable exe extracts the whole app (~690 MB) into
 * %TEMP% on every launch and deletes it on a normal exit — but a killed process
 * leaves the folder behind. The browser tests do the same on a smaller scale:
 * each one creates a Chrome profile, and Windows keeps a handle on it for a
 * moment after the test ends, so `rmSync` fails silently.
 *
 * Only prefixes this project creates are touched. Anything younger than the
 * minimum age is skipped, so a running test or a live portable launch is never
 * disturbed.
 *
 * Usage:
 *   node scripts/clean-temp.cjs [--dry-run] [--min-age-minutes 60]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Every pattern here is something this repository creates. */
const OWNED = [
  /^ns[A-Za-z0-9]+\.tmp$/,        // electron-builder portable/NSIS extraction
  /^iexa-/,                        // browser-test scratch directories
  /^pm-(probe|diag)-/,             // process-manager probes
  /^tk-/,                          // taskkill spawn probes
  /^clawhud-profile-/,             // image generator profile
  /^om$/,                          // OpenMinis checkout used for research
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ageIndex = args.indexOf('--min-age-minutes');
const minAgeMinutes = ageIndex >= 0 ? Number(args[ageIndex + 1]) || 60 : 60;

const root = os.tmpdir();
const cutoff = Date.now() - minAgeMinutes * 60_000;
const freed = [];
const skipped = [];

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!OWNED.some((pattern) => pattern.test(entry.name))) continue;
  const full = path.join(root, entry.name);
  let stat;
  try { stat = fs.statSync(full); } catch { continue; }
  if (stat.mtimeMs > cutoff) { skipped.push(entry.name); continue; }
  let bytes = 0;
  try {
    if (stat.isDirectory()) {
      const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const next = path.join(dir, item.name);
          try {
            if (item.isDirectory()) walk(next);
            else bytes += fs.statSync(next).size;
          } catch { /* vanished mid-walk */ }
        }
      };
      walk(full);
    } else {
      bytes = stat.size;
    }
  } catch { /* unreadable */ }
  if (!dryRun) {
    try { fs.rmSync(full, { recursive: true, force: true }); } catch { skipped.push(entry.name); continue; }
  }
  freed.push({ name: entry.name, bytes });
}

const total = freed.reduce((sum, item) => sum + item.bytes, 0);
const mb = (value) => (value / 1024 / 1024).toFixed(1) + ' MB';
console.log(`${dryRun ? 'would free' : 'freed'} ${mb(total)} across ${freed.length} item(s)`);
for (const item of freed.slice(0, 10)) console.log(`  ${mb(item.bytes).padStart(10)}  ${item.name}`);
if (freed.length > 10) console.log(`  … and ${freed.length - 10} more`);
if (skipped.length) console.log(`skipped ${skipped.length} item(s) (in use or newer than ${minAgeMinutes} min)`);
