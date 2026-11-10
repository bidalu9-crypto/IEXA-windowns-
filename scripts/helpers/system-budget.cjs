'use strict';

const { execFile } = require('node:child_process');
const GiB = 1024 ** 3;
const LIMITS = Object.freeze({ maximumCommitRatio: 0.80, minimumCommitHeadroom: 6 * GiB, minimumFree: 4 * GiB, maximumRipgrepProcesses: 8, maximumProcesses: 512 });

// One short-lived sampler collects both the global budget and process identities.
// A per-worker V8 heap limit does not constrain VS Code or system commit charge.
const command = "$ErrorActionPreference='Stop'; $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableBytes,CommittedBytes,CommitLimit; $rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,UserModeTime,KernelModeTime,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')}}); [pscustomobject]@{memory=$memory;processes=$rows} | ConvertTo-Json -Depth 4 -Compress";

function readSystemSnapshot() {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
    windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) return reject(error);
    try {
      const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      if (!Array.isArray(snapshot.processes)) throw Error('System process sample is invalid');
      resolve(snapshot);
    } catch (error) { reject(error); }
  }));
}

function systemBudgetError(snapshot) {
  const used = Number(snapshot?.memory?.CommittedBytes), limit = Number(snapshot?.memory?.CommitLimit), free = Number(snapshot?.memory?.AvailableBytes);
  if (![used, limit, free].every(Number.isFinite) || used < 0 || limit <= 0 || free < 0 || used > limit || !Array.isArray(snapshot?.processes)) return 'System memory/commit sample is invalid';
  if (used / limit >= LIMITS.maximumCommitRatio) return 'System committed memory reached 80% of its limit';
  if (limit - used < LIMITS.minimumCommitHeadroom) return 'System commit headroom fell below 6 GiB';
  if (free < LIMITS.minimumFree) return 'Machine free memory fell below 4 GiB';
  if (snapshot.processes.filter(row => /^rg(?:\.exe)?$/i.test(row.Name || '')).length >= LIMITS.maximumRipgrepProcesses) return 'Eight or more ripgrep processes are active; possible search process storm';
  if (snapshot.processes.length >= LIMITS.maximumProcesses) return 'System process count reached 512';
  return '';
}

function summarizeSystem(snapshot) {
  const rows = snapshot.processes, committed = Number(snapshot.memory.CommittedBytes), limit = Number(snapshot.memory.CommitLimit);
  return { committed, commitLimit: limit, commitRatio: committed / limit, commitHeadroom: limit - committed,
    free: Number(snapshot.memory.AvailableBytes), processCount: rows.length,
    ripgrep: rows.filter(row => /^rg(?:\.exe)?$/i.test(row.Name || '')).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, created: row.CreationDate, privateBytes: Number(row.PrivatePageCount || 0) })),
    topPrivate: [...rows].sort((a, b) => Number(b.PrivatePageCount || 0) - Number(a.PrivatePageCount || 0)).slice(0, 12).map(row => ({ pid: row.ProcessId, name: row.Name, privateBytes: Number(row.PrivatePageCount || 0), rss: Number(row.WorkingSetSize || 0) })) };
}

module.exports = { LIMITS, readSystemSnapshot, systemBudgetError, summarizeSystem };
