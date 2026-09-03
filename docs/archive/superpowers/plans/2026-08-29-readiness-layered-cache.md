# Readiness Layered Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep expensive Herdr readiness probes cached while reporting volatile readiness state immediately.

**Architecture:** Replace the aggregate readiness cache with a cache for the Herdr workspace component. Compose a fresh readiness result around that cached component on every request.

**Tech Stack:** TypeScript, Node HTTP, Vitest

**Spec:** docs/superpowers/specs/2026-08-29-readiness-layered-cache-design.md

## Global Constraints

- Preserve the `/ready` and `/status` JSON schema.
- Preserve the 2-second default TTL for Herdr workspace probes.
- Preserve concurrent probe coalescing.
- Re-read database, projects, Lark, lease, and instance runtime on every request.

---

### Task 1: Specify immediate volatile-state visibility

**Files:**
- Modify: `tests/health-server.test.ts`

**Interfaces:**
- Consumes: `/ready` with a nonzero `readinessTtlMs`.
- Produces: immediate status changes without another Herdr workspace probe.

- [ ] Add a test that requests ready, flips lease/Lark/runtime state, requests again inside the TTL, and expects 503 with one workspace probe.
- [ ] Run the focused test and require it to fail against the aggregate cache.

### Task 2: Cache only workspace readiness

**Files:**
- Modify: `src/health/server.ts`

**Interfaces:**
- Consumes: cached asynchronous Herdr workspace inspection.
- Produces: a freshly composed `Readiness` for every request.

- [ ] Change the cache value to the Herdr component only.
- [ ] Move all volatile component reads outside the cached callback.
- [ ] Preserve failed-workspace errors, TTL, and in-flight coalescing.
- [ ] Run focused tests, `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Commit only this batch as `fix: refresh volatile readiness state`.
