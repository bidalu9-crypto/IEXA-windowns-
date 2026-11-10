'use strict';

// A PID alone is not an ownership token: Windows can reuse it after exit.
// Every process recorded or terminated by an acceptance run keeps its exact
// CIM creation timestamp, including the fractional seconds.
function processIdentity(row) {
  return row && Number.isSafeInteger(row.ProcessId) && row.ProcessId > 0 &&
    typeof row.CreationDate === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/.test(row.CreationDate)
    ? `${row.ProcessId}:${row.CreationDate}` : '';
}

function sameProcess(row, expected) {
  const identity = processIdentity(row);
  return !!identity && identity === processIdentity(expected);
}

// Compare CIM times at 100 ns precision; Date.parse alone loses four digits.
function timestampTicks(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{3,7})Z$/.exec(value);
  const seconds = match && Date.parse(match[1] + 'Z');
  return match && Number.isFinite(seconds) ? BigInt(seconds) * 10000n + BigInt(match[2].padEnd(7, '0')) : null;
}

function recordLifetime(lifetimes, row, observedAt, exitedAt = '') {
  const identity = processIdentity(row), created = timestampTicks(row?.CreationDate), seen = timestampTicks(observedAt);
  if (!identity || !lifetimes || seen === null) return;
  const previous = lifetimes.get(identity), lastSeenAt = seen < created ? row.CreationDate : observedAt;
  lifetimes.set(identity, {
    identity, lastSeenAt: previous && timestampTicks(previous.lastSeenAt) > timestampTicks(lastSeenAt) ? previous.lastSeenAt : lastSeenAt,
    exitedAt: timestampTicks(exitedAt) >= created ? exitedAt : previous?.exitedAt || '',
  });
}

function descendants(rows, root, known = new Map(), options = {}) {
  if (!processIdentity(root)) throw new TypeError('A verified PID and creation timestamp are required');
  const tree = new Map(), current = new Map(rows.map(row => [row.ProcessId, row]));
  const { lifetimes, observedAt, unproven, uncertainHistory = unproven } = options;
  function provedParent(row) {
    const born = timestampTicks(row.CreationDate), live = tree.get(row.ParentProcessId);
    if (live && born >= timestampTicks(live.CreationDate)) return live;
    if (!lifetimes) return null;
    const presentParent = current.get(row.ParentProcessId);
    for (const parent of known.values()) {
      if (parent.ProcessId !== row.ParentProcessId || born < timestampTicks(parent.CreationDate)) continue;
      // If this child was born under a newer incarnation, the old PID proves nothing.
      if (presentParent && !sameProcess(presentParent, parent) && born >= timestampTicks(presentParent.CreationDate)) continue;
      const evidence = lifetimes.get(processIdentity(parent));
      const until = timestampTicks(evidence?.exitedAt || evidence?.lastSeenAt);
      if (until !== null && born <= until) return parent;
    }
    return null;
  }
  for (const row of rows) {
    const identity = processIdentity(row);
    if (identity && (sameProcess(row, root) || known.has(identity))) tree.set(row.ProcessId, row);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      // A pre-existing orphan can retain a PID that now belongs to our root.
      if (!tree.has(row.ProcessId) && processIdentity(row) && provedParent(row)) {
        tree.set(row.ProcessId, row);
        changed = true;
      }
    }
  }
  for (const row of tree.values()) {
    known.set(processIdentity(row), row);
    // The query START is conservative evidence. Its completion time would
    // incorrectly extend the lifetime of a process which exited mid-query.
    if (observedAt) recordLifetime(lifetimes, row, observedAt);
  }
  if (unproven && lifetimes) {
    for (const row of tree.values()) { unproven.delete(processIdentity(row)); uncertainHistory.delete(processIdentity(row)); }
    let added = true;
    while (added) {
      added = false;
      for (const row of rows) {
        const identity = processIdentity(row), born = timestampTicks(row.CreationDate);
        if (!identity || tree.has(row.ProcessId) || unproven.has(identity)) continue;
        if (uncertainHistory.has(identity)) { unproven.set(identity, row); added = true; continue; }
        const presentParent = current.get(row.ParentProcessId);
        const possibleParent = item => item.ProcessId === row.ParentProcessId && born >= timestampTicks(item.CreationDate)
          && !(presentParent && !sameProcess(presentParent, item) && born >= timestampTicks(presentParent.CreationDate));
        const uncertainParent = [...uncertainHistory.values()].some(possibleParent);
        const candidates = [...known.values()].filter(possibleParent);
        if (uncertainParent || candidates.some(item => {
          const evidence = lifetimes.get(processIdentity(item));
          return !evidence?.exitedAt || born <= timestampTicks(evidence.exitedAt);
        })) {
          const evidence = { ...row, ownershipError: 'Parent exited before its exact lifetime could prove this child' };
          unproven.set(identity, evidence); uncertainHistory.set(identity, evidence); added = true;
        }
      }
    }
  }
  return [...tree.values()];
}

function terminationScript(rows) {
  const unique = [...new Map(rows.map(row => [processIdentity(row), row])).values()];
  if (!unique.length || unique.some(row => !processIdentity(row))) {
    throw new TypeError('Only verified process identities may be terminated');
  }
  const targets = unique.sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))
    .map(row => `[pscustomobject]@{processId=${row.ProcessId};created='${row.CreationDate}'}`).join(',');
  // Retain exact process handles across verification and termination. A CIM
  // check followed by Stop-Process -Id has a PID reuse race. The short-lived
  // Job also contains children born while this cleanup batch is running.
  return `$ErrorActionPreference='Stop'; $targets=@(${targets}); Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
public static class IexaOwnedCleanup {
  [StructLayout(LayoutKind.Sequential)] struct Times { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  public sealed class Evidence { public int ProcessId; public string CreationDate, HandleCreationDate, LastSeenAt, ExitedAt; public bool JobAssigned, ExactHandleTerminated; }
  public sealed class Batch { public Evidence[] Lifetimes; public string[] Errors, Warnings; }
  sealed class Target { public IntPtr Handle; public Evidence Evidence; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out Times created, out Times exit, out Times kernel, out Times user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static long FileTime(Times time) { return ((long)time.High << 32) | time.Low; }
  static string Format(DateTime time) { return time.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ"); }
  static bool Read(Target target) {
    Times created, exit, kernel, user; var observed = DateTime.UtcNow;
    if (!GetProcessTimes(target.Handle, out created, out exit, out kernel, out user)) return false;
    target.Evidence.LastSeenAt = Format(observed);
    target.Evidence.ExitedAt = FileTime(exit) == 0 ? "" : Format(DateTime.FromFileTimeUtc(FileTime(exit)));
    return true;
  }
  public static Batch Kill(int[] pids, string[] timestamps) {
    var errors = new List<string>(); var warnings = new List<string>(); var targets = new List<Target>();
    var job = CreateJobObject(IntPtr.Zero, null);
    try {
      if (job == IntPtr.Zero) errors.Add("CreateJobObject: " + Marshal.GetLastWin32Error());
      else {
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
          errors.Add("SetInformationJobObject: " + Marshal.GetLastWin32Error());
      }
      // Targets are newest first for deterministic reporting. Assign parents
      // first so new children inherit the Job before any termination begins.
      for (int i = pids.Length - 1; i >= 0; i--) {
        var handle = OpenProcess(0x00101101, false, pids[i]); // synchronize, query, set quota, terminate
        if (handle == IntPtr.Zero) {
          int error = Marshal.GetLastWin32Error();
          if (error != 87 && error != 1168) errors.Add("OpenProcess " + pids[i] + ": " + error);
          continue;
        }
        Times created, exit, kernel, user;
        var expected = DateTime.Parse(timestamps[i], CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
        if (!GetProcessTimes(handle, out created, out exit, out kernel, out user)) { CloseHandle(handle); continue; }
        var actual = DateTime.FromFileTimeUtc(FileTime(created));
        // CIM Win32_Process exposes microseconds, truncated from FILETIME's
        // 100ns ticks. Match only that exact 1us bin; never allow a 1ms window.
        var difference = actual.Ticks - expected.Ticks;
        if (difference < 0 || difference > 9) { CloseHandle(handle); continue; }
        var target = new Target { Handle = handle, Evidence = new Evidence { ProcessId = pids[i], CreationDate = timestamps[i], HandleCreationDate = Format(actual) } };
        targets.Add(target);
        if (FileTime(exit) != 0) { Read(target); continue; }
        if (job != IntPtr.Zero && AssignProcessToJobObject(job, handle)) target.Evidence.JobAssigned = true;
        else warnings.Add("AssignProcessToJobObject " + pids[i] + ": " + Marshal.GetLastWin32Error() + "; use verified process handle and rescan descendants");
      }
      if (job != IntPtr.Zero && !TerminateJobObject(job, 1)) errors.Add("TerminateJobObject: " + Marshal.GetLastWin32Error());
      foreach (var target in targets) if (!target.Evidence.JobAssigned) {
        if (!Read(target)) { errors.Add("GetProcessTimes before termination " + target.Evidence.ProcessId); continue; }
        if (target.Evidence.ExitedAt == "") {
          if (TerminateProcess(target.Handle, 1)) target.Evidence.ExactHandleTerminated = true;
          else if (!Read(target) || target.Evidence.ExitedAt == "") errors.Add("TerminateProcess " + target.Evidence.ProcessId + ": " + Marshal.GetLastWin32Error());
        }
      }
      var until = DateTime.UtcNow.AddMilliseconds(2500);
      foreach (var target in targets) {
        WaitForSingleObject(target.Handle, (uint)Math.Max(0, (until - DateTime.UtcNow).TotalMilliseconds));
        if (!Read(target)) errors.Add("GetProcessTimes " + target.Evidence.ProcessId + ": " + Marshal.GetLastWin32Error());
        else if (target.Evidence.ExitedAt == "") errors.Add("Process did not exit: " + target.Evidence.ProcessId);
      }
      return new Batch { Lifetimes = targets.ConvertAll(t => t.Evidence).ToArray(), Errors = errors.ToArray(), Warnings = warnings.ToArray() };
    } finally { if (job != IntPtr.Zero) CloseHandle(job); foreach (var target in targets) CloseHandle(target.Handle); }
  }
}
'@; [IexaOwnedCleanup]::Kill([int[]]@($targets | ForEach-Object {$_.processId}), [string[]]@($targets | ForEach-Object {$_.created})) | ConvertTo-Json -Depth 5 -Compress`;
}

module.exports = { processIdentity, sameProcess, timestampTicks, recordLifetime, descendants, terminationScript };
