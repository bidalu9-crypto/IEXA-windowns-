# Long-task performance changes

## Behavior

- Text/thinking/tool-input events are coalesced at 80 ms on the server. The renderer updates at 80 ms for visible sessions and 400 ms for background sessions. Lifecycle events flush pending updates.
- Updated clients negotiate incremental text SSE with `X-IEXA-Stream: delta` and `stream=delta`. Legacy clients retain full snapshots. Reconnected mirror clients receive a fresh snapshot in their first delta frame.
- Streaming answers display plain text; Markdown, table enhancement and code highlighting run when the message finishes. Unknown-language and code blocks over 16,000 characters use escaped plain text instead of auto-highlighting.
- Tool output over 24,000 characters is sent as a 16,000-character preview when its full-output artifact exists. The full transcript remains on disk and in the agent context. History reload refreshes artifact links.
- Local long-text panes paginate at 16,000 characters and retain full-copy access. Full output attachments remain accessible separately. Terminal display retains the latest 100,000 characters, using incremental DOM append.
- Inactive session caches are evicted during switching when there are over four entries, excluding active/queued/pending sessions. Completed messages use browser offscreen rendering containment.
- Session file writes are asynchronous, atomic and serialized by path. Jobs use a memory cache and a 150 ms coalesced asynchronous save. A forced process termination inside this debounce window can lose the last job-status change.
- Slow SSE connections are disconnected after their pending output exceeds 16 MiB; this is a bounded-overload policy, not a lossless replay queue. Reload saved history after reconnecting if the live turn was interrupted.

## Validation

Run `npm test` and `node --test tests/performance.test.js` after `npm run build`.
The performance tests cover batching, terminal-event flushing, independent streams, stale turns, incremental transport size, text paging, and concurrent atomic writes.

This patch does not move the backend into another process, replace the session storage format, or implement a full variable-height message virtualizer. Metadata/context writes and full-history JSON parsing remain potential costs. Real-window CPU, heap and frame-time profiling is still needed to quantify end-to-end improvement.

## Backup and rollback

The baseline is `performance-backup-20260905-164658`, including original-file SHA256 hashes and test logs. Close the app before restoring its saved `src` files and `runtime.test.js` to their original paths, then run `npm run build`. New files can remain unused after rollback. Do not use `git reset --hard`: unrelated pre-existing changes were intentionally preserved.
