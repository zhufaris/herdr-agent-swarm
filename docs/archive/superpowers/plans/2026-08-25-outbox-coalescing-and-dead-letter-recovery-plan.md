# Outbox Coalescing and Classified Dead-letter Recovery Implementation Plan

## Goal

Bound replaceable binding-status delivery backlog and recover only future Lark
dead letters whose durable evidence proves a transient failure, without
replaying TraeX prompts, disturbing lane order, or guessing about the 48 legacy
generic HTTP 400 failures.

## Slice 1: atomic binding-status snapshot coalescing

1. Evolve the existing uncommitted `enqueueOutboundReply` coalescing change
   rather than replacing it. Restrict the exact scope to binding ID, target
   message, lane key, `card_update`, null prompt, and pending state.
2. Put pruning and insertion under one existing write-fenced `BEGIN IMMEDIATE`
   transaction while preserving the oldest pending row as the possible
   in-flight lane barrier.
3. Retain the existing prompt/view-version coalescing behavior within the same
   atomic enqueue operation and preserve idempotency-key conflict semantics.
4. Extend SQLite tests for barrier-plus-newest behavior; binding, target-card,
   and lane isolation; answer/stream exclusions; duplicate idempotency; and an
   injected insertion failure proving prune and insert roll back together.

## Slice 2: additive failure metadata and safe classification

1. Add a versioned migration for nullable `failure_class`, `http_status`,
   `lark_error_code`, `dead_lettered_at`, and non-negative
   `auto_recovery_count DEFAULT 0`, plus the bounded recovery-scan index.
2. Extend `OutboundReply`, operational aggregates, and store ports with additive
   safe metadata and capability-focused failure/recovery operations. Legacy null
   classes must map to unknown behavior without rewriting rows.
3. Implement a pure delivery-error classifier returning only bounded error text,
   class, HTTP status, Lark code, and optional retry delay. Classify 429, 5xx,
   timeout, DNS, reset/refused, and transport failures as transient; local
   `PermanentDeliveryError` and a tested explicit invalid-target/malformed Lark
   code allowlist as permanent; classify all other errors as unknown.
4. Persist attempt count, retry time, classification, and sanitized structured
   fields atomically for every failed attempt. On terminal failure also persist
   `dead_lettered_at`; never persist response/request bodies, headers, secrets,
   or card payloads.
5. Add migration/reopen and mapper tests, plus classifier/dispatcher tests for
   429 `Retry-After`, 5xx, timeout and transport errors, recognized permanent
   codes, generic HTTP 400 as unknown, and safe structured logging.

## Slice 3: one-round automatic recovery

1. Add a bounded query for cooled dead letters whose class is transient and
   whose automatic recovery count is zero. The default cooldown is five
   minutes and the query exposes no payload.
2. Implement a write-fenced compare-and-set transaction that rechecks state,
   class, recovery count, and cooldown; changes the row to pending; sets the
   count to one; resets only the per-round attempt count; clears active error;
   and schedules immediate normal-lane delivery.
3. Run recovery before ordinary delivery during startup and periodic safety
   scans. Coalesce wake-ups and continue to use lane heads as the only delivery
   ordering authority. Manual retry must not reset the automatic budget.
4. Add tests for legacy/null, permanent, unknown, and uncooled rows remaining
   untouched; one eligible row reopening; duplicate/concurrent scans consuming
   the budget once; crash/restart after recovery commit; normal lane blocking;
   and a second five-attempt exhaustion never reopening automatically.

## Slice 4: diagnostics and operator behavior

1. Add aggregate dead-letter counts for transient, permanent, unknown, and
   legacy-null classes, plus the number currently eligible for recovery, to the
   operational summary and `/status` response.
2. Degrade `/status` when eligible automatic-recovery work remains persistently
   backlogged, without independently failing `/ready`. Keep current outbox and
   retired-pane health rules intact.
3. Add retry, dead-letter, and automatic-recovery logs keyed by reply ID, kind,
   lane, classification, safe status/code, recovery count, and outcome. Verify
   raw error bodies, headers, credentials, and card payloads are absent.
4. Keep `/herdr failures`, manual retry, and dismiss behavior as the operator
   path for unknown, permanent, and legacy rows; do not add bulk replay.

## Slice 5: migration proof, verification, and deployment

1. Run focused SQLite, dispatcher, health, card, and tool-output parser tests,
   including interruption and concurrent compare-and-set cases.
2. Run `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`
   with fresh output before completion claims.
3. Use SQLite online backup, including the live WAL state, to create a `/tmp`
   migration fixture. Open it with the new store and prove all 48 historical
   dead letters remain dead-lettered, null-class/unknown, and ineligible for
   automatic recovery. Never mutate the live database for this proof.
4. Commit thematic units: coalescing transaction/tests; schema/domain and
   classifier; automatic recovery and diagnostics. Keep the already isolated
   tool-heading fix and unrelated worktree changes out of those commits.
5. Build the actual managed checkout, restart through the Herdr plugin, and
   verify the generated build identity, `/ready=ready`, and `/status` healthy or
   only explicably degraded. Use non-mutating observation; do not send a live
   Lark retry or replay a TraeX prompt for deployment verification.

## Acceptance boundary

The work is complete only when coalescing cannot lose the newest snapshot across
an insertion failure, exact lane/card scope isolation is tested, failure
classification is durable and payload-free, concurrent recovery scans cannot
consume more than one automatic round, a recovered delivery never triggers a
TraeX prompt, every legacy dead letter remains untouched, and the managed
runtime reports a verified current build.
