# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Secret management setup (Phase 1 of the setup wizard) no longer uses a Claude Code micro-session for credential collection. Previously, the `/secret-setup` skill launched a Claude Code conversation that asked for Bitwarden passwords. Despite explicit instructions not to use `AskUserQuestion` for free-text input, Claude Code's training pressure consistently overrode the prompt instructions, resulting in confusing multi-choice menus appearing after password entry.

The fix is architectural: all credential-sensitive prompts now use native terminal prompts via `@inquirer/password` and `@inquirer/select` directly in `setup.ts`. The Claude Code session for secret setup is eliminated entirely. The flow:

1. Backend choice (bitwarden/local/manual) → `@inquirer/select` in TypeScript
2. Bitwarden credentials → `@inquirer/password` and `@inquirer/input` in TypeScript
3. Bitwarden CLI install/unlock/sync → `execFileSync` in TypeScript

This embodies "Structure > Willpower" — instead of hoping an LLM follows instructions about which tools to use, we removed the LLM from the credential-collection loop entirely.

## What to Tell Your User

- **Smoother setup experience**: "The secret management setup is cleaner now — no more confusing multi-choice menus when entering your Bitwarden password. It just asks for your password and moves on."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Native terminal password prompts | Automatic during `instar setup` — no behavior change needed |
