'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { processIdentity, sameProcess, recordLifetime, descendants, terminationScript } = require('./owned-processes.cjs');
const { LIMITS, readSystemSnapshot, systemBudgetError, summarizeSystem } = require('./system-budget.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processTable() {
  const observedAt = new Date().toISOString(), rows = (await readSystemSnapshot()).processes;
  Object.defineProperty(rows, 'observedAt', { value: observedAt });
  return rows;
}

// A fixed list becoming empty is insufficient: a terminating app can create
// another child. Rebuild the proven tree after EVERY batch, then require a
// quiet interval. Dependencies are injectable for deterministic race tests.
async function settleOwnedProcesses({ readRows, collect, terminate, now = Date.now, pause = wait, quietMs = 1200, timeoutMs = 20000 }) {
  const until = now() + timeoutMs;
  let quietSince = null, remaining = [];
  for (;;) {
    remaining = collect(await readRows());
    if (remaining.length) { quietSince = null; await terminate(remaining); }
    else {
      if (quietSince === null) quietSince = now();
      if (now() - quietSince >= quietMs) return { remaining: [], quiet: true };
    }
    if (now() >= until) return { remaining, quiet: false };
    await pause(100);
  }
}

function budgetError(rss, free, hasProcesses = true) {
  if (!hasProcesses || !Number.isFinite(rss) || rss <= 0) return 'Owned process resource sample is empty or has zero RSS';
  if (!Number.isFinite(free) || free < 0) return 'Machine free memory sample is invalid';
  if (rss > 1.2 * 1024 ** 3) return 'Owned RSS exceeded 1.2 GiB';
  if (free < 4 * 1024 ** 3) return 'Machine free memory fell below 4 GiB';
  return '';
}

// Observing a related application is resource accounting, never ownership.
// DCOM/Explorer can start a process outside our proven parent tree. Count it
// once, retain its exact identity, and report new survivors without killing it.
function observedProcessAccounting(rows, ownedRows, observeProcess, baseline = new Map()) {
  const owned = new Map(ownedRows.map(row => [processIdentity(row), row]));
  const observed = new Map();
  if (observeProcess) for (const row of rows) {
    if (!observeProcess(row)) continue;
    const identity = processIdentity(row);
    if (!identity) throw Error('Observed application has no exact process identity');
    if (!owned.has(identity)) observed.set(identity, row);
  }
  const ownedRss = [...owned.values()].reduce((sum, row) => sum + Number(row.WorkingSetSize || 0), 0);
  const newObserved = [...observed].filter(([identity]) => !baseline.has(identity)).map(([, row]) => row);
  const baselineRows = [...observed].filter(([identity]) => baseline.has(identity));
  const newObservedRss = newObserved.reduce((sum, row) => sum + Number(row.WorkingSetSize || 0), 0);
  const baselineObservedRss = baselineRows.reduce((sum, [, row]) => sum + Number(row.WorkingSetSize || 0), 0);
  // Pre-existing servers remain outside the workload. Count only their positive
  // growth, plus the full RSS of newly observed related processes.
  const baselineGrowthRss = baselineRows.reduce((sum, [identity, row]) => sum + Math.max(0, Number(row.WorkingSetSize || 0) - Number(baseline.get(identity)?.rss || 0)), 0);
  const observedRss = newObservedRss + baselineGrowthRss;
  return { ownedRss, observedRss, newObservedRss, baselineObservedRss, baselineGrowthRss, rss: ownedRss + observedRss,
    observed: [...observed.values()],
    newObserved };
}

function observedProcessRecord(row) {
  return { identity: processIdentity(row), pid: row.ProcessId, parent: row.ParentProcessId,
    created: row.CreationDate, name: row.Name, rss: Number(row.WorkingSetSize || 0) };
}

function createSupervisor(options) {
  const output = path.resolve(options.output), known = new Map(), roots = new Map(), samples = [], errors = [];
  const lifetimes = new Map(), unproven = new Map(), uncertainHistory = new Map(), cleanupBatches = [];
  if (options.observeProcess !== undefined && typeof options.observeProcess !== 'function') throw TypeError('observeProcess must be a function');
  const baselineObserved = new Map(), observedHistory = new Map();
  let newObservedSurvivors = [], baselineObservedSurvivors = [];
  const maximumDurationMs = Number(options.maximumDurationMs || 300000);
  if (!Number.isFinite(maximumDurationMs) || maximumDurationMs < 30000 || maximumDurationMs > 600000) {
    throw Error('Acceptance timeout must be between 30000 and 600000 ms');
  }
  let interval, deadline, pending, stopping, stopReason = '', closed = false;
  let rejectFailure;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  function save() {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'resource-watchdog.json'), JSON.stringify({
      maximumDurationMs, rssLimitBytes: 1.2 * 1024 ** 3, minimumFreeBytes: 4 * 1024 ** 3, systemLimits: LIMITS,
      stopReason, samples, owned: [...known.values()], lifetimes: [...lifetimes.values()],
      baselineObservedProcesses: [...baselineObserved.values()], observedProcesses: [...observedHistory.values()], newObservedSurvivors, baselineObservedSurvivors,
      unprovenLateDescendants: [...unproven.values()], uncertainHistory: [...uncertainHistory.values()], cleanupBatches, cleanupErrors: errors,
    }, null, 2));
  }
  function owned(rows, observedAt = rows.observedAt) {
    const result = new Map();
    unproven.clear();
    for (const { identity } of roots.values()) for (const row of descendants(rows, identity, known, { lifetimes, observedAt, unproven, uncertainHistory })) result.set(processIdentity(row), row);
    for (const identity of result.keys()) unproven.delete(identity);
    return [...result.values()];
  }
  async function terminate(identities) {
    identities = [...new Map(identities.map(row => [processIdentity(row), row])).values()];
    if (!identities.length) return [];
    if (identities.some(row => !processIdentity(row) || !known.has(processIdentity(row)))) throw Error('Cleanup attempted an unowned process identity');
    const stdout = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', terminationScript(identities)],
      { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const batch = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!Array.isArray(batch.Lifetimes) || !Array.isArray(batch.Errors)) throw Error('Exact-handle cleanup returned invalid evidence');
    for (const evidence of batch.Lifetimes) {
      const identity = processIdentity(evidence), row = known.get(identity);
      if (!row) throw Error('Cleanup returned an unowned process identity');
      recordLifetime(lifetimes, row, evidence.LastSeenAt, evidence.ExitedAt);
    }
    cleanupBatches.push({ at: Date.now(), targets: identities.map(processIdentity), ...batch });
    errors.push(...batch.Errors);
    const rows = await processTable(); owned(rows);
    return rows.filter(row => identities.some(expected => sameProcess(row, expected)));
  }
  async function cleanup() {
    const result = await settleOwnedProcesses({ readRows: processTable, collect: owned, terminate });
    if (!result.quiet) errors.push('Cleanup failed to reach a quiet process tree within 20000 ms');
    if (unproven.size) errors.push('Cleanup has late descendants without exact parent lifetime proof: ' + [...unproven.keys()].join(', '));
    return result.remaining;
  }
  function stop(reason) {
    if (stopping) return stopping;
    stopReason = reason; options.onStop?.(reason); save();
    stopping = (async () => {
      try { const remaining = await cleanup(); if (remaining.length) errors.push('Cleanup left identities: ' + remaining.map(processIdentity).join(', ')); }
      catch (error) { errors.push(error.message); }
      finally { save(); rejectFailure(Error(stopReason)); }
    })();
    return stopping;
  }
  async function sample() {
    if (closed || stopReason) return;
    try {
      const observedAt = new Date().toISOString(), snapshot = await readSystemSnapshot(), rows = snapshot.processes, tree = owned(rows, observedAt);
      const accounting = observedProcessAccounting(rows, tree, options.observeProcess, baselineObserved);
      for (const row of accounting.observed) observedHistory.set(processIdentity(row), observedProcessRecord(row));
      // A normal app exit can precede the completion of its inspector call.
      if (!tree.length && !accounting.observed.length && [...roots.values()].every(({ child }) => child.exitCode !== null || child.signalCode !== null)) return;
      const { rss, ownedRss, observedRss, newObservedRss, baselineObservedRss, baselineGrowthRss } = accounting, free = os.freemem();
      samples.push({ at: Date.now(), rss, ownedRss, observedRss, newObservedRss, baselineObservedRss, baselineGrowthRss, observedProcesses: accounting.observed.map(observedProcessRecord), free, system: summarizeSystem(snapshot), processes: tree.map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId,
        created: row.CreationDate, name: row.Name, rss: Number(row.WorkingSetSize || 0), cpu100ns: Number(row.UserModeTime || 0) + Number(row.KernelModeTime || 0), command: row.CommandLine })) });
      save();
      const reason = systemBudgetError(snapshot) || (tree.length || accounting.newObserved.length || accounting.baselineGrowthRss > 0 ? budgetError(rss, free, true) : '');
      if (reason) await stop(reason);
      else if (tree.some(row => /codeoss[\\/].*(?:server-main|node\.exe)|codeoss.*extensionHost/i.test(row.CommandLine || ''))) await stop('Unexpected full IDE kernel process');
    } catch (error) { samples.push({ at: Date.now(), sampleError: error.message }); await stop('Resource sampling failed: ' + error.message); }
  }
  async function begin() {
    const snapshot = await readSystemSnapshot(), reason = systemBudgetError(snapshot);
    const accounting = observedProcessAccounting(snapshot.processes, [], options.observeProcess);
    for (const row of accounting.observed) baselineObserved.set(processIdentity(row), observedProcessRecord(row));
    samples.push({ at: Date.now(), preflight: true, baselineObservedRss: accounting.observedRss, observedProcesses: [...baselineObserved.values()], system: summarizeSystem(snapshot) }); save();
    if (reason) throw Error(reason);
    deadline = setTimeout(() => { void stop('Acceptance exceeded ' + maximumDurationMs + ' ms'); }, maximumDurationMs);
    save();
  }
  async function claimSpawn(child, marker, started) {
    const rows = await processTable();
    const identity = rows.find(row => row.ProcessId === child.pid && row.ParentProcessId === process.pid &&
      Date.parse(row.CreationDate) >= started && String(row.CommandLine || '').includes(marker));
    if (!processIdentity(identity)) throw Error('Spawned process identity could not be verified: ' + child.pid);
    roots.set(processIdentity(identity), { identity, child }); known.set(processIdentity(identity), identity); owned(rows); save();
    await sample();
    if (stopReason) throw Error(stopReason);
    if (!interval) interval = setInterval(() => {
      if (!pending) pending = sample().finally(() => { pending = null; });
    }, 2500);
    return identity;
  }
  async function claimFixture(pids, marker) {
    const rows = await processTable(), tree = owned(rows), identities = [];
    for (const pid of pids) {
      const identity = tree.find(row => row.ProcessId === pid && String(row.CommandLine || '').includes(marker));
      if (!processIdentity(identity)) throw Error('Fixture process is outside the owned application tree or has an unexpected command: ' + pid);
      identities.push(identity);
    }
    save(); return identities;
  }
  async function living(identities) { const rows = await processTable(); return identities.filter(expected => rows.some(row => sameProcess(row, expected))); }
  async function finish() {
    closed = true; clearInterval(interval); clearTimeout(deadline); if (pending) await pending; if (stopping) await stopping;
    let survivorsBeforeCleanup = [], survivorsAfterCleanup = [];
    try {
      const until = Date.now() + 2500;
      do { survivorsBeforeCleanup = owned(await processTable()); if (!survivorsBeforeCleanup.length || Date.now() >= until) break; await wait(150); } while (Date.now() < until);
      survivorsAfterCleanup = await cleanup();
    } catch (error) { errors.push(error.message); }
    if (options.observeProcess) try {
      const rows = await processTable(), tree = rows.filter(row => known.has(processIdentity(row)));
      // This read-only audit must not register extra ownership or schedule kills.
      // A previously proven process still alive after cleanup remains a failure.
      survivorsAfterCleanup = [...new Map([...survivorsAfterCleanup, ...tree].map(row => [processIdentity(row), row])).values()];
      const accounting = observedProcessAccounting(rows, tree, options.observeProcess, baselineObserved);
      for (const row of accounting.observed) observedHistory.set(processIdentity(row), observedProcessRecord(row));
      newObservedSurvivors = accounting.newObserved.map(observedProcessRecord);
      baselineObservedSurvivors = accounting.observed.filter(row => baselineObserved.has(processIdentity(row))).map(observedProcessRecord);
      if (newObservedSurvivors.length) errors.push('New observed application processes remain outside the proven ownership tree: ' + newObservedSurvivors.map(row => row.identity).join(', '));
    } catch (error) { errors.push('Observed application final audit failed: ' + error.message); }
    save();
    const result = { stopReason, peakRss: Math.max(0, ...samples.map(item => item.rss || 0)),
      peakOwnedRss: Math.max(0, ...samples.map(item => item.ownedRss || 0)), peakObservedRss: Math.max(0, ...samples.map(item => item.observedRss || 0)),
      baselineObservedProcesses: [...baselineObserved.values()], observedProcesses: [...observedHistory.values()], newObservedSurvivors, baselineObservedSurvivors,
      sampleCount: samples.length, maximumDurationMs, ownedIdentities: [...known.keys()],
      fixtureCleanupAllowed: options.allowFixtureCleanup === true,
      cleanupWarnings: cleanupBatches.flatMap(batch => batch.Warnings || []),
      survivorsBeforeCleanup: survivorsBeforeCleanup.map(processIdentity), survivorsAfterCleanup: survivorsAfterCleanup.map(processIdentity),
      unprovenLateDescendants: [...unproven.keys()], cleanupErrors: errors };
    fs.writeFileSync(path.join(output, 'process-cleanup.json'), JSON.stringify(result, null, 2));
    if (stopReason || errors.length || (survivorsBeforeCleanup.length && options.allowFixtureCleanup !== true) || survivorsAfterCleanup.length || roots.size && !result.peakRss) {
      throw Error('Acceptance process/resource verification failed: ' + JSON.stringify(result));
    }
    return result;
  }
  return { begin, claimSpawn, claimFixture, living, terminate, finish, failure };
}

module.exports = { processTable, budgetError, settleOwnedProcesses, observedProcessAccounting, createSupervisor };
