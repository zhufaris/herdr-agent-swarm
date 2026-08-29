# Bounded Transcript Path Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound TraeX transcript path memory while preserving validated fast-path reuse for recently active sessions.

**Architecture:** Extend `TraexTranscriptReaderOptions` with a cache capacity and use the existing `Map` insertion order as LRU. Test only through `open()` in a new test file so unrelated pending transcript-rendering edits remain isolated.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-bounded-transcript-path-cache-design.md`

## Global Constraints

- Default capacity is exactly 256 session paths.
- Every cache hit still validates path containment and session metadata.
- A valid hit refreshes LRU order; it does not skip filesystem validation.
- Missing, ambiguous, and invalid discoveries remain uncached.
- Do not modify the currently dirty `tests/traex-transcript.test.ts`.

---

### Task 1: Bound Transcript Paths with LRU

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Create: `tests/traex-transcript-cache.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptReader.open(session): Promise<TraexTranscriptOpenResult>`.
- Produces: `TraexTranscriptReaderOptions.maxCachedPaths?: number`.

- [ ] **Step 1: Write the failing LRU behavior test**

Create three valid UUID transcript files and a reader with `maxCachedPaths: 2`. Open session 1, session 2, session 1 again, then session 3. Add duplicate valid files for sessions 1 and 2. Assert session 1 remains `typed` from cache and session 2 becomes `ambiguous_transcript` after eviction and rescan.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/traex-transcript-cache.test.ts`

Expected: FAIL because the current unbounded map retains both session 1 and session 2.

- [ ] **Step 3: Implement bounded LRU insertion**

Add `maxCachedPaths` to the options, default it to 256, delete/reinsert a valid hit, and route newly discovered paths through a private insertion helper that evicts oldest entries until the normalized capacity is met.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/traex-transcript-cache.test.ts tests/traex-transcript.test.ts`

Expected: both transcript test files pass.

- [ ] **Step 5: Run repository verification**

Run: `npm run typecheck && npm test && npm run build`

Expected: all commands succeed.

Run: `git diff --check -- src/runtime/traex-transcript.ts tests/traex-transcript-cache.test.ts`

Expected: no whitespace errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/runtime/traex-transcript.ts tests/traex-transcript-cache.test.ts
git commit -m "perf: bound transcript path cache"
```
