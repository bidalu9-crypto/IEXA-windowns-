# Desktop control progress — 2026-09-15

## This turn's oracle

The primary new oracle is an isolated, real Chromium page started with a temporary profile and a loopback DevTools endpoint. The task is only successful when:

- Chromium DOM observation returns semantic controls and an observation token;
- `type` and `click` are executed through CDP DOM operations, not Win32 focus, mouse, or keyboard injection;
- the local page posts an independent receipt containing the generated value;
- post-action observation verifies the submitted text;
- the tested Chromium process is isolated from user profiles and has no HWND (`headless=new`).

This is a real Chromium/CDP backend acceptance, not a claim that arbitrary GUI software has background support.

## Implemented

- `src/main/tools/desktop/ChromiumCdpAdapter.ts`
  - loopback-only `/json/list` target discovery;
  - WebSocket CDP command transport with bounded timeouts;
  - DOM semantic observation and CSS-path selectors;
  - token-bound screenshots through `Page.captureScreenshot`;
  - background `type_element` and `click_element` through page DOM execution;
  - independent `wait`, `find_element`, `session_state` and `list_windows` projections;
  - cancellation checks for long waits;
  - no Win32 activation or physical input.
- `src/main/tools/DesktopAgent.ts`
  - routes explicit `backend: chromium-cdp` + `cdpEndpoint` through the adapter;
  - keeps native Win32 transport as the default;
  - records backend metadata.
- `src/main/tools/desktop/DesktopControlSession.ts`
  - persists backend context per owner for internal `list_windows`, `session_state`, frame and post-observation calls;
  - preserves backend selection across a complete verified action cycle.
- `src/main/tools/ToolDefinitions.ts`
  - exposes `backend`, `cdpEndpoint` and explicit background semantics to the model.

## Evidence

`node scripts/check-chromium-cdp.cjs` passed on 2026-09-15:

- report: `E:\IEXA-WIN\.iexa-artifacts\chromium-cdp\1789478062567\report.json`
- isolated receipt: `{ "value": "CDP-1789478063432" }`
- target URL: loopback HTTP fixture;
- temporary browser profile: inside that run's artifact directory.

The report proves one real Chromium page can be controlled while headless/no-HWND. It does not prove visible Chromium windows, arbitrary applications, or WeChat.

## Native control hardening in the same turn

- protocol version raised to 6 so old published helpers are not silently reused;
- observation frames are immutable, token-bound and rejected after geometry/token changes;
- per-window background capture state was replaced by per-observation evidence;
- HDC is released before black-frame inspection;
- no virtual-screen fallback for a requested invalid/closed bound window;
- direct native background requests and nested batches reject physical input, activation and pointer fallback before side effects;
- provider exceptions do not retry through another backend or physical input;
- stale/corrupt OCR/local-CV pixels never become background input selectors.

## Remaining release gates

- visible Chromium window/CDP acceptance with a foreground sentinel and zero operation-induced foreground transitions;
- natural-language IEXA model planning benchmark with no prewritten action sequence;
- multi-display/DPI matrix, long-running recovery and broader app adapters;
- all existing full-suite failures and final release audit.

The objective remains active; this artifact is an intermediate evidence record, not final delivery.

## 2026-09-15: visible Chromium acceptance and identity hardening (supersedes first-pass details above)

Previous goal turn classification: progress (a real headless receipt), but that alone did not prove visible background control, robust identity, or model autonomy. The resumed/interrupted turn had no live acceptance process; this run inspected processes before starting new work.

### Replaced unsafe first-pass behavior

- Removed first-tab preference. Page discovery lists every page; binding requires a unique handle/title or `cdpTargetId`. A closed selected page never falls back to another page.
- Removed CSS path relocation and positional `cdp_0` IDs. `CdpPageSnapshot.ts` runs in a CDP isolated execution world and holds actual DOM nodes in a remote object. Every observe uses fresh UUID-prefixed IDs. Replaced nodes, reloaded document, changed value/name/href/type/bounds/viewport or captured document text invalidate the input capability.
- Snapshot input is single-use. Input/textarea setters preserve append semantics, reject read-only controls and never replace arbitrary textContent. Document text is read-only evidence without an input selector. Password text is redacted from observations; private value changes still invalidate the snapshot.
- `find_element` and `wait` no longer incorrectly require `elementId`. Cancellation waits for an already dispatched command to settle; command timeout quarantines the adapter instead of automatically retrying.
- Discovery rejects redirects; endpoint is a literal loopback origin; returned WebSocket must have the same origin. No credentials/path/query/fragment allowed.
- Owner backend changes invalidate old snapshots inside the scheduling lease. Individual batch steps cannot substitute a different backend endpoint/target.
- Screenshot failure is an error, not a rendered-trust assertion with empty bytes; PNG dimensions are measured. DOM validity is checked after screenshot capture.

### Actual visible-window evidence

Commands:

```
npm run build
node --test tests/chromium-cdp.test.js tests/desktop-control.test.js
node scripts/check-chromium-cdp.cjs --visible
node scripts/check-chromium-cdp.cjs
npm test
```

Visible execution: `scripts/fixtures/chromium-visible.cjs` starts an isolated Electron/Chromium window and uses `showInactive`, not headless mode. `scripts/fixtures/foreground-audit.ps1` independently installs a Windows foreground-event hook without opening a sentinel window, activating anything, or restoring focus. Any observed external foreground transition interrupts the benchmark rather than fabricating zero interference.

E8 latest visible report: `.iexa-artifacts/chromium-cdp/1789478985754-d6f0d999/report.json`.

- Electron 44.3.0 / Chromium 152.0.7977.78 reported by the actual test process.
- Window `visible=true`, `focused=false`.
- **8/8 passed**: receipt+append+delayed UI verification; replacement node; changed user input (simulated via independent disturbance channel); stale IDs; wait cancellation/re-observe; reload; multiple pages; foreground event oracle.
- Receipt: `CDP-1d6b2fa3-7d71-4664-bc67-d012a9b3df46-append`.
- Foreground initial/final: **394894 / 394894**, hook events **[]** during the measured interval including initial visible window display. No pointer injection or focus restoration was used.
- Screenshot: `page.png`. No personal browser profile or WeChat account was accessed.

E9 latest headless report: `.iexa-artifacts/chromium-cdp/1789478988370-b68252b7/report.json`, **7/7 passed** with a different random receipt.

Earlier visible failed run `.iexa-artifacts/chromium-cdp/1789478759449-d9fbf18c/report.json` retained: initial viewport changed during capture (correctly rejected); Electron does not implement the same Target.createTarget operation as Edge. Read-only capture retry is now bounded (3 attempts; raw failed actions retained), while the Electron test host creates its second owned page explicitly. No action was replayed to fix a failed receipt.

E10 unit/integration regression: **36/36 passed**. Full suite: **270 total, 267 passed, 3 failed**, all `tests/security-tools.test.js`; unchanged permission/runtime-contract failures remain a release gate. Log: `E:\IEXA-WIN.local-backups\cdp-identity-20260915\after-tests.log`.

### Scope limits

This proves a visible, controlled Electron/Chromium page can execute this background task with zero measured foreground transitions. It is not a general guarantee about arbitrary site handlers, popups, dialogs, apps or existing user browser sessions. Visible host denies new popups deliberately, and the tests are deterministic scripted tasks with independent failure injection, not an autonomous model benchmark.

Still open: real IEXA model given only a natural-language goal, visible Edge/Chrome application profiles, iframe/shadow DOM/custom widget expansion, model-facing connection discovery/UX, native-app/WeChat adapter, user takeover behavior across long tasks, DPI/multi-screen matrix, recovery and full-suite final audit. Goal remains active; no final installer/release is produced.
