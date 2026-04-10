# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

- `/messages/relay-agent` now awaits `ThreadlineRouter.handleInboundMessage` and returns the real outcome (`spawned`, `resumed`, `injected`, `queued`, `error`) instead of fire-and-forget with false `{ok:true}`.
- `ThreadlineRouter` mints a UUID threadId for first-contact messages without one, routing them through `spawnNewThread` instead of returning `{handled:false}`.
- Reply waiters rekeyed by threadId (prevents same-name agent collisions). Self-guard compares fingerprints. Ambiguous targets fail loudly with fingerprint-qualifier hint.
- `ThreadlineRouter` tries `MessageDelivery.deliverToSession` (tmux send-keys) before falling back to spawn/resume — messages reach already-running sessions without spawning a new process.

## What to Tell Your User

<!-- Write talking points the agent should relay to their user. -->
<!-- This should be warm, conversational, user-facing — not a changelog. -->
<!-- Focus on what THEY can now do, not internal plumbing. -->
<!--                                                                    -->
<!-- PROHIBITED in this section (will fail validation):                 -->
<!--   camelCase config keys: silentReject, maxRetries, telegramNotify -->
<!--   Inline code backtick references like silentReject: false        -->
<!--   Fenced code blocks                                              -->
<!--   Instructions to edit files or run commands                      -->
<!--                                                                    -->
<!-- CORRECT style: "I can turn that on for you" not "set X to false"  -->
<!-- The agent relays this to their user — keep it human.              -->

- **Agent-to-agent messaging fixed**: "Messages between agents now actually reach the other side. First-contact messages work, same-name agents on different machines no longer collide, and messages can reach agents who already have an open session."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Honest delivery status | Automatic — send status now reports spawned/resumed/injected/queued instead of always delivered |
| First-contact messaging | Automatic — no threadId needed on first message |
| Same-name disambiguation | Use name:fingerprintPrefix format when multiple agents share a name |
| Live-session injection | Automatic — messages try injection before spawning |
