# IEXA Workbench upgrade — 2026-09-15

## Delivered in this batch

### Desktop UI
- A separate `src/renderer/workbench.css` skin, loaded after the legacy CSS; neutral light/dark surfaces, compact navigation and lower visual noise.
- New task shortcut, grouped navigation, project selector, breadcrumb header, focus-layout control.
- Existing DOM IDs and all 11 navigation destinations retained. New controls forward to existing handlers; they do not execute independent API actions.
- Composer model/options toolbar moved below the text area. The send icon is explicitly centered in idle/hover/pressed states. Queue mode retains its existing action.
- Mobile model menus remain visible above the composer; reduced-motion preferences disable skin motion.
- Accent preferences remain available for selected details/focus rings. Main surfaces and primary actions use the neutral workbench palette.

### Project instructions
- `ProjectInstructions` resolves rules from the opened project root down to the target directory.
- A nonempty `AGENTS.override.md` replaces `AGENTS.md` at the same level. Deeper scope is guidance for that subtree, not a global override.
- No home/ancestor discovery in this release. Cross-project targets and resolved external junction targets are rejected by the project path policy.
- Every response records source path, scope and SHA256. Reads are fresh, bounded to 16 KiB combined raw content and 64 directory levels, UTF-8 only. Oversize/invalid sources produce warnings; partial content is not silently injected.
- Open-project root instructions are included in the real AgentLoop request envelope. A `project_instructions` tool loads nested scopes through ToolRuntime. Its live model-facing result is not passed through the generic 2,400-character tool log truncator.
- Repository guidance does not grant execution permissions. Nested rules are model-visible guidance, not a filesystem enforcement mechanism. Shell execution is still governed by the existing runtime permissions; this batch does not intercept every shell-based edit.
- Re-read nested guidance after context compaction/recovery. Root rules refresh on each user run, not continuously during an in-flight model request.

## Validation

- `npm test` builds the project and runs 15 tests: all passed.
- `node --check src/renderer/app.js` and `node --check src/renderer/services/WorkbenchShell.js`: passed.
- Hidden Electron runner `scripts/check-workbench.cjs`: screenshots of before, light, dark, narrow, mobile and settings states. Assertions cover page overflow, visible composer, input width, send-icon containment, actual mouse-hover transform and model-menu hit testing.
- Screenshots use real renderer markup/styles with synthetic session/project data. Production app scripts and API calls are disabled for this visual fixture. The images are not evidence of a live model request or real project action.
- jsdom tests exercise real WorkbenchShell listeners and verify exactly-once forwarding, shortcut behavior, navigation/source synchronization and HTML-safe labels.
- A stub-provider integration test runs the actual AgentLoop and ToolRuntime for two turns and checks both root injection and complete nested tool output. No billable model API was called.
- First test run exposed Windows short-path vs canonical long-path comparison in the test expectation; fixed by canonicalizing the expected scope. Final run: 15/15 passed.

## Scope still pending

This batch is **not** complete Codex feature parity. Remaining phases require separate implementation and end-to-end checks:
1. Change review, before-edit snapshots, per-file accept/revert and conflict-aware rollback.
2. Planning/structured questions, reliable task cancellation/recovery.
3. Worktree-isolated tasks and multi-agent coordination.
4. Scheduled/background jobs and notifications; deeper plugin integration.
5. Optional official-engine/service integration subject to published interfaces.

Official documentation search/page retrieval returned no usable content during this run. This is an independently implemented desktop-workbench style, not a verified pixel-identical reproduction or a claim of parity with an official Codex release.

## Evidence and rollback

Artifacts live in `.iexa-artifacts/workbench-upgrade-20260915-134640/`:
- `baseline.json`, `original/`: before-change hashes and originals.
- `changes.diff`, `delivery.json`: exact patch and post-change hashes.
- `tests.log`, `visual-checks.json`, `visual-check.stdout.log`: execution evidence.
- `workbench-*.png`: six visual fixtures.
- `rollback.ps1`: guarded rollback; use `-WhatIf` first. It checks all current hashes before restoring any file. It restores edited source files and renames added files to `.rollback-disabled` rather than deleting them. It does not touch conversations, profiles, credentials or user projects.

After source rollback, run `npm run build` to regenerate compiled backend files. Fully restart the application to load the backend changes; a renderer refresh alone does not reload AgentLoop.
