# Side-Effects: AgentMdJobLoader js-yaml type fix

## What changed

`src/scheduler/AgentMdJobLoader.ts` — The YAML listener callback parameters (`_kind` and `state`) were missing explicit TypeScript type annotations, causing two `TS7006: Parameter implicitly has an 'any' type` errors during `tsc`. Fixed by annotating them as `yaml.EventType` and `yaml.State` respectively.

`package-lock.json` — `js-yaml` was declared in `package.json` dependencies but absent from `node_modules` after the rebase (likely dropped during a prior lockfile merge). Running `npm install` restored it and updated the lockfile accordingly.

`src/data/builtin-manifest.json` — Regenerated as part of the normal `npm run build` step (timestamp + content-hash refresh to v0.28.101).

## Behavioral impact

None. This is a compile-time fix only. The runtime YAML parsing logic in `AgentMdJobLoader.ts` is unchanged — only the TypeScript type annotations were added to satisfy `tsc --noEmit`. The `yaml.State` and `yaml.EventType` types are exported from `@types/js-yaml` and match the actual js-yaml runtime signature exactly.

## Risk

Low. The change is confined to a two-character annotation on a listener callback. The listener itself only sets a boolean flag (`anchorSeen`) used downstream to reject YAML with anchors/aliases, which is security-motivated behavior. That logic is unaffected.
