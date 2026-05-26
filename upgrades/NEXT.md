# Unreleased

## Fixed — Threadline topic-bound reply surfacing (CMT-515)

A reply from another agent on a Threadline thread bound to a Telegram topic now reliably reaches that topic instead of silently vanishing into the store. Root causes fixed:

- **Lost replies + broken history:** `ThreadResumeMap.get()` no longer nulls topic-linkage entries via the Claude-JSONL existence guard (a topic-linkage thread's liveness is its topic, not a transcript file). This repairs both inbound routing (replies were falling through to a throwaway session spawn) and `threadline_history` (which 404'd on threads that existed).
- **Relay-path leak:** topic-bound replies arriving over the cross-machine relay are no longer swallowed by the warm-listener side-channel; they reach the topic-linkage router.
- **Unreliable hand-off:** injecting a reply into a live session is now *confirmed* (a stalled paste no longer counts as delivered). When the hand-off stalls, a deterministic Telegram notification surfaces the reply as a safety net; when it succeeds, no duplicate notification is posted. Commitments resolve only on a confirmed user-facing surface.
- **History completeness + peer attribution:** both legs of a local conversation are now persisted to the thread aggregate, and the sender's originating topic is stamped on the delivered envelope so the peer can attribute replies to its own topic.
