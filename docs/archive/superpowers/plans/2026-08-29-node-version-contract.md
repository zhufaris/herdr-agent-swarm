# Node Version Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the declared and enforced Node.js minimum match the locked build toolchain at Node.js 22.12+.

**Architecture:** A pure ESM helper owns version comparison and doubles as the CLI check. Both install paths call it before `npm ci`; package metadata and active documentation declare the same floor.

**Tech Stack:** Node.js ESM, Bash, npm, Vitest

**Spec:** docs/superpowers/specs/2026-08-29-node-version-contract-design.md

## Global Constraints

- The supported floor is Node.js 22.12.
- Node.js 23 and later remain accepted.
- Both standalone and plugin installs fail before dependency installation on an unsupported runtime.
- Historical design records are not rewritten.

---

### Task 1: Define and test the shared version check

**Files:**
- Create: `scripts/check-node-version.mjs`
- Create: `tests/node-version-contract.test.ts`

**Interfaces:**
- Consumes: a Node semantic version string.
- Produces: `supportsNodeVersion(version): boolean` and a direct CLI exit check.

- [ ] Add boundary tests for 22.11.99, 22.12.0, 23.0.0, and malformed input.
- [ ] Run the focused test and require failure because the helper does not exist.
- [ ] Implement numeric major/minor comparison and guarded CLI execution.
- [ ] Run the focused test and require it to pass.

### Task 2: Unify installation and metadata contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `install.sh`
- Modify: `plugin/build.sh`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `tests/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: `scripts/check-node-version.mjs`.
- Produces: one enforced and documented Node.js 22.12+ contract.

- [ ] Assert package metadata and both installer paths reference the 22.12 contract and shared checker.
- [ ] Replace the inline plugin expression and add the same preflight to standalone installation.
- [ ] Update active requirements documentation and lockfile root metadata.
- [ ] Run focused tests, `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Commit only this batch as `build: align minimum node version`.
