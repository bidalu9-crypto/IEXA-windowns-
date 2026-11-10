'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { processIdentity, sameProcess, timestampTicks, recordLifetime, descendants, terminationScript } = require('../scripts/helpers/owned-processes.cjs');
const { budgetError } = require('../scripts/helpers/acceptance-supervisor.cjs');
const row = (pid, parent, second, rss = 100) => ({ ProcessId: pid, ParentProcessId: parent,
  CreationDate: `2026-11-09T03:00:${String(second).padStart(2, '0')}.0000000Z`, WorkingSetSize: rss });

test('process ownership requires a creation timestamp and rejects a bare PID', () => {
  assert.equal(processIdentity(12), '');
  assert.equal(sameProcess(row(12, 1, 2), row(12, 1, 3)), false);
  assert.throws(() => descendants([], 12), /verified PID/);
  assert.throws(() => terminationScript([12]), /verified process/);
});

test('resource sampling collects a real root and descendants with nonzero memory', () => {
  const root = row(10, 1, 10, 200), child = row(11, 10, 11, 300), grandchild = row(12, 11, 12, 400);
  const known = new Map(), tree = descendants([grandchild, child, root, row(99, 1, 1, 9000)], root, known);
  assert.deepEqual(tree.map(item => item.ProcessId).sort(), [10, 11, 12]);
  assert.equal(tree.reduce((sum, item) => sum + item.WorkingSetSize, 0), 900);
  assert.equal(known.size, 3);
  assert.ok(known.has(processIdentity(child)));
});

test('a reused root PID does not claim older orphans or a new unrelated process', () => {
  const root = row(10, 1, 10), known = new Map();
  assert.deepEqual(descendants([root, row(20, 10, 9)], root, known).map(item => item.ProcessId), [10]);
  assert.deepEqual(descendants([row(10, 1, 20), row(21, 10, 21)], root, known), []);
});

test('known child identities remain owned after the root exits, without claiming a recycled child PID', () => {
  const root = row(10, 1, 10), child = row(11, 10, 11), known = new Map();
  descendants([root, child], root, known);
  assert.deepEqual(descendants([child, row(12, 11, 12)], root, known).map(item => item.ProcessId).sort(), [11, 12]);
  assert.deepEqual(descendants([row(11, 99, 20), row(13, 11, 21)], root, known), []);
});

test('termination checks each exact creation timestamp and never uses a PID-only process-tree kill', () => {
  const script = terminationScript([row(10, 1, 10), row(11, 10, 11)]);
  assert.ok(script.indexOf('processId=11') < script.indexOf('processId=10'));
  assert.match(script, /GetProcessTimes\(handle/);
  assert.match(script, /var difference = actual\.Ticks - expected\.Ticks/);
  assert.match(script, /difference < 0 \|\| difference > 9/);
  assert.match(script, /AssignProcessToJobObject\(job, handle\)/);
  assert.match(script, /TerminateJobObject\(job, 1\)/);
  assert.match(script, /TerminateProcess\(target\.Handle, 1\)/);
  assert.match(script, /KILL_ON_JOB_CLOSE/);
  assert.doesNotMatch(script, /Stop-Process\s+-Id/);
  assert.doesNotMatch(script, /taskkill|\/T\b|Code\.exe/i);
});

test('late children are owned only within a proven exact parent lifetime, with 100ns precision', () => {
  const root = row(10, 1, 10), parent = row(11, 10, 11), known = new Map(), lifetimes = new Map();
  const options = { lifetimes, observedAt: row(1, 1, 14).CreationDate, unproven: new Map() };
  descendants([root, parent], root, known, options);
  const bornWhileAlive = row(12, 11, 13);
  assert.deepEqual(descendants([bornWhileAlive], root, known, options).map(p => p.ProcessId), [12]);
  const duringCleanup = row(13, 11, 15);
  options.unproven.clear();
  assert.deepEqual(descendants([duringCleanup], root, known, options), []);
  assert.ok(options.unproven.has(processIdentity(duringCleanup)), 'an unsupported historical PPID is reported, not killed');
  recordLifetime(lifetimes, parent, '2026-11-09T03:00:15.0000000Z', '2026-11-09T03:00:15.0000001Z');
  assert.deepEqual(descendants([duringCleanup], root, known, options).map(p => p.ProcessId), [13]);
  const afterExit = { ...row(14, 11, 15), CreationDate: '2026-11-09T03:00:15.0000002Z' };
  options.unproven.clear();
  assert.deepEqual(descendants([afterExit], root, known, options), []);
  assert.equal(options.unproven.size, 0, 'a child born after the exact parent exit belongs to another incarnation');
  assert.equal(timestampTicks(afterExit.CreationDate) - timestampTicks(duringCleanup.CreationDate), 2n);
});

test('a late orphan can precede a recycled parent PID but never inherit the recycled lifetime', () => {
  const root = row(10, 1, 10), parent = row(11, 10, 11), known = new Map(), lifetimes = new Map();
  const options = { lifetimes, observedAt: row(1, 1, 16).CreationDate, unproven: new Map() };
  descendants([root, parent], root, known, options);
  recordLifetime(lifetimes, parent, row(1, 1, 16).CreationDate, row(1, 1, 17).CreationDate);
  const recycled = row(11, 99, 20), orphan = row(12, 11, 15), unrelated = row(13, 11, 21);
  assert.deepEqual(descendants([recycled, unrelated, orphan], root, known, options).map(p => p.ProcessId), [12]);
  assert.equal(options.unproven.size, 0);
  assert.equal(known.has(processIdentity(recycled)), false);
  assert.equal(known.has(processIdentity(unrelated)), false);
});

test('query start bounds lifetime proof and mixed timestamp precision compares correctly', () => {
  const root = row(10, 1, 10), known = new Map(), lifetimes = new Map();
  const options = { lifetimes, observedAt: '2026-11-09T03:00:12.123Z', unproven: new Map() };
  descendants([root], root, known, options);
  const before = { ...row(11, 10, 12), CreationDate: '2026-11-09T03:00:12.1230000Z' };
  const after = { ...row(12, 10, 12), CreationDate: '2026-11-09T03:00:12.1230001Z' };
  assert.deepEqual(descendants([before, after], root, known, options).map(p => p.ProcessId), [11]);
  assert.ok(options.unproven.has(processIdentity(after)));
  assert.equal(timestampTicks(options.observedAt), timestampTicks(before.CreationDate));
});

test('uncertain lineage survives an uncertain parent exit without authorizing any termination', () => {
  const root = row(10, 1, 10), known = new Map(), lifetimes = new Map(), unproven = new Map(), uncertainHistory = new Map();
  const options = { lifetimes, unproven, uncertainHistory, observedAt: row(1, 1, 12).CreationDate };
  descendants([root], root, known, options);
  const uncertain = row(20, 10, 15), child = row(21, 20, 16), grandchild = row(22, 21, 18);
  assert.deepEqual(descendants([child, uncertain], root, known, options), []);
  assert.deepEqual([...unproven.values()].map(p => p.ProcessId).sort(), [20, 21]);
  unproven.clear();
  assert.deepEqual(descendants([grandchild, child], root, known, options), []);
  assert.deepEqual([...unproven.values()].map(p => p.ProcessId).sort(), [21, 22]);
  assert.equal(known.size, 1);
  assert.ok(uncertainHistory.has(processIdentity(uncertain)), 'the exited uncertain parent remains an audit fact');
  unproven.clear();
  const reused = row(20, 99, 25), unrelated = row(23, 20, 26);
  assert.deepEqual(descendants([reused, unrelated], root, known, options), []);
  assert.equal(unproven.size, 0, 'PID reuse does not inherit uncertainty from an old identity');
});

test('acceptance budgets fail on missing samples, excess owned memory and low machine memory', () => {
  const gib = 1024 ** 3;
  assert.equal(budgetError(1.2 * gib, 4 * gib), '');
  assert.match(budgetError(0, 8 * gib), /zero RSS/);
  assert.match(budgetError(gib, 8 * gib, false), /empty/);
  assert.match(budgetError(1.2 * gib + 1, 8 * gib), /1.2 GiB/);
  assert.match(budgetError(gib, 4 * gib - 1), /4 GiB/);
  assert.match(budgetError(gib, NaN), /invalid/);
});
