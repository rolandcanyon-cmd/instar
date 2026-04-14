# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

<!-- Describe what changed technically. What new features, APIs, behavioral changes? -->
<!-- Write this for the AGENT — they need to understand the system deeply. -->

- **SessionWatchdog: robust getClaudePid** — `getClaudePid()` previously assumed Claude runs as a child of the tmux pane's shell (`pgrep -P <pane_pid> -f claude`). When instar spawns claude directly as the pane's root process, Claude IS the pane_pid and has no `claude` child, so the helper returned null and `checkSession()` early-exited — silently disabling both stuck-command detection AND compaction-idle detection for these sessions. Now checks the pane's own command first, returning pane_pid directly when it's `claude`. `checkSession()` also now runs `checkCompactionIdle()` even when `getClaudePid` returns null (defense-in-depth: the compaction-idle path is output-based and its internal process guard is null-safe).

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

- **[Feature name]**: "[Brief, friendly description of what this means for the user]"

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| [Capability] | [Endpoint, command, or "automatic"] |
