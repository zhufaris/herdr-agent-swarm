# Main Card Sequence Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild a topic Main Card when CardKit rejects its durable full update with business code `300317`.

**Architecture:** Keep business-response validation in the Lark adapter and recovery policy in the durable SQLite outbox transition. Extend the existing locked-card replacement branch so `300317` immediately replaces the stale CardKit entity with the latest desired snapshot.

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-08-30-main-card-sequence-recovery-design.md`

## Global Constraints

- Persist replacement intent before Lark delivery.
- Never repeat a TraeX prompt.
- Recover only Main Card `session_status` updates.
- Preserve unrelated dirty-worktree changes.
- Use supported install and service lifecycle commands.

---

### Task 1: Lock down the sequence-conflict recovery

**Files:**
- Modify: `tests/lark-outbox-dispatcher.test.ts`
- Modify: `src/store/sqlite-store.ts`

**Interfaces:**
- Consumes: `markOutboundReplyFailedWithQuarantine(id, error, metadata, retryDelayMs)`
- Produces: `rebuild_main` transition for Main Card Lark codes `230099` and `300317`

- [ ] Add a dispatcher test whose `updateCardKit` throws an error with `larkCode: 300317`.
- [ ] Assert one update attempt, immediate dead-letter state, `rebuild_main`, delivery of the newest snapshot through `card_reply`, and replacement of `statusMessageId`.
- [ ] Run `npx vitest run tests/lark-outbox-dispatcher.test.ts -t "rebuilds a Main Card after a CardKit sequence conflict"` and confirm it fails because no replacement is queued.
- [ ] Extend the existing locked-Main-Card predicate to recognize `300317` as a stale CardKit entity requiring replacement.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Verify the delivery boundary

**Files:**
- Verify: `src/adapters/lark-adapter.ts`
- Verify: `src/events/lark-outbox-dispatcher.ts`
- Verify: `src/store/sqlite-store.ts`
- Verify: `tests/lark-adapter.test.ts`
- Verify: `tests/lark-outbox-dispatcher.test.ts`
- Verify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: CardKit business errors carrying `larkCode`
- Produces: durable Main Card convergence through a fresh message/card entity

- [ ] Run `npx vitest run tests/lark-adapter.test.ts tests/lark-outbox-dispatcher.test.ts tests/sqlite-store.test.ts`.
- [ ] Run `npm run typecheck`, `npm run build`, `git diff --check`, and `npm test`.
- [ ] Confirm no debug instrumentation or unrelated files are staged.
- [ ] Commit only the sequence-recovery spec, plan, source, and focused test.

### Task 3: Deploy and prove real convergence

**Files:**
- Verify: installed release identity and `/status` output
- Verify: live SQLite `topic_views` and `outbound_replies` rows

**Interfaces:**
- Consumes: `./install.sh`, `npm run swarm:restart`, `/ready`, `/status`
- Produces: a live Main Card whose latest desired version is confirmed delivered

- [ ] Install the committed immutable release with `./install.sh`.
- [ ] Wait for zero active prompt/instance/outbox work, then restart without `--force`.
- [ ] Confirm expected and observed commit/build identities match, readiness is ready, ownership matches, startup recovery completed, and SQLite quick check is healthy.
- [ ] Trigger a fresh Main Card-visible state change.
- [ ] Confirm the corresponding `card_update` is `delivered`, `TopicViewState.deliveredVersion` reaches the desired `viewVersion`, and no new `300317` remains pending.
