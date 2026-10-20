# Message-Level Fault Isolation and Projection Catch-Up Design

**Status:** Approved

**Date:** 2026-09-30

## Objective

Herdr Agent Swarm must continue processing later Core Agent Events, Prompt FIFO
work, and Feishu CardKit projections when an individual message, projection, or
delivery cannot be rendered or delivered. A local presentation failure must not
become an Agent execution failure, must not cause a possibly executed Prompt to
be replayed, and must not create an unbounded recovery loop.

The design accepts that an intermediate Feishu update can be absent. It repairs
the visible view with a later canonical snapshot and one aggregate warning. It
does not attempt to reproduce every lost transport patch.

## Existing authorities and invariants

- Herdr Core owns canonical Agent event parsing, native session identity,
  transcript/file identity, native turn identity, and recovery checkpoints.
- SQLite owns Prompt and Worker FIFO state, projections, delivery intent,
  recovery evidence, audit records, and the fenced service lease.
- Feishu owns only the visible CardKit objects. A card is never workflow
  authority.
- Swarm does not read TraeX or Pi JSONL. It consumes typed Herdr Core APIs only.
- A Prompt that may have reached the Agent is never automatically replayed.
- `agent_status=blocked` is never automatically skipped.
- Frozen Answer pages are immutable. Later content continues on another page.
- A remote delivery retry may repeat only the delivery effect, never Agent work.

Physical durability failure is outside message-level isolation. If SQLite
cannot commit because storage is full, corrupt, or unavailable, the service
must become not-ready and fail closed; it cannot safely claim that an event was
quarantined or projected.

## Chosen approach

The system uses **independent item settlement plus canonical snapshot catch-up**.

```text
Core source
   -> durable Core event inbox
      -> per-event projection settlement
         -> canonical SQLite projection version
            -> per-card/page delivery lane
               -> Feishu CardKit

bad event ---------> durable projection gap -----------+
bad card update ---> durable delivery gap -------------+-> next snapshot warns
later good event ---> later projection version --------+
```

This approach preserves useful intermediate Agent and Tool activity when it is
available, but does not allow exact reproduction of one failed transport patch
to block later state. Strict per-message retransmission was rejected because a
permanently invalid CardKit update can indefinitely block its lane. A final-only
snapshot model was rejected because it discards useful Tool, Goal, and Task List
history.

## Reliability layers

| Layer | Durable item | Ordering scope | Terminal outcomes |
| --- | --- | --- | --- |
| Core ingestion | Core Agent Event | One Core source | persisted |
| Projection | Projection item | One source and projection owner | projected, ignored, quarantined |
| Agent execution | Prompt or Worker turn | One binding or Worker Session | completed, failed, uncertain |
| Delivery | Outbound intent | One Card or page lane | delivered, dead letter, dismissed, uncertain |
| Catch-up | Projection snapshot | One projection owner | pending, delivered, superseded |

Settlement at one layer does not imply settlement at another. In particular,
an Agent turn can complete while its current Feishu view remains behind.

## Core event ingestion and projection

Core batches are written to the immutable inbox before the read checkpoint is
advanced. An event is then projected independently:

1. Claim one pending event under the current instance lease and its source lane.
2. Validate source, Agent kind, session, turn, and event identity.
3. Reduce the canonical projection.
4. Persist the new projection version and merge or reserve its outbound intent.
5. Mark the event projected in the same SQLite transaction.

Valid events with no visible effect settle as `ignored`.

A data-specific or reducer-specific failure settles only that event as
`quarantined`, records a durable projection gap, and permits the next event to
run. The implementation must not acknowledge an entire decoded observation as
quarantined merely because one constituent event failed. The current grouped
acknowledgement behavior in `HerdrEventCursor` therefore needs to be split into
per-event settlement or an equivalent transactionally isolated projection
frame.

Unknown projection failures use a bounded error fingerprint:

- key: event ID, projection owner, reducer revision, and sanitized error code;
- attempts: at most three for the same fingerprint;
- delay: durable exponential backoff;
- exhaustion: quarantine the event and continue;
- reducer revision change: permits one new attempt because code may now repair
  the old event.

No projection retry calls TraeX or Pi.

## Projection gaps

Swarm adds a durable `projection_gaps` aggregate with these semantics:

```text
id
stage                 core_projection | answer_delivery | main_delivery |
                      worker_delivery | turn_recovery
owner_kind            binding | prompt | answer_page | worker_turn
owner_id
source_item_id
failure_class
failure_code
first_failed_at
last_failed_at
occurrence_count
state                 open | compensated | dismissed
compensated_by_version
compensated_at
```

The record stores bounded identifiers and sanitized error classification only.
It does not store Human Message text, Agent output, Tool arguments, credentials,
or raw provider payloads.

A later projection snapshot includes `openGapCount`, `deliveryGapCount`, and
`gapSince`. A delivery gap becomes `compensated` only after the delivery
checkpoint for the exact snapshot version containing its canonical content is
committed. Creating or enqueueing the snapshot is insufficient evidence that
Feishu caught up. A quarantined projection event remains `open` until that exact
event is successfully reprojected under a later reducer revision; merely
delivering later state must not falsely mark its omitted content as recovered.

Only one aggregate warning is rendered. Its wording follows the evidence:

- when the snapshot contains the canonical content for every delivery gap and
  its successful checkpoint will compensate those gaps:
  `⚠ 有 N 条更新未能实时展示，当前内容已同步到最新状态。`
- while any projection gap remains open:
  `⚠ 有 N 条过程更新未能展示；后续消息仍在同步。`

Historical uncertain Prompt release keeps its separate warning:

> ⚠ 已跳过 N 条无法确认结果的历史请求；后续消息仍在同步。

## Delivery lanes and catch-up

Delivery is serialized only where Feishu ordering requires it:

- Primary Main: `main:<bindingId>`
- Answer page: `answer:<promptId>:<pageIndex>`
- Worker Main: `worker-main:<workerId>:<generation>`
- Worker Task page: `worker-turn:<turnId>:<pageIndex>`
- Operation result: `operation:<operationId>`

Different Answer pages and different Prompts do not share a blocking lane.
One permanently rejected historical page therefore cannot stop a later Prompt,
the Primary Main Card, or a continuation page.

Mutable Main and active Answer projections are snapshot-based. An unclaimed,
unattempted older update can be superseded by the latest snapshot for the same
projection. A claimed, attempted, remotely uncertain, or frozen-page intent is
never overwritten in place.

A confirmed-not-applied mutable update does not remain a permanent lane head.
When a newer projection version exists, the transaction dismisses the older
retry and reserves the latest full snapshot. CardKit sequence numbers may jump
forward when the provider accepts monotonic, non-contiguous versions. If the
provider rejects the sequence gap or the card is no longer mutable, recovery
creates a replacement card from the latest canonical snapshot. A remotely
uncertain effect is never superseded through this rule because doing so could
duplicate an effect that actually succeeded.

Delivery handling is:

| Failure | Failed intent | Same projection | Other lanes |
| --- | --- | --- | --- |
| Confirmed transient failure | retry with backoff | newer mutable snapshot may supersede it | continue |
| Permanent CardKit rejection | dead letter | create latest replacement snapshot | continue |
| Missing or expired mutable card | dead letter | create a new CardKit card | continue |
| Frozen page update rejection | dead letter | continue on a new page | continue |
| Remote effect uncertain | quarantine exact effect key | reconcile delivery only | continue |
| Local checkpoint failed after remote success | quarantine exact effect key | do not resend blindly | continue |

A replacement is rebuilt from canonical SQLite projection state. It never
reconstructs workflow state from the failed Feishu card and never resubmits the
Agent Prompt.

## Core-native turn index coverage and recovery

Historical Herdr-origin Prompts can carry the correct native
`task_started.turn_id` while Core still returns `turn_not_found`. This occurs
when a source is attached near the end of a canonical transcript, or a source
ends after `runtime_identity_changed`: `turn_index` then covers only the live
decoded suffix even though the requested turn remains in the same transcript.
This is an index-coverage failure, not an external-to-native identity alias.

Herdr Core owns repair. For every registered canonical transcript, it maintains
a separate bounded historical-index checkpoint. Live source cursors and event
delivery are never rewound. On an exact native-turn lookup miss, Core advances
historical indexing in bounded batches over the registered file while
revalidating file identity, header/session identity, checkpoint anchors, and
decoder state. Discovered start and terminal checkpoints are persisted in the
existing `turn_index`; the scan emits no duplicate live events.

Recovery identifies a candidate by exact Agent kind, exact session ID, and
exact native turn ID. The caller's `started_at` is an additional fence when it
has full precision. A legacy seconds-only value may differ from the canonical
timestamp only in discarded subsecond precision; it never selects a candidate.
Core first requires the native turn ID to be unique within the fenced session,
then returns the canonical `started_at` and transcript checkpoints. Zero
candidates returns `turn_not_found`; multiple candidates or conflicting
canonical starts returns `turn_identity_ambiguous`.

Swarm consumes only the typed Core result and persists the returned canonical
start through a generation-, pane-, session-, and old-value-fenced store API.
It does not read JSONL, infer UUID time, compare Human text, or search by an
approximate timestamp. A missing, incomplete, or ambiguous index result remains
uncertain and enters durable recovery backoff; it never replays the Prompt.

## Unrecoverable Prompt progression

An unresolved historical Prompt is handled using a fresh Herdr runtime state:

| Runtime state | Result |
| --- | --- |
| working | retain as uncertain and wait with durable backoff |
| blocked | retain; never auto-skip |
| Core temporarily unavailable | retain; retry with durable backoff |
| idle or done, historical indexing complete, native turn absent | terminalize as uncertain with audit and wake FIFO |
| strictly newer native turn observed | adopt the newer turn and terminalize the older detached Prompt as uncertain |

The recovery record stores attempt count, sanitized error fingerprint,
`last_recovery_at`, `next_recovery_at`, and state. Reconciliation skips entries
whose `next_recovery_at` is in the future. This removes the current four-second
`turn_not_found` process loop.

Automatic uncertain terminalization changes only durable workflow and card
state. It sends no terminal input, performs no interrupt, and replays no Prompt.

## Fair scheduling and backpressure

All dispatchers follow owner-keyed fairness:

- one in-flight item per lane;
- bounded concurrency across lanes;
- at most one item from a lane per scheduling round;
- durable `next_attempt_at` for retryable work;
- quarantined work excluded from ordinary scans;
- bounded item and wall-clock budgets per scan;
- new work emits only a wake-up hint and still passes through durable claim.

These constraints prevent one large or failing lane from starving health
requests, shutdown, another binding, or another Answer page.

## Health and observability

An isolated gap degrades status but does not make the whole service unready.

| Condition | Health | Readiness | Status |
| --- | --- | --- | --- |
| Projection gap | ok | ready | degraded |
| One Card dead letter | ok | ready | degraded |
| One uncertain turn | ok | ready | degraded |
| Core temporarily unavailable | ok | degraded or not ready after threshold | recovery backlog |
| Lark globally unavailable | ok | not ready | delivery backlog |
| SQLite write/integrity or lease failure | ok while process responds | not ready | failed or degraded |

`/status` reports aggregate-only diagnostics:

- Core projection pending, retrying, quarantined, oldest-pending, last failure;
- open and compensated gaps plus affected owner counts;
- delivery pending, dead letters, uncertain effects, snapshots behind;
- turn recovery waiting, indexing, uncertain, recovered/not found, hot loops
  prevented.

Repeated identical failures are logged on first occurrence and logarithmic
milestones such as 10 and 100, plus state changes. Full stack traces are not
emitted every scan. Logs contain correlation identities and classifications,
not message bodies or sensitive Tool parameters.

## Migration and rollout

1. Add the Core historical-index checkpoint, bounded backfill path, typed API
   result, capability flag, and focused recovery tests.
2. Let Core rescan canonical transcripts inside the Core boundary to backfill
   exact native turn boundaries. Swarm receives only typed results.
3. Build and install Core through live handoff so existing panes survive.
4. Add Swarm projection-gap, projection-attempt, and turn-recovery migrations plus
   integrity rules.
5. Split grouped Core event acknowledgement into independent settlement units.
6. Add snapshot compensation and per-page delivery lane behavior.
7. Migrate existing `turn_not_found` work through the formal recovery workflow.
8. Rebuild only current projections for eligible historical dead letters.
9. Build an immutable Swarm release and restart only through the supported
   lifecycle surface.

There is no legacy JSONL fallback. If Core lacks historical index recovery, Swarm
keeps the affected Prompt uncertain with backoff and reports degraded status.

## Verification

Automated fault-injection coverage must prove:

1. A failing Human Message projection does not prevent a later Agent Message.
2. A failing Tool Result does not prevent later Goal and Task List updates.
3. Quarantine settles only the failing Core event, not its decoded neighbours.
4. One Answer update returning a permanent error produces a replacement latest
   snapshot without blocking another Prompt.
5. One failed Answer page does not block a continuation page.
6. Core cursors, projection settlements, and delivery checkpoints each recover
   across a crash at every transaction boundary.
7. Historical index recovery accepts only one exact native turn and rejects
   missing, ambiguous, wrong-session, wrong-file, conflicting-start, and
   stale-checkpoint cases.
8. `turn_not_found` does not create a hot command loop.
9. A blocked Agent Prompt is never automatically skipped.
10. A safely releasable idle historical Prompt wakes later FIFO work without
    replaying the earlier Prompt.
11. Remote-success/local-checkpoint-failure executes the Agent once and does not
    blindly repeat the remote effect.
12. Gap warnings remain open until the exact compensating snapshot is delivered.
13. `/health` remains responsive under repeated poison-message injection.
14. SQLite write failure makes readiness fail rather than recording false
    settlement.

The production acceptance test injects one controlled Feishu delivery failure,
then starts a real Herdr-origin turn. Its Human Message, Agent Message, Tool
activity, Goal, and Task List must reach a later Answer Card snapshot. The failed
update remains auditable, the aggregate warning is accurate, later binding FIFO
work proceeds, and the Agent execution count remains one.

## Non-goals

- Exactly reproducing every intermediate Feishu patch.
- Treating Feishu cards as canonical state.
- Automatically approving, denying, interrupting, or replaying Agent work.
- Reading Agent JSONL from Swarm.
- Hiding physical storage or SQLite integrity failures behind message-level
  quarantine.
