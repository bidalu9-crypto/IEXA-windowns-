'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemBudgetError, summarizeSystem } = require('../scripts/helpers/system-budget.cjs');
const GiB = 1024 ** 3;
const snapshot = (used = 10, free = 24, processes = []) => ({ memory: { CommittedBytes: used * GiB, CommitLimit: 40 * GiB, AvailableBytes: free * GiB }, processes });

test('global commit pressure stops work even while physical memory remains available', () => {
  assert.equal(systemBudgetError(snapshot()), '');
  assert.match(systemBudgetError(snapshot(32, 12)), /committed memory/);
  const lowHeadroom = snapshot(15, 12); lowHeadroom.memory.CommitLimit = 20 * GiB;
  assert.match(systemBudgetError(lowHeadroom), /headroom/);
});
test('a ripgrep process storm outside the owned task tree stops the workload', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ Name: 'rg.exe', ProcessId: i + 100, ParentProcessId: 42 }));
  assert.match(systemBudgetError(snapshot(10, 24, rows)), /ripgrep/);
  assert.equal(systemBudgetError(snapshot(10, 24, rows.slice(0, 7))), '');
});
test('missing memory data fails closed and physical memory/process ceilings are enforced', () => {
  assert.match(systemBudgetError({ processes: [] }), /invalid/);
  assert.match(systemBudgetError(snapshot(10, 3)), /free memory/);
  assert.match(systemBudgetError(snapshot(10, 24, Array.from({ length: 512 }, () => ({ Name: 'example.exe' })))), /process count/);
});
test('diagnostic summaries retain global pressure and offending process identities without command lines', () => {
  const value = summarizeSystem(snapshot(10, 24, [{ Name: 'rg.exe', ProcessId: 100, ParentProcessId: 42, CreationDate: 'fixture', PrivatePageCount: 123, WorkingSetSize: 100, CommandLine: 'private fixture text' }]));
  assert.equal(value.commitRatio, 0.25); assert.equal(value.commitHeadroom, 30 * GiB); assert.equal(value.ripgrep[0].pid, 100);
  assert.doesNotMatch(JSON.stringify(value), /private fixture text/);
});
