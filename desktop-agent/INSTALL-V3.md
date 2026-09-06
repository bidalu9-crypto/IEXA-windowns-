# Desktop control v3

Build: `dotnet publish desktop-agent/Iexa.DesktopAgent.csproj -c Release -o desktop-agent/publish --no-self-contained`, then `npm run build`.

The runnable helper is shipped in `desktop-agent/publish`. Windows .NET 8 Desktop Runtime is required. Restart IEXA-WIN after replacing the helper and confirm `GET http://127.0.0.1:17891/capabilities` reports `managedInputLease: true` and `closeHotkeyGuard: true`.

Changes:
- Direct native UI Automation / SendInput; no JSON-file intermediates. Compact tool responses, raw diagnostics only via `detail: raw`.
- Lightweight observation defaults: max 50 controls, bounded UI tree traversal, OCR and visual-region detection opt-in. Individual Windows UI Automation calls can still block in unresponsive applications.
- Short batches capped at 24 steps; missing wait targets or failed text verification stop the batch rather than reporting business success. Unicode input no longer incurs a default per-character sleep.
- Window focus changes stop input unless explicitly overridden. Pause is persistent until the user resumes, releases held input, and invalidates queued actions. Cancellation is cooperative: an in-flight OS/UI Automation call may finish first.
- A desktop tool call opens the live panel. Preview must be explicitly enabled. Fresh, downscaled JPEG frames are fetched serially at a target of four frames per second, paused in hidden tabs, and never written to disk. This is screenshot polling, not a 60 FPS video stream. Preview endpoints are local-only.
- Original diagnostic JSON files are left untouched; this patch does not delete user files. Runtime and build manifest JSON files remain necessary.

Validation: TypeScript and native builds, protocol/source regression tests, and a live helper capability check. Model response latency, elevated windows, secure desktop and unresponsive application UI remain constraints.

Backup: `desktop-backup-20260905-172705` contains source hashes and the original published helper. Restore its saved files and rebuild to roll back. Preserve the earlier performance changes when restoring.
