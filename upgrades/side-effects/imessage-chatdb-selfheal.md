# Side-Effects Review — iMessage chat.db hardlink self-heal

**Version / slug:** `imessage-chatdb-selfheal`
**Date:** `2026-07-08`
**Author:** `Roland (instar-dev agent for the iMessage fork)`
**Second-pass reviewer:** `not required` (no block/allow/session-lifecycle/gate surface — see §4)

## Summary of the change

`scripts/attachments-sync/main.go` (the `instar-attachments-sync` Go watcher, which holds Full Disk Access and already mirrors Messages attachments) now also maintains hardlinks for the three Messages SQLite files — `chat.db`, `chat.db-wal`, `chat.db-shm` — from `~/Library/Messages/` into `<agent>/.instar/imessage/`. It does an initial link on startup and then re-verifies every 2s (`chatDbLoop` → `syncChatDb`), re-linking any file whose live inode has drifted (the `-wal` inode is recreated on every reboot/Messages restart, orphaning the prior hardlink and freezing the daemon's view of the DB). ~114 LOC in one file. No decision points touched.

## Decision-point inventory

No decision-point surface. `syncChatDb` only compares inodes and recreates hardlinks under the agent's own `imessage/` dir. It gates nothing, blocks nothing, filters nothing, and reads no message content.

---

## 1. Over-block
No block/allow surface — over-block not applicable.

## 2. Under-block
No block/allow surface — under-block not applicable. (Coverage note: it maintains exactly the three files SQLite needs for a consistent WAL read; a `-wal`/`-shm` legitimately absent when the DB is momentarily not in WAL mode is skipped, not errored.)

## 3. Level-of-abstraction fit
Correct layer. Maintaining hardlinks to a Full-Disk-Access-protected path requires FDA; this binary is the one component that has it and is already doing exactly this for attachments. Putting the chat.db maintenance here (rather than in the FDA-less node daemon, whose `IMessageAdapter.ensureChatDbHardlink` can only try at startup and usually lacks the permission) puts the work where the capability lives. It is a maintainer/detector, not an authority.

## 4. Signal vs authority compliance
Compliant. The change adds zero blocking authority. It is pure idempotent side-effect maintenance (keep a file pointer current). `docs/signal-vs-authority.md` is satisfied trivially — there is no brittle check wired to a block.

## 5. Interactions
Complementary with `IMessageAdapter.ensureChatDbHardlink()` (daemon-side, startup-only): both create the same links and both no-op when the inode already matches, so they cannot fight destructively. Worst case is a sub-millisecond window where one removes-and-relinks while the other stats; SQLite tolerates a transient WAL/SHM swap and the daemon opens `query_only`. Does not shadow or race the attachments sync (separate files, separate code path; the attachments FSEvents watcher is untouched). The 2s ticker only re-links on actual inode drift, so steady-state cost is three `stat()` calls per tick.

## 6. External surfaces
The only external surface is the freshness of the daemon's read view of `chat.db` — which is the point (it was stale; now it self-heals within 2s). No new network, message, or cross-agent surface. Hardlinks require live and private paths on the same filesystem — both are under `/Users/rolandcanyon`, so satisfied. Timing dependency is bounded and benign (≤2s to heal after a reboot).

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** The macOS Messages database and iMessage delivery are inherently tied to the single Mac that is logged into Messages; there is nothing to replicate or proxy. The hardlinks are local file pointers on that machine. No cross-machine posture applies. (The iMessage fork runs single-machine by nature.)

## 8. Rollback cost
Low. Restore the previous binary from the `.bak` kept alongside it and restart `ai.instar.AttachmentsWatcher`. Caveat worth recording: because macOS TCC pins Full Disk Access to a binary's code signature, replacing the binary (either direction) requires a one-time re-grant of Full Disk Access via System Settings — this is a documented manual step (see `/imessage-doctor` skill), not a code rollback concern. No data migration, no agent-state repair.
