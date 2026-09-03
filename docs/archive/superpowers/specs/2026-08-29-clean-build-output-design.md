# Clean Build Output Design

## Status

Approved for implementation under the operator's standing instruction to use
the recommended design without another confirmation gate.

## Problem

`npm run build` emits TypeScript directly into `dist/` without first removing
the previous output. When a source module is deleted or renamed, its old `.js`,
`.d.ts`, and `.js.map` files remain deployable and are included in the generated
build identity. A removed CLI entrypoint can therefore continue to execute.

## Design

Add `scripts/clean-dist.mjs` and run it before `tsc`. The script resolves the
repository root from its own module URL, derives exactly `<root>/dist`, verifies
that the target's parent and basename match that boundary, and only then removes
the directory recursively. It accepts an optional root argument solely for an
isolated test fixture; the same boundary check applies. Missing `dist/` is a
successful no-op.

Keep build identity generation unchanged after compilation. A successful build
therefore hashes only files emitted by the current compiler invocation. Do not
clean `node_modules`, runtime state, plugin configuration, or any path outside
the resolved repository root.

## Testing

A subprocess test creates a temporary repository-shaped directory, places a
stale nested artifact under `dist/` and an adjacent sentinel outside it, runs
the clean script, and verifies only `dist/` was removed. It runs the script a
second time to prove the missing-directory no-op. The normal build then proves
that `dist/main.js` and `dist/build-info.json` are regenerated.

## Deployment

This is a build-time change only. Do not restart the production service while
unrelated runtime source remains uncommitted.
