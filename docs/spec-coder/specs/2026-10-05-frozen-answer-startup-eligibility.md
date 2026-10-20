# Frozen Answer Startup Eligibility

## Problem Statement

Startup selects an Answer whenever `view_version > answer_delivered_version` and an Answer page is active or finished. Historical rows can already contain a plan-prepared or claimed terminal effect for that exact current version, typically a rejected/dead-letter update to an obsolete CardKit target. Re-enqueuing the same idempotency key cannot be correct: the effect is frozen, and startup emits one `outbound_idempotency_conflict` warning per historical Answer on every restart.

## Solution

Both view-lag eligibility branches and the page-in-progress branch must exclude a terminal Run Card when an effect for its exact current Answer version is already frozen: page-backed lag, legacy message-only/card-ID-missing lag, and historical creating/active-streaming page state. Other independent actionable evidence continues to select the card:

- live/nonterminal Run Card phase;
- missing Answer message;
- creating or active streaming page without a frozen current-version effect;
- pending outbox work;
- active quarantine or replacement-pending delivery recovery;
- other existing startup obligations.

The frozen historical effect is preserved. Startup neither retries, dismisses, nor mutates it.

## User Stories

- **F1:** a terminal historical Answer with a frozen dead-letter effect for the current version is not re-enqueued solely because its delivered version lags.
- **F2:** an active quarantine or replacement-pending recovery remains actionable.
- **F3:** a lagging Answer without a frozen current-version effect remains actionable.
- **F4:** live, missing, streaming, and pending Answer cases remain unchanged.

## Implementation Decisions

### Domain Model

SQLite owns both desired projection version and frozen delivery-effect history. `answer_delivered_version` alone is insufficient to authorize replay once an exact-version effect crossed the plan/claim freeze boundary. Delivery Recovery remains the owner of explicit retries/replacements.

### Architecture

Refine only `SqliteProjectionStore.listActionableStartupRunCards()`. Define one named SQL anti-existence predicate for exact-version Answer `card_update` rows in terminal state whose plan/hash, first claim, attempt, or card checkpoint proves effect freeze, and reuse it in both lag branches and the page-in-progress branch. Do not add process memory, mutate rows, or catch idempotency errors in the coordinator.

### Behavior & Failure Modes

A frozen row suppresses generic convergence, not other actionable predicates. Unclaimed/dismissed mutable rows without freeze evidence do not suppress recovery. Active quarantine continues to override the exclusion. A replacement-pending recovery selects generic convergence only before it has a durable `replacement_reply_id`; once a replacement exists, pending delivery is rediscovered by the pending-outbox branch and terminal replacement outcomes remain owned by Delivery Recovery rather than replaying the current frozen key.

### Compatibility & Migration

No schema or data migration. Existing historical evidence is preserved.

## Testing Decisions

Extend the durable startup-selection integration test with terminal Answers whose exact current-version update is claimed, dead-lettered, and released from quarantine, covering page-backed lag, message-only/card-ID-missing lag, historical creating-page state, and stale replacement-pending recovery whose replacement already dead-lettered. The message-only fixture must use a non-active/non-finished page so only that branch can select it. Prove all frozen shapes are excluded while existing lagging, live, missing, streaming without frozen effect, pending, and active-quarantine cases remain selected. Explicitly prove that an older-version frozen effect, a current-version terminal row without freeze evidence, a replacement-pending recovery without a reserved replacement, and a replacement-pending recovery whose replacement is still pending remain actionable. Run full store/startup tests, typecheck, build, full suite, review, install, and live warning audit.

## Out of Scope

- dismissing or repairing historical `230001` dead letters;
- changing delivery-recovery eligibility;
- suppressing warnings for genuinely actionable failures.

## Further Notes

- In-place `main`, starting from `f7ba329b497e0b54790af30623dff2e907fde353`.
- User-owned dirty files remain untouched.
- Fresh baseline: 274 files / 3,957 tests, typecheck, and build passed.
- Standing implementation and deployment authorization applies.
