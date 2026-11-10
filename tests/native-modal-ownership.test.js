'use strict';

// Compile the actual dependency-free policy from Program.cs. These cases do not
// reimplement its security decisions in JavaScript and do not launch any GUI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native modal ownership executes the production C# policy against identity and ownership regressions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-modal-policy-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^iexa-native-modal-policy-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = fs.readFileSync(path.join(__dirname, '../desktop-agent/Program.cs'), 'utf8');
  const begin = source.indexOf('// BEGIN NATIVE_MODAL_POLICY'), end = source.indexOf('// END NATIVE_MODAL_POLICY');
  assert.ok(begin >= 0 && end > begin, 'Production C# modal policy boundaries exist');
  const policy = source.slice(begin, end);
  const rememberBegin = source.indexOf('    static void RememberModalWindow('), rememberEnd = source.indexOf('    static NativeModalPolicy.Process ReadModalProcess(', rememberBegin);
  const verifyBegin = source.indexOf('    static void AddModalAncestry('), verifyEnd = source.indexOf('    static bool FollowForegroundWindow(', verifyBegin);
  const followEnd = source.indexOf('    static FrameState CaptureBoundFrame(', verifyEnd);
  const postBegin = source.indexOf('    static void GrantPostActionModalFollow('), postEnd = source.indexOf('    static object SessionState(', postBegin);
  assert.ok(rememberBegin >= 0 && rememberEnd > rememberBegin && verifyBegin >= 0 && verifyEnd > verifyBegin, 'Production observation and live modal proof method boundaries exist');
  assert.ok(followEnd > verifyEnd && postBegin >= 0 && postEnd > postBegin, 'Production post-action and foreground transition method boundaries exist');
  const observationMethods = source.slice(rememberBegin, rememberEnd) + source.slice(verifyBegin, followEnd) + source.slice(postBegin, postEnd);
  const project = path.join(directory, 'NativeModalPolicy.csproj'), configuration = path.join(directory, 'NuGet.Config');
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  // The policy has no package references. Clear inherited sources so this test
  // restores only SDK framework references and never reaches a NuGet endpoint.
  fs.writeFileSync(configuration, '<configuration><packageSources><clear /></packageSources></configuration>');
  fs.writeFileSync(path.join(directory, 'Program.cs'), `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
${policy}
internal static class PolicyRunner {
  static void Main(string[] args) {
    var cases = JsonSerializer.Deserialize<PolicyCase[]>(File.ReadAllText(args[0]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    var results = cases.Select(c => new { name = c.Name, actual = c.Kind == "observation" || c.Kind == "post-action" || c.Kind == "foreground-action"
      ? ObservationRunner.Run(c) : c.Kind == "popup-return" ? ResolvePopupReturn(c) : c.Kind == "popup"
      ? NativeModalPolicy.CanEnterOwnedPopup(c.Root, c.Bound, c.Candidate, c.OwnerChain, c.Processes.ToDictionary(p => p.Pid), c.PostActionAuthorized) : c.Kind == "close"
      ? ResolveClosed(c) : c.Kind == "return"
      ? NativeModalPolicy.CanReturn(c.Bound, c.SavedOwner, c.Candidate, c.ExpectWindowClosed, c.ModalStillExists)
      : NativeModalPolicy.CanEnter(c.Root, c.Bound, c.Candidate, c.OwnerChain, c.Processes.ToDictionary(p => p.Pid)) }).ToArray();
    Console.Write(JsonSerializer.Serialize(results));
  }
  static bool ResolvePopupReturn(PolicyCase c) {
    var windows = new Dictionary<long, NativeModalPolicy.Window> { [c.Root.Handle] = c.Root, [c.SavedOwner.Handle] = c.SavedOwner, [c.Bound.Handle] = c.Bound };
    var parents = new Dictionary<long, long> { [c.Bound.Handle] = c.SavedOwner.Handle };
    var live = new Dictionary<long, NativeModalPolicy.Window> { [c.Root.Handle] = c.Root, [c.Candidate.Handle] = c.Candidate };
    if (c.ModalStillExists) live[c.Bound.Handle] = c.Bound with { Visible = c.CloseScenario == "still-visible" };
    if (c.CloseScenario == "missing-relation") parents.Clear();
    if (c.CloseScenario == "root-reused") live[c.Root.Handle] = c.Root with { Process = c.Root.Process with { Created = c.Root.Process.Created + 1 } };
    if (c.CloseScenario == "popup-reused") live[c.Bound.Handle] = c.Bound with { Visible = false, Process = c.Bound.Process with { Created = c.Bound.Process.Created + 1 } };
    if (c.CloseScenario == "owner-changed") live[c.Bound.Handle] = c.Bound with { Visible = false, Owner = 99999 };
    var reads = 0;
    NativeModalPolicy.Window Read(long handle) {
      var window = live[handle];
      return handle == c.Bound.Handle && c.CloseScenario == "popup-reappeared" && ++reads > 1 ? window with { Visible = true } : window;
    }
    var result = NativeModalPolicy.TryResolveOwnedPopupReturn(c.Root, c.Bound, c.Candidate.Handle, windows, parents, c.PostActionAuthorized,
      live.ContainsKey, Read, out var owner);
    if (result && (owner == null || !NativeModalPolicy.SameWindow(owner, c.Candidate))) throw new InvalidOperationException("Popup returned to the wrong owner.");
    return result;
  }
  static bool ResolveClosed(PolicyCase c) {
    var windows = new Dictionary<long, NativeModalPolicy.Window> { [c.Root.Handle] = c.Root, [c.SavedOwner.Handle] = c.SavedOwner, [c.Bound.Handle] = c.Bound };
    var parents = new Dictionary<long, long> { [c.Bound.Handle] = c.SavedOwner.Handle };
    var live = new Dictionary<long, NativeModalPolicy.Window> { [c.Root.Handle] = c.Root, [c.Candidate.Handle] = c.Candidate };
    if (c.ModalStillExists) live[c.Bound.Handle] = c.Bound;
    if (c.CloseScenario == "missing-relation") parents.Clear();
    if (c.CloseScenario == "missing-modal-record") windows.Remove(c.Bound.Handle);
    if (c.CloseScenario == "root-gone") live.Remove(c.Root.Handle);
    if (c.CloseScenario == "root-reused") live[c.Root.Handle] = c.Root with { Process = c.Root.Process with { Created = c.Root.Process.Created + 1 } };
    if (c.CloseScenario == "modal-record-reused") windows[c.Bound.Handle] = c.Bound with { Process = c.Bound.Process with { Created = c.Bound.Process.Created + 1 } };
    var modalExistenceReads = 0;
    bool Exists(long handle) => handle == c.Bound.Handle && c.CloseScenario == "modal-reappeared"
      ? ++modalExistenceReads > 1 : live.ContainsKey(handle);
    NativeModalPolicy.Window Read(long handle) => live.TryGetValue(handle, out var window) ? window
      : throw new InvalidOperationException("Production close orchestration read a nonexistent HWND: " + handle);
    var actual = NativeModalPolicy.TryResolveClosedReturn(c.Root, c.Bound, c.Candidate.Handle, windows, parents, c.ExpectWindowClosed,
      Exists, Read, out var returned, out var rejection);
    if (actual && (returned == null || !NativeModalPolicy.SameWindow(c.Candidate, returned) || rejection != ""))
      throw new InvalidOperationException("Expected exact returned owner and empty rejection on successful close.");
    if (!actual && (returned != null || string.IsNullOrWhiteSpace(rejection)))
      throw new InvalidOperationException("Expected explicit rejection with no returned owner.");
    return actual;
  }
}
// Execute the real production observation and live-proof method bodies. Only
// Win32 identity/state reads and foreground reads are replaced with fixture
// facts; no GUI or alternate ownership decision implementation is involved.
internal static class ObservationRunner {
  static IntPtr BoundWindow;
  static IntPtr Foreground;
  static NativeModalPolicy.Window? ModalRoot;
  static readonly Dictionary<long, NativeModalPolicy.Window> ModalWindows = new();
  static readonly Dictionary<long, long> ModalParents = new();
  static readonly Dictionary<long, NativeModalPolicy.Window> LiveWindows = new();
  static readonly Dictionary<uint, NativeModalPolicy.Process> LiveProcesses = new();
  static string WindowTransitionDiagnostic = "";
  static NativeModalPolicy.Window? PostActionFollowWindow;
  static long PostActionFollowGrantedAt;
  static bool SettlingOwner;
  static int OwnerReads;
  static bool MutatingSurface;
  static int CandidateReads;
  static IntPtr GetForegroundWindow() => Foreground;
  static bool IsWindow(IntPtr handle) => LiveWindows.ContainsKey(handle.ToInt64());
  static class IsolatedDesktopHost { internal static bool Requested => false; }
  // Bind substitutes only the final native binding boundary. All production
  // transition verification above it executes unchanged against fixture facts.
  static void BindToWindow(IntPtr handle, NativeModalPolicy.Window? verifiedIdentity = null) {
    if (verifiedIdentity == null || handle != Foreground || !NativeModalPolicy.SameWindow(verifiedIdentity, ReadModalWindow(handle)))
      throw new InvalidOperationException("Binding boundary received an unverified HWND.");
    BoundWindow = handle;
  }
  static void ThrowIfCancelled() { }
  static NativeModalPolicy.Process ReadModalProcess(uint pid) => LiveProcesses[pid];
  static NativeModalPolicy.Window ReadModalWindow(IntPtr handle) {
    var current = LiveWindows[handle.ToInt64()];
    if (SettlingOwner && current.Handle == ModalRoot!.Handle && ++OwnerReads <= 3) return current with { Enabled = true };
    if (MutatingSurface && current.Handle != ModalRoot!.Handle && ++CandidateReads > 1) return current with { ClassName = "UnrelatedWindow" };
    return current;
  }
${observationMethods}
  internal static bool Run(PolicyCase c) {
    BoundWindow = IntPtr.Zero; ModalRoot = null; ModalWindows.Clear(); ModalParents.Clear(); LiveWindows.Clear(); LiveProcesses.Clear();
    SettlingOwner = false; OwnerReads = 0; MutatingSurface = false; CandidateReads = 0;
    PostActionFollowWindow = null; PostActionFollowGrantedAt = 0;
    foreach (var window in c.OwnerChain) LiveWindows[window.Handle] = window;
    LiveWindows[c.Root.Handle] = c.Root; LiveWindows[c.Candidate.Handle] = c.Candidate;
    foreach (var process in c.Processes) LiveProcesses[process.Pid] = process;
    Foreground = new IntPtr(c.Root.Handle); RememberModalWindow(Foreground); BoundWindow = Foreground;
    if (c.Kind == "post-action" || c.Kind == "foreground-action") return RunPostAction(c);
    if (c.CloseScenario == "owner-settles") SettlingOwner = true;
    Foreground = new IntPtr(c.Candidate.Handle); RememberModalWindow(Foreground); BoundWindow = Foreground;
    var retained = ModalRoot != null && NativeModalPolicy.SameWindow(c.Root, ModalRoot)
      && ModalParents.TryGetValue(c.Candidate.Handle, out var parent) && parent == c.Root.Handle
      && ModalWindows.TryGetValue(c.Candidate.Handle, out var modal) && NativeModalPolicy.SameWindow(c.Candidate, modal);
    if (!retained || c.CloseScenario != "close-after-observe") return retained;
    LiveWindows.Remove(c.Candidate.Handle); LiveWindows[c.Root.Handle] = c.Root with { Enabled = true };
    Foreground = new IntPtr(c.Root.Handle);
    return NativeModalPolicy.TryResolveClosedReturn(ModalRoot!, c.Candidate, Foreground.ToInt64(), ModalWindows, ModalParents, true,
      LiveWindows.ContainsKey, handle => ReadModalWindow(new IntPtr(handle)), out var returned, out _)
      && returned != null && NativeModalPolicy.SameWindow(c.Root, returned);
  }
  static bool RunPostAction(PolicyCase c) {
    if (c.CloseScenario == "popup-dismissed" || c.CloseScenario == "popup-hidden") {
      GrantPostActionModalFollow(); Foreground = new IntPtr(c.Candidate.Handle);
      if (!FollowForegroundWindow(Foreground)) return false;
      GrantPostActionModalFollow();
      if (c.CloseScenario == "popup-hidden") LiveWindows[c.Candidate.Handle] = c.Candidate with { Visible = false };
      else LiveWindows.Remove(c.Candidate.Handle);
      Foreground = new IntPtr(c.Root.Handle);
      return FollowForegroundWindow(Foreground) && BoundWindow.ToInt64() == c.Root.Handle
        && !ModalParents.ContainsKey(c.Candidate.Handle) && !ModalWindows.ContainsKey(c.Candidate.Handle);
    }
    if (c.CloseScenario == "late-close") {
      Foreground = new IntPtr(c.Candidate.Handle); RememberModalWindow(Foreground); BoundWindow = Foreground;
      GrantPostActionModalFollow();
      LiveWindows.Remove(c.Candidate.Handle); LiveWindows[c.Root.Handle] = c.Root with { Enabled = true }; Foreground = new IntPtr(c.Root.Handle);
      FollowPostActionModal(new JsonObject { ["followOwnedModal"] = true, ["expectWindowClosed"] = true });
      return BoundWindow.ToInt64() == c.Root.Handle && !ModalWindows.ContainsKey(c.Candidate.Handle) && !ModalParents.ContainsKey(c.Candidate.Handle);
    }
    if (c.CloseScenario != "no-grant") GrantPostActionModalFollow();
    if (c.CloseScenario == "expired-grant") PostActionFollowGrantedAt -= 2001;
    if (c.CloseScenario == "surface-changes") MutatingSurface = true;
    if (c.CloseScenario == "bound-reused") LiveWindows[c.Root.Handle] = c.Root with { Process = c.Root.Process with { Created = c.Root.Process.Created + 1 } };
    Foreground = new IntPtr(c.Candidate.Handle);
    var request = new JsonObject { ["followOwnedModal"] = c.CloseScenario != "no-opt-in" };
    if (c.CloseScenario == "background-request") request["background"] = true;
    try {
      if (c.Kind == "foreground-action") FollowForegroundWindow(Foreground);
      else FollowPostActionModal(request);
    }
    catch (InvalidOperationException error) {
      var expected = c.CloseScenario switch {
        "no-grant" or "expired-grant" => "No fresh successful foreground action",
        "bound-reused" => "bound window identity changed",
        "background-request" => "requires foreground native control",
        _ => null
      };
      if (expected == null || !error.Message.Contains(expected)) throw;
      return false;
    }
    var accepted = BoundWindow.ToInt64() == c.Candidate.Handle && ModalRoot != null && NativeModalPolicy.SameWindow(c.Root, ModalRoot)
      && ModalParents.TryGetValue(c.Candidate.Handle, out var parent) && parent == c.Root.Handle;
    if (accepted && c.CloseScenario == "consume-once") {
      var another = c.Candidate with { Handle = c.Candidate.Handle + 1, Owner = c.Candidate.Handle };
      LiveWindows[another.Handle] = another; Foreground = new IntPtr(another.Handle);
      try { FollowPostActionModal(new JsonObject { ["followOwnedModal"] = true }); return false; }
      catch (InvalidOperationException error) when (error.Message.Contains("No fresh successful foreground action")) { return true; }
    }
    return accepted;
  }
}
internal sealed record PolicyCase(string Name, string Kind, NativeModalPolicy.Window Root, NativeModalPolicy.Window Bound,
  NativeModalPolicy.Window Candidate, NativeModalPolicy.Window[] OwnerChain, NativeModalPolicy.Process[] Processes,
  NativeModalPolicy.Window SavedOwner, bool ExpectWindowClosed, bool ModalStillExists, string? CloseScenario, bool PostActionAuthorized = false);
`);

  const executable = 'C:\\Apps\\IEXA\\IEXA.exe';
  const rootProcess = { pid: 100, parentPid: 1, created: 1000, executable };
  const utilityProcess = { pid: 101, parentPid: 100, created: 1100, executable };
  const root = { handle: 10000, owner: 0, visible: true, enabled: false, process: rootProcess };
  const modal = { handle: 10100, owner: root.handle, visible: true, enabled: true, process: utilityProcess };
  const cases = [];
  const enter = (name, expected, values = {}) => cases.push({ name, expected, kind: 'enter', root, bound: root, candidate: modal, ownerChain: [modal, root], processes: [rootProcess, utilityProcess], savedOwner: root, expectWindowClosed: false, modalStillExists: true, ...values });
  const returningOwner = { ...root, enabled: true };
  const closed = (name, expected, values = {}) => cases.push({ name, expected, kind: 'return', root, bound: modal, candidate: returningOwner, ownerChain: [], processes: [], savedOwner: root, expectWindowClosed: true, modalStillExists: false, ...values });
  const replaceCandidate = candidate => ({ candidate, ownerChain: [candidate, root] });

  enter('same-executable descendant with exact GW_OWNER and disabled owner is accepted', true);
  const intermediate = { pid: 102, parentPid: 100, created: 1050, executable };
  const grandchild = { ...utilityProcess, parentPid: intermediate.pid };
  const grandchildModal = { ...modal, process: grandchild };
  enter('multi-level descendant requires the full same-executable process chain', true, { ...replaceCandidate(grandchildModal), processes: [rootProcess, intermediate, grandchild] });
  const samePidModal = { ...modal, process: rootProcess };
  enter('same-process owned modal remains valid without broad same-PID window takeover', true, replaceCandidate(samePidModal));
  const otherInstance = { ...utilityProcess, parentPid: 900 };
  enter('unrelated same-executable process is rejected', false, { ...replaceCandidate({ ...modal, process: otherInstance }), processes: [rootProcess, otherInstance] });
  enter('reused parent PID with creation after child is rejected', false, { ...replaceCandidate(grandchildModal), processes: [rootProcess, { ...intermediate, created: 1200 }, grandchild] });
  enter('reused application PID fails original creation-time identity', false, { processes: [{ ...rootProcess, created: 1090 }, utilityProcess] });
  const differentExecutable = { ...utilityProcess, executable: 'C:\\Other\\IEXA\\IEXA.exe' };
  enter('same filename at another full executable path is rejected', false, { ...replaceCandidate({ ...modal, process: differentExecutable }), processes: [rootProcess, differentExecutable] });
  enter('intermediate process from another executable is rejected', false, { ...replaceCandidate(grandchildModal), processes: [rootProcess, { ...intermediate, executable: 'C:\\Windows\\explorer.exe' }, grandchild] });
  enter('missing GW_OWNER never gains authority from a descendant PID', false, replaceCandidate({ ...modal, owner: 0 }));
  enter('wrong GW_OWNER is rejected even when the process ancestry matches', false, replaceCandidate({ ...modal, owner: 99999 }));
  enter('same-PID unrelated window without an ownership chain is rejected', false, replaceCandidate({ ...samePidModal, owner: 0 }));
  enter('hidden foreground candidate is rejected', false, replaceCandidate({ ...modal, visible: false }));
  enter('disabled foreground candidate is rejected', false, replaceCandidate({ ...modal, enabled: false }));
  enter('an enabled owner proves no modal relationship and is rejected', false, { bound: returningOwner, ownerChain: [modal, returningOwner] });
  enter('incomplete process ancestry is rejected', false, { ...replaceCandidate(grandchildModal), processes: [rootProcess, grandchild] });
  const cyclicA = { ...grandchild, parentPid: 102 }, cyclicB = { ...intermediate, parentPid: 101, created: 1100 };
  enter('cyclic parent chain is rejected', false, { ...replaceCandidate({ ...modal, process: cyclicA }), processes: [rootProcess, cyclicA, cyclicB] });
  enter('zero process creation time cannot authorize a modal', false, replaceCandidate({ ...modal, process: { ...utilityProcess, created: 0 } }));
  enter('zero window handle cannot authorize a modal', false, replaceCandidate({ ...modal, handle: 0 }));
  const mixedCase = { ...utilityProcess, executable: executable.toUpperCase() };
  enter('Windows executable path comparison preserves case-insensitive identity', true, { ...replaceCandidate({ ...modal, process: mixedCase }), processes: [rootProcess, mixedCase] });
  const secondOwner = { handle: 10050, owner: root.handle, visible: true, enabled: false, process: rootProcess };
  const nestedModal = { ...modal, owner: secondOwner.handle };
  enter('verified intermediate HWND ownership chain is accepted', true, { candidate: nestedModal, ownerChain: [nestedModal, secondOwner, root] });
  enter('unrelated process in an intermediate HWND owner chain is rejected', false, { candidate: nestedModal, ownerChain: [nestedModal, { ...secondOwner, process: otherInstance }, root], processes: [rootProcess, utilityProcess, { ...otherInstance, pid: 900 }] });

  const observation = (name, expected, values = {}) => enter(name, expected, { kind: 'observation', ...values });
  observation('production explicit dialog observation retains the root and verified child-process modal-owner relationship', true);
  observation('production same-process folder observation retains the root and verified modal-owner relationship', true, replaceCandidate(samePidModal));
  observation('production folder observation followed by actual modal disappearance resolves the saved owner', true, { ...replaceCandidate(samePidModal), closeScenario: 'close-after-observe' });
  observation('production child-process file observation followed by modal disappearance resolves the saved owner', true, { closeScenario: 'close-after-observe' });
  observation('production live modal proof waits for a genuine disabled owner state without replaying input', true, { closeScenario: 'owner-settles' });
  observation('production explicit observation grants no inferred return for GW_OWNER zero', false, replaceCandidate({ ...modal, owner: 0 }));
  observation('production explicit observation grants no inferred return for unrelated process ancestry', false, { ...replaceCandidate({ ...modal, process: otherInstance }), processes: [rootProcess, otherInstance] });
  observation('production explicit observation grants no inferred return for another executable', false, { ...replaceCandidate({ ...modal, process: differentExecutable }), processes: [rootProcess, differentExecutable] });

  const postAction = (name, expected, values = {}) => enter(name, expected, { kind: 'post-action', ...values });
  postAction('production post-action state check follows a late genuine child-process owned modal', true);
  postAction('production post-action state check follows a late same-process folder modal', true, replaceCandidate(samePidModal));
  postAction('production post-action state resolves an explicitly expected close that completed after input returned', true, { closeScenario: 'late-close' });
  postAction('production post-action modal grant is consumed once and cannot follow a second foreground target', true, { closeScenario: 'consume-once' });
  postAction('production passive state without explicit follow opt-in never changes binding', false, { closeScenario: 'no-opt-in' });
  postAction('production post-action state cannot infer modal access without a successful prior foreground grant', false, { closeScenario: 'no-grant' });
  postAction('production post-action state rejects an expired foreground action grant', false, { closeScenario: 'expired-grant' });
  postAction('production post-action state rejects reuse of the original bound process identity', false, { closeScenario: 'bound-reused' });
  postAction('production post-action state rejects a background modal-follow request', false, { closeScenario: 'background-request' });
  postAction('production post-action state rejects an unrelated foreground with GW_OWNER zero', false, replaceCandidate({ ...modal, owner: 0 }));
  postAction('production post-action state rejects same-executable unrelated foreground ancestry', false, { ...replaceCandidate({ ...modal, process: otherInstance }), processes: [rootProcess, otherInstance] });
  postAction('production post-action state rejects an unrelated foreground executable', false, { ...replaceCandidate({ ...modal, process: differentExecutable }), processes: [rootProcess, differentExecutable] });

  const popupRoot = { ...root, enabled: true };
  const browserPopup = { ...samePidModal, className: 'Chrome_WidgetWin_1', style: 0x80000000, exStyle: 0x80 };
  const popupCase = { root: popupRoot, bound: popupRoot, candidate: browserPopup, ownerChain: [browserPopup, popupRoot], processes: [rootProcess], postActionAuthorized: true };
  const popup = (name, expected, values = {}) => enter(name, expected, { ...popupCase, kind: 'popup', ...values });
  popup('known browser popup with enabled same-process owner requires post-input authority', true);
  const popupStyleOnly = { ...browserPopup, exStyle: 0 }, toolWindowOnly = { ...browserPopup, style: 0 };
  popup('known browser bubble may expose WS_POPUP without TOOLWINDOW', true, { candidate: popupStyleOnly, ownerChain: [popupStyleOnly, popupRoot] });
  popup('known browser bubble may expose TOOLWINDOW without WS_POPUP', true, { candidate: toolWindowOnly, ownerChain: [toolWindowOnly, popupRoot] });
  popup('browser popup rejects a missing post-action grant', false, { postActionAuthorized: false });
  popup('same-PID ordinary top-level window never qualifies as a popup', false, { candidate: { ...browserPopup, style: 0, exStyle: 0 }, ownerChain: [{ ...browserPopup, style: 0, exStyle: 0 }, popupRoot] });
  const wrongClass = { ...browserPopup, className: 'AnotherApplicationWindow' };
  popup('popup style does not authorize an unknown window class', false, { candidate: wrongClass, ownerChain: [wrongClass, popupRoot] });
  for (const [label, candidate] of [
    ['a child window', { ...browserPopup, style: 0xc0000000 }],
    ['an app-window task surface', { ...browserPopup, exStyle: 0x40080 }],
    ['a sibling without GW_OWNER', { ...browserPopup, owner: 0 }],
    ['a different GW_OWNER', { ...browserPopup, owner: 99999 }],
    ['a hidden popup', { ...browserPopup, visible: false }],
    ['a disabled popup', { ...browserPopup, enabled: false }],
    ['a different process with matching executable', { ...browserPopup, process: utilityProcess }],
    ['a reused process creation identity', { ...browserPopup, process: { ...rootProcess, created: 1001 } }],
  ]) popup('owned nonmodal policy rejects ' + label, false, { candidate, ownerChain: [candidate, popupRoot] });
  const menu = { ...browserPopup, className: '#32768', exStyle: 0 };
  popup('native menu class with WS_POPUP and exact owner is accepted after input', true, { candidate: menu, ownerChain: [menu, popupRoot] });
  const untypedMenu = { ...menu, style: 0 };
  popup('native menu class without WS_POPUP grants no exception', false, { candidate: untypedMenu, ownerChain: [untypedMenu, popupRoot] });
  const nestedPopup = { ...browserPopup, handle: 10101, owner: browserPopup.handle };
  popup('nested same-process popup validates every HWND owner link', true, { candidate: nestedPopup, ownerChain: [nestedPopup, browserPopup, popupRoot] });
  popup('nested popup rejects a broken intermediate HWND owner link', false, { candidate: nestedPopup, ownerChain: [nestedPopup, { ...browserPopup, owner: 99999 }, popupRoot] });
  popup('nested popup rejects an arbitrary intermediate class', false, { candidate: nestedPopup, ownerChain: [nestedPopup, wrongClass, popupRoot] });
  const productionPopup = (name, expected, values = {}) => enter(name, expected, { ...popupCase, kind: 'foreground-action', ...values });
  productionPopup('production immediate foreground action follows a genuine owned nonmodal popup', true);
  productionPopup('production popup action without grant never follows an enabled owner', false, { closeScenario: 'no-grant' });
  productionPopup('production popup action rejects an expired one-use grant', false, { closeScenario: 'expired-grant' });
  productionPopup('production popup action validates class/style again before binding', false, { closeScenario: 'surface-changes' });
  productionPopup('production popup transition consumes its input grant before another window appears', true, { closeScenario: 'consume-once' });
  productionPopup('production popup dismissal returns to the saved owner without replay or activation', true, { closeScenario: 'popup-dismissed' });
  productionPopup('production cached hidden popup returns to the saved owner without replay or activation', true, { closeScenario: 'popup-hidden' });
  productionPopup('production late post-action state follows a known enabled-owner browser popup', true, { kind: 'post-action' });
  productionPopup('production late popup state still requires an input grant', false, { kind: 'post-action', closeScenario: 'no-grant' });
  observation('explicit observe alone grants no enabled-owner nonmodal popup relationship', false, popupCase);

  const popupReturn = (name, expected, values = {}) => closed(name, expected, { kind: 'popup-return', root: popupRoot, bound: browserPopup,
    savedOwner: popupRoot, candidate: popupRoot, postActionAuthorized: true, expectWindowClosed: false, ...values });
  popupReturn('destroyed accepted popup returns only to its stored exact enabled owner', true);
  popupReturn('cached accepted popup may return only after it is hidden', true, { modalStillExists: true, closeScenario: 'hidden' });
  popupReturn('still-visible popup cannot implicitly transfer control to its owner', false, { modalStillExists: true, closeScenario: 'still-visible' });
  popupReturn('popup return requires fresh acknowledged input authority', false, { postActionAuthorized: false });
  popupReturn('popup return rejects missing saved ownership relation', false, { closeScenario: 'missing-relation' });
  popupReturn('popup return rejects root process reuse', false, { closeScenario: 'root-reused' });
  popupReturn('popup return rejects reuse of a cached popup process', false, { modalStillExists: true, closeScenario: 'popup-reused' });
  popupReturn('popup return rejects changed GW_OWNER on a cached popup', false, { modalStillExists: true, closeScenario: 'owner-changed' });
  popupReturn('popup return rejects a cached popup that reappears during verification', false, { modalStillExists: true, closeScenario: 'popup-reappeared' });
  popupReturn('popup return rejects arbitrary same-PID sibling HWND', false, { candidate: { ...popupRoot, handle: 10001 } });

  for (const className of ['Net UI Tool Window', 'Net UI Tool Window Layered']) {
    const ribbon = { ...browserPopup, className, style: 0x96000000, exStyle: className.endsWith('Layered') ? 0x80088 : 0x88 };
    const ribbonCase = { candidate: ribbon, ownerChain: [ribbon, popupRoot] };
    popup(className + ' enters enabled owner only with exact process and fresh grant', true, ribbonCase);
    popup(className + ' rejects missing grant', false, { ...ribbonCase, postActionAuthorized: false });
    for (const [label, candidate] of [
      ['near-match class', { ...ribbon, className: className + ' Other' }],
      ['missing WS_POPUP', { ...ribbon, style: 0x16000000 }],
      ['missing TOOLWINDOW', { ...ribbon, exStyle: ribbon.exStyle & ~0x80 }],
      ['WS_CHILD', { ...ribbon, style: ribbon.style + 0x40000000 }],
      ['APPWINDOW', { ...ribbon, exStyle: ribbon.exStyle | 0x40000 }],
      ['foreign process', { ...ribbon, process: utilityProcess }],
      ['missing owner', { ...ribbon, owner: 0 }],
      ['wrong owner', { ...ribbon, owner: 99999 }],
    ]) popup(className + ' rejects ' + label, false, { candidate, ownerChain: [candidate, popupRoot] });
    postAction(className + ' production post-action verification retains owner relation', true,
      { ...popupCase, ...ribbonCase });
    observation(className + ' explicit observe without post-action grant does not infer owner return', false,
      { ...popupCase, ...ribbonCase, postActionAuthorized: false });
    popupReturn(className + ' destroyed popup returns to exact saved owner', true, { bound: ribbon });
    popupReturn(className + ' hidden cached popup returns to exact saved owner', true,
      { bound: ribbon, modalStillExists: true, closeScenario: 'hidden' });
    popupReturn(className + ' still-visible popup never transfers control', false,
      { bound: ribbon, modalStillExists: true, closeScenario: 'still-visible' });
    popupReturn(className + ' return without saved owner relation fails', false,
      { bound: ribbon, closeScenario: 'missing-relation' });
    popupReturn(className + ' return without fresh grant fails', false,
      { bound: ribbon, postActionAuthorized: false });
  }

  closed('explicitly closed accepted modal returns only to its stored exact owner', true);
  closed('modal disappearance without explicit close expectation is rejected', false, { expectWindowClosed: false });
  closed('still-existing modal cannot transfer authority back to owner', false, { modalStillExists: true });
  closed('a different owner HWND in the same process is rejected', false, { candidate: { ...returningOwner, handle: 10001 } });
  closed('same PID with reused creation time is rejected on return', false, { candidate: { ...returningOwner, process: { ...rootProcess, created: 2000 } } });
  closed('different PID with same executable is rejected on return', false, { candidate: { ...returningOwner, process: utilityProcess } });
  closed('owner replaced by another executable is rejected on return', false, { candidate: { ...returningOwner, process: { ...rootProcess, executable: 'C:\\Other\\IEXA.exe' } } });
  closed('hidden owner is rejected on return', false, { candidate: { ...returningOwner, visible: false } });
  closed('disabled owner is rejected on return', false, { candidate: { ...returningOwner, enabled: false } });

  const close = (name, expected, values = {}) => closed(name, expected, { kind: 'close', ...values });
  close('production expected-close orchestration returns without reading the destroyed modal HWND', true);
  close('production close rejects absent explicit expectation before consulting destroyed modal identity', false, { expectWindowClosed: false });
  close('production close rejects a still-existing modal', false, { modalStillExists: true });
  close('production close rejects modal disappearance without a stored owner relation', false, { closeScenario: 'missing-relation' });
  close('production close rejects a missing accepted modal identity', false, { closeScenario: 'missing-modal-record' });
  close('production close rejects a reused accepted modal identity', false, { closeScenario: 'modal-record-reused' });
  close('production close rejects loss of the original application root', false, { closeScenario: 'root-gone' });
  close('production close rejects replacement of the original application root process', false, { closeScenario: 'root-reused' });
  close('production close rejects an unrelated same-process foreground HWND', false, { candidate: { ...returningOwner, handle: 10001 } });
  close('production close rejects a disabled returning owner', false, { candidate: { ...returningOwner, enabled: false } });
  close('production close rejects a hidden returning owner', false, { candidate: { ...returningOwner, visible: false } });
  close('production close rejects a modal HWND that reappeared before return verification completed', false, { closeScenario: 'modal-reappeared' });
  close('production close rejects a dialog incorrectly recorded as its own application root', false, { root: modal });

  const nestedOwner = { ...secondOwner, enabled: true };
  close('production nested modal returns to its stored intermediate owner while retaining application root', true, { bound: nestedModal, savedOwner: secondOwner, candidate: nestedOwner });

  const input = path.join(directory, 'cases.json'); fs.writeFileSync(input, JSON.stringify(cases));
  const run = args => {
    const result = spawnSync('dotnet', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, [args.join(' '), result.stdout, result.stderr].join('\n'));
    return result.stdout;
  };
  run(['restore', project, '--configfile', configuration, '--verbosity', 'quiet', '--disable-parallel']);
  run(['build', project, '--no-restore', '--configuration', 'Release', '--verbosity', 'quiet', '--disable-build-servers', '-maxcpucount:1']);
  const results = JSON.parse(run([path.join(directory, 'bin/Release/net8.0/NativeModalPolicy.dll'), input]));
  assert.equal(results.length, cases.length);
  for (let index = 0; index < cases.length; index++) {
    await t.test(cases[index].name, () => {
      assert.equal(results[index].name, cases[index].name);
      assert.equal(results[index].actual, cases[index].expected);
    });
  }
});
