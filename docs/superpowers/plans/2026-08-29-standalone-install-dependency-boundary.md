# Standalone Install Dependency Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow standalone installation without a local Herdr CLI while preserving plugin-mode validation.

**Architecture:** Split common build-tool checks from the plugin-only Herdr check around the existing standalone early return. Verify the shell control-flow contract without executing installation side effects.

**Tech Stack:** Bash, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-standalone-install-dependency-boundary-design.md`

## Global Constraints

- Preserve fail-fast dependency errors and all install commands.
- Do not execute `npm ci`, systemd installation, or Herdr linking in tests.
- Keep unrelated dirty files out of the commit.

---

### Task 1: Scope Herdr validation to plugin mode

**Files:**
- Modify: `install.sh`
- Modify: `tests/plugin-manifest.test.ts`

**Interfaces:**
- Preserves: `./install.sh`, `--setup`, and `--standalone` CLI behavior.

- [ ] Add a failing static contract test asserting the common loop is `node npm`, the standalone branch precedes the Herdr check, and plugin mode contains an explicit `command -v herdr`.
- [ ] Run `npx vitest run tests/plugin-manifest.test.ts` and confirm failure.
- [ ] Move Herdr validation below the standalone early return.
- [ ] Run the focused test and `bash -n install.sh`.
- [ ] Run `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Commit only the spec, plan, script, and test as `fix: allow standalone install without herdr cli`.
