# Clean Build Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every production build starts from an empty, repository-local `dist/` directory.

**Architecture:** A standalone Node script owns safe output cleanup. The package build command invokes it before TypeScript compilation and build-identity generation.

**Tech Stack:** Node.js ESM, TypeScript, Vitest

**Spec:** docs/superpowers/specs/2026-08-29-clean-build-output-design.md

## Global Constraints

- Delete only the resolved `<repository-root>/dist` directory.
- A missing output directory is a successful no-op.
- Preserve all runtime state, configuration, dependencies, and source files.
- Do not restart production while unrelated runtime source remains uncommitted.

---

### Task 1: Specify safe cleanup behavior

**Files:**
- Create: `tests/clean-dist.test.ts`
- Create: `scripts/clean-dist.mjs`

**Interfaces:**
- Consumes: an optional repository-root command-line argument.
- Produces: deletion of exactly `<root>/dist`, or a zero-exit no-op when absent.

- [ ] Write a subprocess test that creates `dist/nested/stale.js` and `sentinel.txt`, executes `node scripts/clean-dist.mjs <fixture-root>`, and asserts that `dist` is absent while the sentinel remains.
- [ ] Execute the same command again and assert a zero exit status.
- [ ] Run `npx vitest run tests/clean-dist.test.ts`; require failure because the script does not exist.
- [ ] Implement root resolution, exact parent/basename validation, and `rmSync(dist, { recursive: true, force: true })`.
- [ ] Run the focused test and require it to pass.

### Task 2: Integrate and verify the clean build

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/clean-dist.mjs`.
- Produces: `npm run build` as clean -> compile -> generate identity.

- [ ] Change `build` to `node scripts/clean-dist.mjs && tsc -p tsconfig.json && node scripts/generate-build-info.mjs`.
- [ ] Place a unique stale file under `dist/`, run `npm run build`, and assert the stale file is gone while `dist/main.js` and `dist/build-info.json` exist.
- [ ] Run `npx vitest run tests/clean-dist.test.ts tests/build-identity.test.ts`.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit only the spec, plan, script, package metadata, and focused test as `build: remove stale output before compile`.
