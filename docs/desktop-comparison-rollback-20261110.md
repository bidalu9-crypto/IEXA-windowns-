# Desktop comparison candidate provenance and rollback

## Current final candidate

Candidate package: release/IEXA-preview-20261109. Current build-manifest.json SHA256: **c8f442df18195fc507069beb175be8ab56745058c8e22368b90fd8b2aaa4ba89**.

The parent confirmed 345 passing perception-return tests with zero skips, successful build/publish, and distribution verification of 12,375 files and 129 production dependencies with zero errors. Current-package real-model Paint iexa-paint-1794291948377 passed in 18 calls (161.447 seconds), and WordPad iexa-wordpad-1794292164498 passed in 20 calls (219.291 seconds). Each preserved its source, produced the required output, reopened it, and has a direct screenshot review with a recorded hash. Fixed GUI ribbon-popup-1794291891063 passed all four checks and retained all 18 produced OCR elements; some recognized words remain inaccurate. This fixed run does not certify autonomous model completion.

Current-package UWP live acceptance remains pending. The user instructed preserving unresponsive Calculator PID 90704 and testing other applications. Two prior activation attempts returned foreground=0 without dispatching Alt+F4; no further close or termination is authorized for that preserved window. Paint, WordPad, and Ribbon results do not certify UWP closure. The expected binding status is candidate-bound-uwp-validation-pending.

The parent will run the supplemental audit, prepare the source snapshot, and bind the package after these documentation and script updates are frozen. change-manifest.json and package-binding.json under .iexa-artifacts/desktop-comparison-20261110 record the actual source and compiled-output checks. The package manifest has no signed source-hash provenance: matching snapshots, build records, packaged bytes and local build outputs do not establish a reproducible source-to-binary rebuild. Read the resulting binding before treating provenance as completed.

Historical successful Calculator, 7-Zip and pointer runs belong to package 8d38597839e9bc8ba83b12340736e7d0e4e49190934f3f0b7f28c1ab77394468. Paint also passed on cf0cea176715031641a0aff95d50e28639403b5befa93e2274ccfda10a95e4b8 and a247d9da17901ccbacf883a293d0063398661eb13f2813073449ee4abd8e2d1f; those historical results do not certify current-package reruns. Initial and first-stage bundles below retain their own evidence and hashes. No previous bundle was launched or moved by these documentation updates.

Known limits include pending UWP live validation, possible multi-level popup return-to-root false failures, a code-level suspected ordinary save-modal return issue without expectWindowClosed, and incomplete automatic enumeration of untitled native menus. No all-app capability or complete Codex parity claim follows.

## Rollback boundaries

The workspace contained pre-existing changes. Do not reset the repository or restore everything from Git HEAD. Use the preserved file copies for the intended stage only. Existing test reports, screenshots and fixture outputs are evidence and should remain intact. Newly added audit/test scripts do not need deletion to roll back application behavior.

| Intended stage | Preserved source set |
| --- | --- |
| Before second-stage guidance changes, keep first-stage keyboard/window/budget fixes | `before-guidance-fix/manifest.json` and its matching source copies |
| Before this task's native keyboard and close fixes | `before-native-fixes/sha256.json` and `Program.cs` |
| Before this task's session budget/close changes | `before-session-fixes/manifest.json` and matching source copies |
| Before native publish | `before-native-publish/manifest.json` and the four preserved native output files |
| Harness/oracle stage | The specific `before-*` entry linked to that file in `change-manifest.json` |

The `before-helper-restart-fix` backup is a separate stage boundary. Use the refreshed change manifest to resolve its verified file copies. This documentation update does not itself regenerate either binding artifact.

All directories above are below `.iexa-artifacts/desktop-comparison-20261110`. Each manifest entry resolves the exact backup path and verifies its SHA256. Some files have several chronological backups: choose the stage deliberately; the newest backup is not necessarily the pre-task version.

## File restoration procedure

1. Finish or stop active acceptance runs before altering executable sources or packages. Preserve the current candidate and current source hashes first. This document does not authorize interruption of another active run.
2. Select each original relative source path and the matching `before-*` backup from `change-manifest.json`. Confirm the backup hash equals `recordedSHA256`, and confirm the current source still equals the bound snapshot hash. Any newer edit requires an additional backup and a review of its diff before replacement.
3. Restore only those selected files using PowerShell `Copy-Item -LiteralPath <verified backup> -Destination <exact source path> -Force`. The full absolute paths must remain under `E:\IEXA-WIN` and must come from the manifest; do not compose a directory-wide restore.
4. Verify the restored file SHA256 equals its selected backup. Keep the previous candidate snapshots and diffs so the rollback itself is reversible.
5. To deliver a runnable rolled-back package, rebuild and repackage the selected coherent source stage under the existing bounded build procedure, then run the relevant checks and bind its new manifest. Restoring `Program.cs` alone does not change the existing installed DLL. Restoring a DLL alone while keeping newer JS can create a mixed package.
6. Re-run the relevant GUI/model acceptance on the rolled-back package and record new run directories. Do not transfer current candidate test success to the rollback.

## Preserved complete application packages

The build process retained two complete previous package directories. A read-only sequential SHA256 check verified **all 12,375 manifest-listed files in each package**, with no missing files or mismatches. Evidence: `.iexa-artifacts/desktop-comparison-20261110/rollback-package-verification.json`.

| Stage | Existing executable | Manifest SHA256 |
| --- | --- | --- |
| Initial baseline | `E:\IEXA-WIN\release\IEXA-preview-20261109.previous-1794276576122\IEXA.exe` | `c204d0808b20868c7412fd90f493a3a67a1debfed0b27b5bf5586aba1ca7df5c` |
| First-stage fixes | `E:\IEXA-WIN\release\IEXA-preview-20261109.previous-1794279606952\IEXA.exe` | `531b2acb0382a59586934bd459d7f3025dd5e4670ec260545fc6081aa3c14f4d` |

After active model/GUI runs finish and the current IEXA instance is closed, the selected coherent old bundle can be started directly from its preserved path. No file move, source reset or mixed-component replacement is needed. For example, to use the initial baseline:

```powershell
Start-Process -FilePath 'E:\IEXA-WIN\release\IEXA-preview-20261109.previous-1794276576122\IEXA.exe' -WorkingDirectory 'E:\IEXA-WIN\release\IEXA-preview-20261109.previous-1794276576122' -WindowStyle Hidden
```

Use the second path to return to the first-stage fixes instead. Launching an old application bundle does not restore user data or settings, and is distinct from reverting source files. No previous bundle was launched or moved by this audit.

## Refresh provenance without executing GUI or builds

```powershell
node scripts/prepare-desktop-change-manifest.cjs
node scripts/bind-desktop-change-package.cjs
```

The first command writes a new source snapshot/diff set and marks final package binding pending. The second checks existing build evidence and byte hashes, then writes the candidate binding. Run them only after the intended sources and package are stable; they do not compile or prove model acceptance.
