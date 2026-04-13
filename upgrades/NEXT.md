# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Scheduler skip events now report the actual gating reason instead of always saying "quota".

When a job is blocked from spawning, the scheduler runs `canRunJob(priority)`. Previously this callback returned a bare `boolean`, so when it returned `false` the scheduler unconditionally logged `Job "X" skipped (quota)` and recorded reason `quota` in the SkipLedger — even when the real cause was memory pressure or another gate stacked on top of quota.

Now the callback may return either a boolean (legacy behavior) or a richer `CanRunJobResult`:

```ts
interface CanRunJobResult {
  allowed: boolean;
  reason?: SkipReason;   // 'quota' | 'memory-pressure' | 'gate' | ...
  detail?: string;       // human-readable context
}
```

The server's memory gate wrapper (`src/commands/server.ts` ~line 4097) now returns the rich form, surfacing `memory-pressure` plus the underlying `memCheck.reason` (e.g. `"elevated (79.9%)"`). The scheduler logs this verbatim, records it in the SkipLedger as `memory-pressure`, and includes `gateReason` / `gateDetail` in the `job_skipped` event metadata.

A new `'memory-pressure'` value was added to the `SkipReason` union.

This fixes a long-standing diagnostic confusion where 31+ jobs would appear "skipped (quota)" in logs while `/quota` reported normal — because the actual cause was memory pressure on a 16GB machine sitting at 79% baseline usage.

Backwards compatible: any existing `canRunJob` wrapper that returns a plain boolean continues to work and still records reason `quota`.

## What to Tell Your User

- **Clearer skip reasons**: "When I can't start a job, I'll now tell you exactly why — memory pressure versus quota versus a gate check — instead of always blaming quota. That should make it much faster to figure out why scheduled work isn't running."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Memory-pressure skip reason | Automatic — appears in skip ledger and `job_skipped` events |
| Rich `CanRunJobResult` from gate callbacks | Return `{ allowed, reason, detail }` from custom `canRunJob` wrappers |
