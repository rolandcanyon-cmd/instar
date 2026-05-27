# Side-Effects Review — Cross-Machine Seamlessness: handoff ack/yield wire

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3d/G3e (converged, approved)

Third piece of the wire-transport increment. The point-to-point ack/yield channel
the two machines use to negotiate a verified, lease-safe planned handoff.

## What changed
- `src/core/HandoffWireTransport.ts` — NEW. Symmetric transport, used per-role:
  - OUTGOING: `awaitAck(timeoutMs)` (resolves when the incoming POSTs its ack via
    recordAck; null on timeout, timer unref'd), `sendYield()` (POST the explicit
    yield to the incoming).
  - INCOMING: `sendAck(ack)` (POST the "caught up" echo to the outgoing),
    `onYield(cb)`/`recordYield()` (the yield route triggers the incoming's lease CAS).
  All POSTs ride the authenticated channel (signRequest). Injected fetch/clock.
- `src/server/machineRoutes.ts` — NEW routes `POST /api/handoff/ack` and
  `POST /api/handoff/yield` (both authMiddleware). `/ack` validates the echo shape
  (tailSeq + ingressPosition + threadHistoryHash) and delivers it via `onHandoffAck`;
  `/yield` delivers via `onHandoffYield`. Both return 503 until their callback is
  wired (honest — consistent with the live-tail receiver), never a silent ok.

## Over-block / under-block
- The yield is the SOLE trigger for the incoming's lease CAS (the design closes the
  two-holders-same-epoch window). A dropped/missing yield → the incoming simply never
  acquires → the outgoing stays awake (safe under-action, no double-leader).
- `awaitAck` supersedes any stale pending wait and always resolves (ack or null) — it
  cannot wedge the HandoffSentinel.
- recordAck with no pending wait, recordYield with no handler, and no-peer sends are all
  safe no-ops / false returns (tested).

## Signal vs authority
- The transport carries no authority — it moves the ack and the yield. The DECISION to
  yield (verified ack + passing validation) lives in HandoffSentinel (§8 G3e), which is
  the next integrating step that constructs these ops; the lease CAS itself is the
  authority. This transport only delivers the negotiated signals.

## Interactions
- Reuses signRequest/machineAuthMiddleware (the same authenticated machine channel as
  /api/lease and /api/live-tail). 1:1 with the single peer (resolved by the caller).
- Consumes `HandoffAck`/`IngressPosition` from HandoffSentinel/types (already shipped).
- **Next piece (same increment):** construct HandoffWireTransport + HandoffSentinel in
  server.ts, bind HandoffOps (flush drives the live-tail broadcast + manifest; awaitAck
  uses this transport; sendYield/demoteSelf), wire onHandoffAck→recordAck and
  onHandoffYield→(incoming) recordYield→lease CAS, and add the race guard so the
  reaper/scheduler don't act mid-handoff (inProgress). At that point both routes go live.

## Rollback cost
- Minimal. Two additive routes (503 until wired) + one new standalone file. Reverting
  removes them with no behavior change to the running pipeline.

## Tests
- `tests/unit/HandoffWireTransport.test.ts` (7): awaitAck resolves on recordAck, awaitAck
  times out → null, sendYield/sendAck POST to the right endpoints with signed headers,
  onYield handler fires, no-peer → false, recordAck-with-no-pending safe no-op. tsc clean.
