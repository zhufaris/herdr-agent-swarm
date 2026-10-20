# Feishu Historical Projection Recovery

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The live bridge accepts Feishu ingress durably, but historical Core events and
their Turn Card projections can remain invisible indefinitely after their
original runtime route stops being active. Production evidence from build
`d1ce246a` showed no inbound-message backlog, while the Core projection backlog
contained 13,575 pending events across 53 lanes, 370 quarantined events, and
1,142 open projection gaps. Of the pending events, 13,521 belonged to a lane
with one provable durable owner. The oldest pending event dated from
2026-09-30.

The current `CoreSessionIngestionSupervisor` scans only active bindings and
active Worker sessions. Production ownership analysis attributed 10,028
pending events to orphaned-but-active bindings, 846 to archived bindings, and
2,701 to sessions no longer directly owned by a current runtime row. Five of
the latter lanes, containing 2,647 events, still had one exact owner through an
existing Conversation Segment.

Turn Card state showed 53 pages for active bindings with no message and no
prior outbound effect. These pages are safe candidates for first delivery.
Other missing pages are not equivalent: 45 were explicitly skipped by an
operator, 19 had an uncertain external effect, and 39 were rejected because
the original Feishu target no longer existed. Replaying those rows could create
duplicates, override an operator decision, or move content to the wrong
conversation.

Startup currently performs synchronous delivery repair and an eager Recovery
Supervisor scan before completing runtime startup. Historical catch-up must not
join either awaited path. It must also avoid long runs of SQLite writer
transactions: live logs show individual card-context writes commonly taking
about 160-260 ms, while the latest measured input-to-settlement path exceeded
240 seconds under accumulated debt.

## Solution

Extend the existing application-level `RecoverySupervisor` with one periodic
historical-recovery lane. The lane delegates one bounded slice to a deep
`HistoricalRecoveryWorkflow`; it does not run during
`repairDeliveryBeforePublisher()` or the eager startup scan. The first
historical slice is therefore eligible only from a later periodic supervisor
tick, after startup and readiness have completed.

One slice first reprojects exact-owner pending Core events and then reserves a
small number of never-attempted missing Turn Card creates. Each Core event is
projected in its own existing SQLite transaction, followed by an event-loop
yield. The slice is bounded by both item counts and elapsed time. Every
downstream Outbox Entry created by this path uses `workClass: "history"`, so the
existing Delivery Ring live/history scheduler continues to prefer live work.

Historical routing is evidence-fenced. An `Exact Recovery Route` contains the
lane/source/session identity plus owner kind, owner ID, owner generation,
Gateway ID, and original root message ID. The persistence adapter selects only
one provable route for an active or orphaned binding whose lifecycle remains
active, or for an existing Conversation Segment with one equivalent durable
owner. It revalidates that route in the same transaction that projects the
event or reserves the missing card. A changed or ambiguous route loses without
mutation.

Recovery always targets the original Gateway and root message. A provider
rejection that proves the target no longer exists is terminal for automatic
recovery; the system never falls back to the configured group root. Archived
or closed owners, operator-skipped work, uncertain external effects, prior
delivery attempts, and events quarantined under the current reducer revision
remain outside automatic recovery.

## User Stories

### SCN-1: Recover an exact orphaned historical lane

Given pending Core events whose session maps to one orphaned binding with an
active lifecycle and unchanged generation, Gateway, and original root message,
a periodic historical slice projects the events in canonical lane order. Any
new outbound intent is durable, idempotent, marked as history work, and targets
that original thread.

### SCN-2: Recover an exact lane through an existing Segment

Given a pending lane whose current runtime session row is absent but whose
existing Conversation Segments identify one durable owner and original route,
the slice may continue that Segment. Ambiguous Segment owners or conflicting
route facts are not eligible.

### SCN-3: Create a never-attempted active Turn Card

Given an active binding page with no delivered message, no pending effect, and
no historical outbound effect for its canonical projection identity, the
workflow reserves one original-thread create as history work. Repeated scans or
restart reuse the same idempotency identity and cannot create a second effect.

### SCN-4: Preserve non-replayable missing cards

Given a page linked to operator-skipped work, an uncertain effect, any started
delivery attempt, or a provider-confirmed defunct target, automatic recovery
does not clear the link, synthesize a replacement, or reroute the content.

### SCN-5: Keep archived and quarantined work isolated

Given an archived or closed owner, or an event quarantined under the current
Core reducer revision, the periodic lane records it as ineligible and leaves
its durable state unchanged. A future reducer fix may reopen older-revision
quarantine through the existing revision gate, but this feature does not bump
the reducer revision.

### SCN-6: Do not block startup readiness

Given a large historical backlog, service startup runs the existing required
delivery repair and eager recovery scan without historical projection work.
Readiness completes independently. Only a subsequent periodic supervisor tick
may start a historical slice.

### SCN-7: Yield between historical writes

Given both historical backlog and new live ingress, at most one synchronous
historical event transaction runs before the workflow yields to the event
loop. Live callbacks can run before the next historical event, and resulting
history delivery remains behind the existing live/history scheduler policy.

### SCN-8: Continue after one stale or poison candidate

Given a route that changes after selection, the transaction reports a stale
candidate and the slice continues. Given a deterministic projection failure,
the existing three-attempt policy eventually quarantines only that event; later
eligible candidates remain discoverable.

### SCN-9: Report bounded recovery evidence

Operators can observe eligible backlog, exclusions, projected events, retries,
new quarantines, card reservations, stale fences, maintenance yields, oldest
age, duration, and the last slice outcome without exposing event payloads,
message text, CardKit JSON, session cursors, or credentials.

## Implementation Decisions

### INV-1: Only pending Core events are automatically reprojected

The historical lane selects `core_event_lane_items.state = 'pending'` only.
Rows quarantined with the current `CORE_EVENT_REDUCER_REVISION` are never reset
or retried by this feature. The existing older-revision compatibility gate
remains the sole automatic quarantine reopening mechanism.

### INV-2: Every historical mutation requires one Exact Recovery Route

The route is immutable crossing data for one candidate: lane ID, source ID,
source epoch, Agent kind, native session ID, owner kind, owner ID, owner
generation, Gateway ID, and original root message ID. Selection rejects zero,
multiple, archived, closed, or conflicting routes. Projection revalidates all
route facts inside its write transaction before invoking the canonical
projector.

### INV-3: Automatic delivery is original-target only

Historical recovery may reserve an effect only for the route's original
Gateway and root message. It cannot create a group-root fallback, a replacement
topic, or another conversation alias. A defunct-target rejection follows the
existing terminal delivery policy.

### INV-4: A missing card must be proven never attempted

A page is eligible only when its message ID is null, its owner and original
route satisfy INV-2, it has no pending reply, and no outbound row exists for
the canonical projection identity. Any linked dismissed/dead-lettered row,
claim/checkpoint/delivery evidence, operator skip, or uncertain effect makes it
ineligible. Page eligibility and the new Outbox reservation commit atomically.

### INV-5: Historical work is bounded and yields to live work

One slice processes at most 32 Core events, reserves at most eight missing
cards, and stops at an approximately five-second monotonic budget. Core events
are projected one at a time, with an event-loop yield after every transaction.
All resulting Outbox Entries use the existing `history` work class; no new
delivery priority or queue is introduced.

### INV-6: Existing identities own idempotency

Core event IDs and lane sequence retain event projection idempotency. Turn Card
create recovery uses the canonical page projection key and create idempotency
key. The unique Outbox identity and transactional page link make repeated
periodic scans and process restarts harmless.

### INV-7: Candidate failure is isolated

A stale owner/route returns a stale outcome without writes. A projection error
uses the existing attempt/fingerprint/reducer-revision transition and affects
only the selected event. A card reservation conflict affects only that page.
The slice reports bounded counts and continues until its item/time budget is
exhausted.

### INV-8: Startup paths cannot consume historical work

`repairDeliveryBeforePublisher()` and the explicit eager `scan()` retain their
current delivery semantics. Historical work is armed only by the periodic
runner interval. No startup stage, readiness predicate, or required recovery
status waits for historical backlog to become empty.

### ARCH-1: RecoverySupervisor remains the single scheduling owner

The existing supervisor owns the timer, single-flight execution, lifecycle,
shutdown, and last-pass diagnostics. It gains an internal historical-pending
flag that is set by the interval path, not by startup repair or eager scan.
The durable Core, Segment, page, Outbox, and delivery state machines remain in
their existing bounded contexts.

### ARCH-2: HistoricalRecoveryWorkflow is a deep application module

The supervisor-facing interface is one operation:
`recoverSlice(): Promise<HistoricalRecoverySliceResult>`. The result contains
only bounded counters, remaining-work state, duration, outcome, and oldest
eligible age. Candidate iteration, time/item budgets, event-loop yields,
projection order, and missing-card ordering remain implementation details.

### ARCH-3: The persistence adapter owns exact selection and atomic fences

The Core Inbox/Conversation Segment SQLite capability exposes narrow candidate
and conditional-mutation operations to the workflow. It does not expose raw
rows to the supervisor. Route translation from SQLite facts to the internal
Exact Recovery Route happens in the adapter. Canonical projectors continue to
own projection semantics; Gateway adapters continue to own provider behavior.

### ARCH-4: Dependency direction remains inward

Domain types describe the route, slice result, and eligibility outcomes without
SQLite or Lark SDK types. The coordinator depends on those internal types and a
store port. SQLite implements the port, and the composition root injects the
workflow into `RecoverySupervisor`. No domain or coordinator module imports the
SQLite implementation or Feishu SDK.

### Behavior and Failure Modes

The periodic runner sets both ordinary delivery scan work and historical work.
The eager startup caller sets ordinary delivery scan work only. In a periodic
pass, ordinary projection/delivery recovery runs first, followed by one
historical slice. A failed ordinary stage does not authorize the historical
stage to weaken its route or replay rules; stage failures are recorded
independently and the periodic runner remains armed.

The workflow selects the oldest eligible lane head using a bounded indexed
query. It conditionally projects one event, yields, and repeats until the count
or time budget is reached. After Core projection, it selects never-attempted
missing pages in stable age/identity order and reserves at most eight. It wakes
outbound delivery only after durable reservations commit.

If projection creates a new Conversation Segment, the supplied Exact Recovery
Route, rather than current runtime lookup, owns its owner/generation/Gateway/root
fields. Existing Segment projection uses the persisted Segment identity and
requires it to agree with the route fence. This is necessary for orphaned
bindings whose live pane route is intentionally unavailable.

### Compatibility and Migration

Add only query indexes needed for bounded global history selection: one
state/age/lane/sequence index for Core lane items and one page/recovery
selection index appropriate to the final query. No recovery queue, durable
cursor, new page lifecycle state, Outbox state, Gateway protocol, or reducer
revision is added. Existing databases migrate additively and may reopen without
rewriting historical event, page, or delivery rows.

Existing active-session reprojection remains unchanged. Existing Delivery Ring
live/history scheduling remains the external-effect priority authority.
Existing operator/manual recovery tools retain their current scope.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, SCN-8, SCN-9, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, ARCH-1, ARCH-2, ARCH-3, ARCH-4

- At the SQLite integration seam, construct active, orphaned, archived,
  ambiguous, Segment-owned, and unmapped lanes. Assert bounded ordering and the
  exact route DTO without exposing payloads.
- Select a candidate, mutate owner generation/session/root on a competing
  handle, and assert the conditional projection loses without Segment, page,
  Outbox, or settlement writes.
- Drive pending event projection through success, duplicate replay, transient
  retry, third-attempt quarantine, and unchanged current-revision quarantine.
- Exercise a first historical Human Message for an orphaned binding and verify
  the new Segment carries the frozen owner/Gateway/root identity and reserves
  history-class delivery to the original thread.
- Cover safe never-attempted active/orphaned page creation and every refusal:
  archived owner, existing projection effect, operator skip, claim/checkpoint,
  uncertain effect, and defunct target.
- Use fake bounded operations to prove each event transaction is separated by
  an event-loop yield, count and monotonic-time budgets stop a slice, one failure
  does not stop siblings, and outbound wake occurs only after durable card
  reservations.
- At the supervisor seam, prove startup repair and eager scan never invoke
  history, periodic interval work does, duplicate interval hints coalesce, and
  shutdown awaits at most the active slice.
- Assert every created reply is `history`, retaining the existing Ring 3:1
  live/history scheduling tests.
- Add migration and `EXPLAIN QUERY PLAN` coverage for both bounded candidate
  queries on a production-shaped backlog.
- Extend health/status/logger privacy tests with bounded counts and canary
  payload, message, cursor, credential, and token values that must remain
  absent.
- Run focused recovery/Core/Conversation Segment/Ring tests, typecheck, build,
  architecture and documentation checks, then the complete Vitest suite.

## Out of Scope

No archived/closed-owner replay, group-root fallback, topic recreation,
operator-skipped replay, uncertain-effect replay, current-revision quarantine
retry, reducer revision bump, prompt resubmission, terminal input, arbitrary
Lark history fetch, production database mutation, queue table, durable recovery
cursor, new timer, delivery-priority redesign, semantic-delivery rollout change,
deployment, restart, push, or pull request is included.

The feature does not promise to recover the 54 currently unmapped production
events or any route whose identity becomes ambiguous. Those rows remain durable
diagnostic evidence for a separate human decision.

## Further Notes

Gate 1 was approved interactively on 2026-10-14 after the user selected the
unified RecoverySupervisor approach and confirmed exact-target recovery plus
pending-only Core handling.

Workspace: `/tmp/herdr-agent-swarm-feishu-recovery-from-stop-active`, reused as
an isolated task worktree because it is clean, contains the repaired baseline,
and leaves the original `stop-active-turn-deploy` staged work untouched.
Branch: `fix/feishu-recovery-from-stop-active`. Starting revision:
`0e9b5bebef70e578d32fc70740c4b72008cbda27`. Initial task-owned changes: none.
Dependencies were confirmed by `npm ls --depth=0` under Node 24.14.1, npm
11.11.0, TypeScript 5.9.3, and Vitest 4.1.11.

Fresh same-request baseline evidence:

- record `d700a2d9823a4c419fe2f3a08b449280`: `npm run typecheck`, exit 0;
- record `3b6f57d6e9714414b9e9f4d57bf4b4d0`: `npm run build`, exit 0, build
  identity `sha256:33d1709e56ff3cdd0b137107d4b8abb4b35683dbbf34c5dd460c7f03b3f020f1`;
- record `7789bbfa15f642a99bb0eeee4fd993a3`: `npm test`, exit 0, 303 files and
  4,840 tests passed in 117.33 seconds.

The conservative capture records were observed in this uninterrupted request.
The specification records their identities and results rather than treating
artifact structural validation as verification evidence. Planning and delivery
still rerun required commands whenever the evidence checker cannot reuse the
full captured record.
