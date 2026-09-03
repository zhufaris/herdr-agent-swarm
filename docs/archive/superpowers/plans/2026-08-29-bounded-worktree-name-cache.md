# Bounded Worktree Name Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the long-lived worktree-name cache while preserving TTL and negative-cache behavior.

**Architecture:** Extend `WorktreeNameResolver` with a default 256-entry LRU limit. Cache access maintains insertion order, misses prune expired entries, and insertion evicts the oldest live entries.

**Tech Stack:** TypeScript, Vitest, Node.js Map

**Spec:** docs/superpowers/specs/2026-08-29-bounded-worktree-name-cache-design.md

## Global Constraints

- Default maximum cache size is 256.
- Cache hits do not extend the existing 30-second TTL.
- Failed Git lookups remain negatively cached.
- No background timer or host path logging is added.

---

### Task 1: Specify bounded LRU behavior

**Files:**
- Modify: `tests/worktree-name-resolver.test.ts`

**Interfaces:**
- Consumes: `new WorktreeNameResolver(runner, timeoutMs, ttlMs, clock, maxEntries)`.
- Produces: observable bounded eviction through subsequent `runner.run` calls.

- [ ] Add a two-entry test that resolves A and B, hits A, inserts C, then proves B is re-resolved while A remains cached.
- [ ] Add an injected-clock test proving expired entries are pruned before capacity eviction.
- [ ] Run the focused test and require failure against the current unbounded cache.

### Task 2: Implement and verify the bounded cache

**Files:**
- Modify: `src/runtime/worktree-name-resolver.ts`

**Interfaces:**
- Consumes: existing resolver arguments plus optional `maxEntries`.
- Produces: bounded TTL-aware LRU caching for both values and nulls.

- [ ] Move live hits to the Map tail without changing `expiresAt`.
- [ ] Delete expired entries on misses.
- [ ] Evict oldest entries after insert until size is within the clamped limit.
- [ ] Run focused tests, `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Commit only this batch as `perf: bound worktree name cache`.
