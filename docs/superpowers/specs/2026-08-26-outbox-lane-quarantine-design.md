# Durable Outbox Lane Quarantine

## Purpose

Detect an outbox lane that cannot make progress, isolate unsafe successors, and
let safe newer work continue without weakening Answer Card ordering. SQLite
remains the delivery authority; the dispatcher only reports a classified
failure and asks the store for the durable transition.

## Existing gap

`outbox_lane_heads` currently contains only pending rows. When a head becomes a
dead letter, its trigger immediately advances the lane to the next pending row.
That is safe for replaceable Main Card snapshots, but unsafe for Answer CardKit
streams: skipping one content sequence and sending later content or finish work
can produce sequence gaps and cascading failures. Current status reports only
aggregate pending/blocked counts and cannot say which lane is quarantined or
why.

## Chosen design

Add a durable `outbox_lane_quarantines` table keyed by `lane_key`. A quarantine
records the failed head reply, lane class, failure class, reason, creation time,
release time, and release outcome. The store creates or updates it in the same
transaction that dead-letters the head and handles successors.

The transition depends on lane semantics:

- `answer:<promptId>`: dismiss pending stream content and finish rows for the
  failed page. If a continuation-card create is already durable, retain it. The
  active page is never patched past a failed sequence. Wake
  `AnswerPageWorkflow`, which reloads the canonical RunCard answer and reserves a
  safe continuation or terminal state.
- Main Card `session_status`: retain the dead letter for audit, dismiss obsolete
  pending versions at or below it, and allow a strictly newer durable TopicView
  version to reserve a new update. The same failed version is not recreated.
- replaceable non-Answer card update: retain the dead letter and allow the newest
  coalesced successor to proceed.
- immutable card creation, text, and unknown lanes: quarantine the lane and do
  not automatically release successors. They require an explicit retry or
  dismiss decision because bypassing creation can make later targets invalid.

Transient failures (429, 5xx, timeouts, transport errors) remain pending with
backoff. Exhausting their normal retry and single cooled recovery round creates
a quarantine; it does not silently classify the failure as safe to bypass.

## Detection

Detection is based on durable facts, not wall-clock polling alone:

1. A permanent delivery error immediately dead-letters the head and evaluates
   lane quarantine policy.
2. A transient error remains a blocked pending head until retry exhaustion.
3. After its one automatic cooled recovery round also exhausts, the head becomes
   a durable quarantine.
4. Status additionally calls a pending head `stalled` when it is older than a
   validated threshold and its `next_attempt_at` is due. Age alone never mutates
   delivery state.

## Recovery and operator actions

Manual retry reopens the dead-lettered head and marks its quarantine `released`
with outcome `manual_retry`; lane ordering again starts at that row. Manual
dismiss marks the quarantine `released` with outcome `manual_dismiss` and applies
the same lane-specific successor policy transactionally. Answer workflow
checkpoint listeners are woken after an Answer quarantine transition so missing
content is reconstructed from durable state.

Quarantine operations are idempotent. Repeated failure callbacks, restart, and
lost process-local wake-ups cannot duplicate a quarantine or dismiss unrelated
lanes. Startup and periodic outbox scans see the durable lane state.

## Observability

`/status` adds bounded, identifier-safe lane diagnostics:

- active quarantine count, split by lane class and failure class;
- stalled due-head count and oldest stalled age;
- latest quarantine with reply kind, bounded reason, and timestamps;
- released quarantine count and latest release outcome.

Logs include the lane class, reply kind, failure class, quarantine action, and
outcome, but never card payload, prompt text, raw Lark response, or credentials.
Readiness remains ready when one lane is quarantined because unrelated lanes and
prompt durability continue to work; status is degraded only through operational
diagnostics, not by failing the process.

## Boundaries

This slice does not change prompt dispatch, steering, Herdr authority, Answer
page size, CardKit typewriter settings, retry classification, or manual approval
policy. It does not automatically delete dead letters. Circuit breaking, startup
binding isolation, and periodic SQLite integrity audits are separate later
slices.

## Verification

Tests must prove:

- transient backoff continues to block its lane and not other lanes;
- permanent replaceable snapshots release only a strictly newer successor;
- an Answer content/finish failure cannot let later sequences bypass it;
- Answer quarantine wakes reconstruction and never patches a frozen page;
- immutable creation and unknown lanes remain quarantined;
- retry and dismiss update quarantine state atomically and idempotently;
- restart rebuilds correct lane heads without losing quarantine state;
- status diagnostics are bounded and contain no payload or prompt text;
- existing Answer Page and Main Card durable-delivery suites remain green.

## Rollout evidence (2026-08-26)

- Code commit: `0b5de0a0a28c425db501f053c0ed159c2f0d17f7`
- Build ID: `sha256:01da75d887284b726247c65ccde4525e0b0b35ab740b6e8a4f715ad8cca2af78`
- Verification: `npm test` passed 64 files and 571 tests; `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Runtime: `herdr-lark-bridge.service` active; `/status` reported `status=ok` and `/ready` reported `ready`; expected and observed identities matched the code commit and build ID above.
- Production SQLite: migration version 5 present exactly once; duplicate active quarantines, active quarantines with lane heads, active Answer quarantines with pending successors, stale lane heads, and active quarantines were all zero.
