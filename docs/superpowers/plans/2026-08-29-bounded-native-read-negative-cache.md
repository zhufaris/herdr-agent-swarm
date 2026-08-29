# Bounded Native Read Negative Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound and expire `agent_not_found` native-read suppression so the bridge avoids tight-loop RPC failures without permanently disabling recovered panes or retaining unlimited pane IDs.

**Architecture:** Keep the optimization private to `HerdrCliAdapter`. Replace its negative-result `Set` with a timestamped `Map` whose insertion order implements LRU, and expose only an optional constructor policy for deterministic tests; all observable behavior remains through `readOutput()`.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, existing Herdr native client and command-runner abstractions

**Spec:** `docs/superpowers/specs/2026-08-29-bounded-native-read-negative-cache-design.md`

## Global Constraints

- Default negative-cache TTL is exactly 30,000 milliseconds.
- Default maximum cache size is exactly 256 pane IDs.
- Cache hits update LRU order but do not extend expiration.
- Only `agent_not_found` failures enter the negative cache.
- Every native read failure still falls back to `herdr pane read`.
- Do not modify SQLite workflow state, Lark delivery, or replay behavior.
- Preserve all existing `HerdrCliAdapter` constructor calls.

---

### Task 1: Expiring and Bounded Native Read Suppression

**Files:**
- Modify: `src/adapters/herdr-adapter.ts`
- Test: `tests/herdr-adapter.test.ts`

**Interfaces:**
- Consumes: `HerdrCliAdapter.readOutput(paneId: string, lines: number): Promise<string>` and `HerdrNativeRequestClient.request(...)`.
- Produces: optional final constructor policy `{ nativeReadNegativeTtlMs?: number; nativeReadNegativeMaxEntries?: number; clock?: () => number }`; no new public read method.

- [ ] **Step 1: Write the failing expiration recovery test**

Add a test that injects `clock`, makes the first `agent.read` reject with `agent_not_found`, verifies an immediate second read uses CLI without another native request, advances time past 30,000 ms, and makes the third read return native output. Assert native was called twice and CLI only twice.

- [ ] **Step 2: Run the expiration test to verify it fails**

Run: `npx vitest run tests/herdr-adapter.test.ts -t "retries native reads after the negative cache expires"`

Expected: FAIL because the constructor has no cache policy and the permanent set suppresses the third native request.

- [ ] **Step 3: Implement TTL-aware negative entries**

In `HerdrCliAdapter`, replace `Set<string>` with `Map<string, number>`, where the number is `expiresAt`. Add an optional final policy constructor parameter with defaults. Before `agent.read`, remove an expired matching entry; for a valid hit, delete and reinsert the same expiration to update LRU order, then use CLI. On `agent_not_found`, store `clock() + max(0, ttlMs)`. Do not cache other failures.

- [ ] **Step 4: Run the expiration test to verify it passes**

Run: `npx vitest run tests/herdr-adapter.test.ts -t "retries native reads after the negative cache expires"`

Expected: PASS with one suppressed read followed by native recovery.

- [ ] **Step 5: Write the failing LRU-capacity test**

Add a test with maximum size two. Cache failures for panes `p1` and `p2`, touch `p1` through another read, then cache `p3`. Read `p1` and `p2` again. Assert `p1` remains suppressed while `p2`, the least recently used entry, performs a new native request.

- [ ] **Step 6: Run the LRU test to verify it fails**

Run: `npx vitest run tests/herdr-adapter.test.ts -t "evicts the least recently used native-read failure"`

Expected: FAIL because capacity eviction is not yet implemented.

- [ ] **Step 7: Implement expiration pruning and capacity eviction**

When recording a failure, remove every entry whose expiration is not greater than the current clock value, insert the new entry as newest, normalize the capacity with `Math.max(1, Math.floor(value))`, and delete oldest map keys until within the bound. Keep this logic private to the adapter and timer-free.

- [ ] **Step 8: Run focused verification**

Run: `npx vitest run tests/herdr-adapter.test.ts`

Expected: the complete adapter test file passes, including the existing native fallback and read-coalescing coverage.

- [ ] **Step 9: Run repository verification**

Run: `npm run typecheck`

Expected: TypeScript exits successfully.

Run: `npm test`

Expected: all Vitest files and tests pass.

Run: `npm run build`

Expected: clean compilation and build-identity generation succeed.

Run: `git diff --check -- src/adapters/herdr-adapter.ts tests/herdr-adapter.test.ts`

Expected: no whitespace errors.

- [ ] **Step 10: Commit the implementation**

```bash
git add src/adapters/herdr-adapter.ts tests/herdr-adapter.test.ts
git commit -m "perf: bound native read fallback cache"
```
