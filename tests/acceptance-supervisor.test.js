'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settleOwnedProcesses, processTable, observedProcessAccounting } = require('../scripts/helpers/acceptance-supervisor.cjs');
const { processIdentity, sameProcess, descendants, recordLifetime, terminationScript } = require('../scripts/helpers/owned-processes.cjs');
const row = (pid, parent, second) => ({ ProcessId: pid, ParentProcessId: parent,
  CreationDate: `2026-11-09T03:00:${String(second).padStart(2, '0')}.0000000Z`, WorkingSetSize: 100 });

test('observed resource accounting counts related processes once without granting ownership', () => {
  const root = { ...row(10, 1, 10), Name: 'host.exe' }, ownedApp = { ...row(11, 10, 11), Name: 'wps.exe' };
  const external = { ...row(12, 1, 12), Name: 'wps.exe' }, unrelated = { ...row(13, 1, 13), Name: 'editor.exe' };
  const known = new Map([root, ownedApp].map(item => [processIdentity(item), Object.freeze(item)]));
  const roots = new Map([[processIdentity(root), root]]), beforeKnown = [...known], beforeRoots = [...roots];
  const result = observedProcessAccounting([root, ownedApp, external, external, unrelated], [...known.values()], item => item.Name === 'wps.exe');
  assert.equal(result.ownedRss, 200);
  assert.equal(result.observedRss, 100);
  assert.equal(result.rss, 300);
  assert.deepEqual(result.newObserved, [external]);
  assert.deepEqual([...known], beforeKnown);
  assert.deepEqual([...roots], beforeRoots);
  assert.equal(known.has(processIdentity(external)), false);
});

test('observed baseline charges only positive growth and distinguishes recycled PIDs', () => {
  const previous = { ...row(11, 1, 11), Name: 'wps.exe' }, previousOther = { ...row(12, 1, 12), Name: 'wps.exe' };
  const baseline = new Map([previous, previousOther].map(item => [processIdentity(item), { rss: 100 }]));
  const growing = { ...previous, WorkingSetSize: 140 }, replacement = { ...row(12, 1, 20), Name: 'wps.exe', WorkingSetSize: 200 };
  const result = observedProcessAccounting([growing, replacement], [], () => true, baseline);
  assert.equal(result.baselineObservedRss, 140);
  assert.equal(result.baselineGrowthRss, 40);
  assert.equal(result.newObservedRss, 200);
  assert.equal(result.rss, 240);
  assert.deepEqual(result.newObserved, [replacement]);
  assert.equal(baseline.size, 2);
  const shrinking = observedProcessAccounting([{ ...previous, WorkingSetSize: 20 }], [], () => true, baseline);
  assert.equal(shrinking.baselineObservedRss, 20);
  assert.equal(shrinking.baselineGrowthRss, 0);
  assert.equal(shrinking.rss, 0);
  assert.deepEqual(shrinking.newObserved, []);
});

test('observed monitoring is opt-in and rejects ambiguous matched identities', () => {
  const own = row(10, 1, 10), extra = row(11, 1, 11);
  assert.equal(observedProcessAccounting([own, extra], [own]).rss, 100);
  assert.deepEqual(observedProcessAccounting([own, extra], [own]).observed, []);
  assert.throws(() => observedProcessAccounting([{ ...extra, CreationDate: '' }], [], () => true), /exact process identity/);
});

test('cleanup rediscovers late WPS-style children after a parent is killed and waits through empty samples', async () => {
  const root = row(10, 1, 10), server = row(11, 10, 11), late = row(12, 11, 13), grandchild = row(13, 12, 16);
  const unrelated = row(11, 99, 20), userChild = row(99, 11, 21);
  const snapshots = [[root, server], [late], [], [grandchild], [], [], [], []];
  const known = new Map(), lifetimes = new Map(), unproven = new Map(), killed = [];
  let clock = 0, sample = 0;
  const result = await settleOwnedProcesses({
    now: () => clock, pause: async ms => { clock += ms; }, quietMs: 250, timeoutMs: 3000,
    readRows: async () => { const rows = [...(snapshots[sample++] || []), ...(sample > 1 ? [unrelated, userChild] : [])]; rows.observedAt = row(1, 1, 12).CreationDate; return rows; },
    collect: rows => { unproven.clear(); return descendants(rows, root, known, { lifetimes, observedAt: rows.observedAt, unproven }); },
    terminate: async rows => {
      killed.push(rows.map(p => p.ProcessId));
      for (const item of rows) recordLifetime(lifetimes, item, item.CreationDate,
        row(1, 1, item.ProcessId === 11 ? 15 : item.ProcessId === 12 ? 18 : 19).CreationDate);
    },
  });
  assert.equal(result.quiet, true);
  assert.deepEqual(killed, [[10, 11], [12], [13]]);
  assert.equal(unproven.size, 0);
  assert.ok(sample >= 7, 'one empty snapshot cannot finish cleanup before the late grandchild appears');
  assert.equal(known.has(processIdentity(unrelated)), false, 'the recycled parent PID remains untouched');
  assert.equal(known.has(processIdentity(userChild)), false, 'another user subtree remains untouched');
});

test('cleanup reports an unresolved identity without extending historical PPID ownership', async () => {
  const root = row(10, 1, 10), late = row(12, 10, 15), known = new Map(), lifetimes = new Map(), unproven = new Map();
  descendants([root], root, known, { lifetimes, observedAt: row(1, 1, 12).CreationDate });
  let clock = 0, killed = 0;
  const result = await settleOwnedProcesses({
    now: () => clock, pause: async ms => { clock += ms; }, quietMs: 200,
    readRows: async () => [late],
    collect: rows => { unproven.clear(); return descendants(rows, root, known, { lifetimes, unproven }); },
    terminate: async () => { killed++; },
  });
  assert.equal(result.quiet, true);
  assert.equal(killed, 0);
  assert.ok(unproven.has(processIdentity(late)), 'supervisor must fail with this unresolved identity evidence');
  assert.equal(known.has(processIdentity(late)), false);
});

test('cleanup has a bounded deadline and returns the actual surviving identities', async () => {
  const root = row(10, 1, 10);
  let clock = 0, attempts = 0;
  const result = await settleOwnedProcesses({
    now: () => clock, pause: async ms => { clock += ms; }, timeoutMs: 300,
    readRows: async () => [root], collect: rows => rows, terminate: async () => { attempts++; },
  });
  assert.equal(result.quiet, false);
  assert.deepEqual(result.remaining, [root]);
  assert.equal(attempts, 4);
});

// Compiles the actual embedded C# cleanup code and only starts headless Node
// fixtures. A second, unrelated fixture is intentionally alive throughout.
test('Windows cleanup uses exact handles and a Job without touching an unrelated process',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const { spawn, execFile } = require('node:child_process');
    const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    const untouched = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    const known = new Map(), lifetimes = new Map();
    const execute = script => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout.replace(/^\uFEFF/, '')))));
    let first, other;
    t.after(async () => {
      try {
        const rows = await processTable();
        const own = [first, other].filter(Boolean).filter(expected => rows.some(item => sameProcess(item, expected)));
        if (own.length) await execute(terminationScript(own));
      } finally {
        // These are this test's ChildProcess handles, not arbitrary sampled PIDs.
        if (root.exitCode === null && root.signalCode === null) root.kill();
        if (untouched.exitCode === null && untouched.signalCode === null) untouched.kill();
      }
    });
    const rows = await processTable();
    first = rows.find(item => item.ProcessId === root.pid && item.ParentProcessId === process.pid);
    other = rows.find(item => item.ProcessId === untouched.pid && item.ParentProcessId === process.pid);
    assert.ok(processIdentity(first)); assert.ok(processIdentity(other));
    known.set(processIdentity(first), first);
    const stale = { ...first, CreationDate: '2026-01-01T00:00:00.0000000Z' };
    const skipped = await execute(terminationScript([stale]));
    assert.equal(skipped.Lifetimes.length, 0, 'a reused PID with the wrong timestamp is never assigned to the Job');
    const batch = await execute(terminationScript([first]));
    assert.deepEqual(batch.Errors, []);
    assert.equal(batch.Lifetimes.length, 1);
    assert.equal(batch.Lifetimes[0].JobAssigned, true);
    const delta = require('../scripts/helpers/owned-processes.cjs').timestampTicks(batch.Lifetimes[0].HandleCreationDate)
      - require('../scripts/helpers/owned-processes.cjs').timestampTicks(first.CreationDate);
    assert.ok(delta >= 0n && delta <= 9n, 'the exact handle agrees with the CIM microsecond bin, without millisecond tolerance');
    assert.ok(batch.Lifetimes[0].ExitedAt, 'a retained exact process handle provides the exit timestamp');
    recordLifetime(lifetimes, first, batch.Lifetimes[0].LastSeenAt, batch.Lifetimes[0].ExitedAt);
    const after = await processTable();
    assert.equal(after.some(item => sameProcess(item, first)), false);
    assert.equal(after.some(item => sameProcess(item, other)), true, 'another user process remains alive');
    assert.ok(lifetimes.get(processIdentity(first)).exitedAt);
    // Exercise the real same-handle fallback used by CEF/WPS workers that
    // refuse another Job. Fault injection affects only the Job assignment,
    // while real identity checking, TerminateProcess and exit proof still run.
    const deniedScript = terminationScript([other]).replace('job != IntPtr.Zero && AssignProcessToJobObject(job, handle)', 'pids.Length < 0');
    assert.notEqual(deniedScript, terminationScript([other]));
    const fallback = await execute(deniedScript);
    assert.deepEqual(fallback.Errors, []);
    assert.equal(fallback.Warnings.length, 1);
    assert.equal(fallback.Lifetimes[0].JobAssigned, false);
    assert.equal(fallback.Lifetimes[0].ExactHandleTerminated, true);
    assert.ok(fallback.Lifetimes[0].ExitedAt);
    assert.equal((await processTable()).some(item => sameProcess(item, other)), false);
  });
