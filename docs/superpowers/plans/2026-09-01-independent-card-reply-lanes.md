# Independent Card Reply Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a failed independent Lark reply from blocking later `/instance` and other replies to the same topic, while safely converging the existing production outbox.

**Architecture:** Give every independent `card_reply` or `text` outbox row a durable `reply:<id>` lane. Preserve prompt-scoped Answer lanes and target-message-scoped update/stream lanes. An idempotent migration rewrites legacy reply lanes and moves any matching quarantine to the failed row's isolated lane before rebuilding lane heads.

**Tech Stack:** TypeScript, Node.js SQLite (`DatabaseSync`), Vitest, Lark CardKit outbox, user systemd.

**Spec:** `docs/superpowers/specs/2026-09-01-independent-card-reply-lanes-design.md`

## Global Constraints

- Do not replay TraeX prompts or Worker turns.
- Preserve dead-letter rows and error metadata for audit.
- Keep Answer and card-update ordering unchanged.
- Do not edit generated `dist/` or the live SQLite database manually.
- Commit source changes before installation and use the supported service lifecycle.

---

### Task 1: Lock Down Independent Reply Lane Semantics

**Files:**
- Modify: `tests/sqlite-store.test.ts`
- Modify: `src/store/outbox-lanes.ts`

**Interfaces:**
- Consumes: `outboundLaneKey(input)` and `SqliteBindingStore.enqueueOutboundReply(...)`.
- Produces: `card_reply` and `text` lane keys shaped as `reply:<outboundReplyId>`.

- [ ] **Step 1: Write the failing store test**

Add a test that enqueues two `card_reply` rows with the same `rootMessageId`, permanently fails the first with `markOutboundReplyFailedWithQuarantine`, and expects the second row to remain visible through `listOutboundLaneHeads`. Assert the two persisted `lane_key` values are `reply:first` and `reply:second`.

- [ ] **Step 2: Run the focused test and verify the current implementation fails**

Run: `npx vitest run tests/sqlite-store.test.ts -t "isolates independent replies"`

Expected: FAIL because both rows currently use `message:<rootMessageId>` and the first quarantine hides the second.

- [ ] **Step 3: Implement the minimal lane-key rule**

Update `outboundLaneKey` so Answer and stream cases remain first, `card_update` returns `message:<rootMessageId>`, and `card_reply`/`text` return `reply:<id>`. Extend the function input type with `id: string`. Update `outboundLaneKeySql()` to use SQL column `id` for independent replies.

- [ ] **Step 4: Re-run the focused test**

Run: `npx vitest run tests/sqlite-store.test.ts -t "isolates independent replies"`

Expected: PASS.

### Task 2: Migrate Legacy Shared Reply Lanes

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `schema_migrations`, `outbound_replies`, `outbox_lane_quarantines`, and `outbox_lane_heads`.
- Produces: schema migration version 7 with isolated legacy reply lanes and rebuilt lane heads.

- [ ] **Step 1: Write the failing reopen/migration test**

Create a file-backed store, insert a failed `card_reply`, an active immutable quarantine, and a pending successor sharing `message:root-1`. Remove migration version 7, close, and reopen. Assert:

```ts
expect(replyLanes).toEqual([
  { id: "failed", lane_key: "reply:failed", state: "dead_letter" },
  { id: "later", lane_key: "reply:later", state: "pending" }
]);
expect(quarantine).toMatchObject({ lane_key: "reply:failed", failed_reply_id: "failed", state: "active" });
expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toContain("later");
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `npx vitest run tests/sqlite-store.test.ts -t "migrates legacy shared reply lanes"`

Expected: FAIL because reopening preserves the old shared lane and active quarantine.

- [ ] **Step 3: Implement migration version 7 transactionally**

Add `ensureIndependentReplyLanes()` after lane quarantine/head schema setup. In one immediate transaction: move active/released quarantines whose failed row is `card_reply` or `text` to `reply:<failed_reply_id>`; rewrite all `card_reply` and `text` rows to `reply:<id>`; clear and rebuild `outbox_lane_heads`; insert migration version 7; commit. Roll back on error.

- [ ] **Step 4: Run focused store tests**

Run: `npx vitest run tests/sqlite-store.test.ts`

Expected: PASS, including migration idempotency and unchanged card-update ordering.

### Task 3: Verify Dispatcher Isolation and Documentation

**Files:**
- Modify: `tests/lark-outbox-dispatcher.test.ts` if the store test does not exercise delivery strongly enough.
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `LarkOutboxDispatcher`, lane-head scanning, and the lane model from Task 1.
- Produces: end-to-end outbox evidence that a failed reply cannot block a later independent reply.

- [ ] **Step 1: Add a dispatcher regression if needed**

Configure fake Lark delivery to reject the first independent reply permanently and accept the second. Assert the second reaches `delivered` without retrying the first after quarantine.

- [ ] **Step 2: Update architecture documentation**

Document that immutable reply creation is isolated per outbox row, while updates and streams remain serialized by their mutable target. State that legacy shared reply lanes are migrated without replaying agent work.

- [ ] **Step 3: Run focused outbox tests**

Run: `npx vitest run tests/sqlite-store.test.ts tests/lark-outbox-dispatcher.test.ts`

Expected: PASS.

### Task 4: Validate and Commit

**Files:**
- Verify all modified source, test, and documentation files.

**Interfaces:**
- Consumes: repository build/test commands.
- Produces: one committed, deployable fix.

- [ ] **Step 1: Run TypeScript and build verification**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0 and build identity is generated.

- [ ] **Step 2: Run the full suite**

Run: `npm test`

Expected: all relevant tests pass. If the known isolated release-retention test fails again, record its exact result and confirm no additional failures.

- [ ] **Step 3: Review the diff and commit only task files**

Run: `git diff --check`, inspect `git diff`, then stage only the lane source, tests, and architecture documentation.

Commit: `fix: isolate independent Lark reply lanes`

### Task 5: Deploy and Verify Production Recovery

**Files:**
- Read only: configured production SQLite database and service log.
- Generated by installer: immutable staged release outside the checkout.

**Interfaces:**
- Consumes: `./install.sh`, `npm run swarm:restart`, `npm run swarm:status`.
- Produces: a ready service running the committed build and a delivered corrected instance-detail reply.

- [ ] **Step 1: Capture pre-deploy durable state**

Record the target pending reply ID, failed reply ID, active quarantine, pending prompt count, and active observers. Do not mutate the database directly.

- [ ] **Step 2: Install and restart through supported lifecycle**

Run `./install.sh`, then `npm run swarm:restart`. If the safety gate blocks only on already-inspected detached observers or queued durable work, use the established explicit force option without deleting or replaying that work.

- [ ] **Step 3: Verify build and readiness**

Run `npm run swarm:status` and confirm the deployed commit/build identity, PID ownership, lease, Herdr/Lark dependency state, and readiness.

- [ ] **Step 4: Verify migrated rows and delivery**

Query the production database. Expect the old failed reply to remain `dead_letter` on `reply:<failed-id>` with an active quarantine, and the corrected `/instance reviewer` reply to become `delivered` with `attempt_count >= 1`. Correlate its reply ID in the service log. If Lark rejects it, capture the exact code/path and return to a failing card regression before any further edit.
