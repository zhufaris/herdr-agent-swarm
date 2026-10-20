# Core Event recovery and non-blocking conversation projection

## Status

Approved direction, written specification ready for review. This design replaces
the narrower auto-skip-only proposal. Recovery is the normal path; skipping is
the final, bounded fallback. The design spans Herdr Core and the standalone
Herdr Agent Swarm, which remain separate repositories and releases.

## Problem

The conversation must continue even when a Human Message, Agent Message, Tool
activity, Task List, or Goal update was not reflected in Feishu. A failed or
missing Feishu projection must not stop later Core events from being mapped and
must not leave one uncertain Primary Prompt blocking its FIFO forever.

There are three different failures to handle without conflating them:

1. **Delivery gap**: Swarm committed the projection and outbox intent, but
   Feishu delivery failed or the old target no longer exists.
2. **Projection gap**: Core emitted the event, but Swarm did not durably project
   it because of downtime, cursor expiry, restart, or a poison event.
3. **Ownership gap**: a native Prompt submission may have reached TraeX, but
   Swarm did not persist the exact turn identity needed to observe it.

The existing outbox already addresses most delivery gaps. It does not by itself
recover events that Swarm never durably ingested, and it cannot prove ownership
of an identity-less detached Prompt.

## Evidence from the current implementation

Core's event journal is intentionally bounded. It prunes event bodies by age and
total bytes while preserving only a per-source floor. The currently installed
submission correlation changes also leave a gap:

1. `prepare_submission` records a durable `prepared` row keyed by submission,
   terminal, Agent kind, session, and bounded-text digest.
2. When a matching Human Message is decoded, `EventJournal::commit()` marks the
   row `consumed`, embeds the submission ID in the event body, and executes
   `INSERT OR IGNORE` for `(source, key)` in the same transaction.
3. A later journal prune can remove that event body while leaving the consumed
   row. The consumed row does not retain the event key, exact turn identity, or
   raw transcript boundary.

This is observable in the current runtime for submission
`768524ab-9746-484c-9e21-a1319fb3a309`: the durable submission row is consumed,
its historical source has been pruned to its floor, and no retained event carries
that submission ID. Therefore the current Core Events API cannot safely recover
that specific historical message. A consumed marker proves that matching text
was decoded once; it does not prove which retained turn owns it.

The recovery design can reuse Core's existing safe reader rather than introduce
a second JSONL parser. `SourceReader` already opens only allowlisted regular
files and verifies file identity, session header hash, checkpoint anchor, and
file length. Its checkpoint already carries byte offset plus serialized decoder
state. Exact range recovery must preserve all of those values.

## Goals

- Recover missed bridge-submitted and Herdr-originated turns from Core without
  replaying a Prompt.
- Persist Core events in Swarm before presentation work so later messages can
  continue even if one projection or Feishu delivery fails.
- Keep Prompt execution state independent from Feishu card availability.
- Resolve a stale Primary FIFO blocker only after exact recovery has been
  exhausted and fresh runtime evidence proves that skipping is safe.
- Make any recovered, partially recovered, or skipped history visible and
  auditable without exposing Prompt bodies or secrets.
- Preserve CardKit page immutability: update only the active Answer page or
  create a continuation card; never patch a frozen page.

## Non-goals

- Automatically replaying any Prompt that might have reached TraeX.
- Automatically skipping `agent_status = blocked`; it represents a live
  approval or question.
- Treating Worker `dispatch-uncertain` as a Primary Prompt recovery state.
- Restoring `rich_text`, `rich_post`, or any legacy non-CardKit path.
- Making Feishu a workflow authority or reconstructing SQLite from card text.
- Guaranteeing recovery after the authoritative native transcript itself has
  been deleted or replaced without matching file identity.

## Considered approaches

### 1. Increase Core event retention

This reduces the frequency of gaps but does not remove them. A sufficiently long
outage or high-volume session still expires the required event, and source
replacement can still make source-scoped cursors unusable.

### 2. Retain every decoded Core event indefinitely

This makes replay simple but duplicates large Tool results and reasoning output,
has no bounded storage policy, and turns the transport journal into a permanent
conversation database.

### 3. Durable turn index plus on-demand transcript recovery

Core keeps a compact, durable index for exact turn boundaries and submission
correlation. Normal event bodies remain bounded. When a cursor or event has
expired, Core re-decodes the exact indexed byte range from the authoritative
native transcript. Swarm persists the recovered typed events before projecting
them. This is the selected approach because it preserves bounded event storage,
supports source replacement, and fails closed when the raw source identity no
longer matches.

## Architecture

The recovery path has four independent stages:

```text
native transcript
  -> Core durable submission/turn index
  -> Core live events or exact-turn recovery API
  -> Swarm durable Core-event inbox and canonical projections
  -> CardKit outbox and Feishu

unrecoverable detached Primary head
  -> strict runtime/fence checks
  -> audited skip fallback
  -> next FIFO Prompt
```

Failure in a later stage never rolls back an earlier authoritative stage.
Feishu delivery never gates Prompt execution, Core-event ingestion, or the next
FIFO claim.

## Herdr Core: durable correlation and exact-turn recovery

### Compact turn index

Core adds a journal table for compact turn boundaries. One row identifies:

- Agent kind and native session ID;
- transcript path identity and file identity;
- stable turn ID and normalized start time;
- the full decoder checkpoint and anchor at turn start;
- terminal byte offset and anchor covering the turn in the append-only
  transcript;
- Human Message event key/message ID and its bounded-text digest when present;
- terminal state when known;
- created and updated timestamps.

The index contains no full message, Tool result, or secret-bearing event body.
Ordinary event pruning does not delete it. Index cleanup is allowed only when
the corresponding transcript no longer exists or its file identity no longer
matches, and cleanup records aggregate diagnostics.

### Submission receipt

The existing submission ledger becomes a state machine:

- `prepared`: Core durably recorded intent before terminal input;
- `observed`: an exact Human Message and turn boundary were atomically linked;
- `terminal`: the linked turn reached completed or aborted;
- `cancelled`: terminal input was rejected before it could take effect.

An observed receipt stores the stable turn identity and transcript boundary
reference. Core must not change `prepared` to `observed` unless the turn-index
association is committed in the same transaction. If the event `(source, key)`
already exists, Core loads that exact event and attaches the association instead
of silently consuming the receipt through `INSERT OR IGNORE`.

Repeated preparation, decoding, attachment, source replacement, and recovery
are idempotent. Matching by text digest is used only while binding a prepared
submission in FIFO order; recovery never guesses from digest alone.

### Recovery API

Core exposes two typed, read-only operations:

- locate a submission and return `prepared`, `observed`, `terminal`,
  `cancelled`, or `unavailable`, including exact turn identity only when proven;
- read an exact indexed turn as the same normalized, redacted, bounded events
  used by the live API.

The read operation validates session, transcript file identity, turn ID, start
time, starting decoder checkpoint, both anchors, and byte range before decoding.
It invokes the same `SourceReader`/codec with a bounded end offset; it never
scans arbitrary terminal output, accepts text as ownership evidence, or writes
to the terminal.
Recovered events retain stable logical event IDs derived from transcript
identity and event key so Swarm deduplicates live and recovered copies.

For Herdr-originated turns without a submission ID, Swarm can enumerate exact
turns after its last durable session boundary and recover each indexed turn.

## Swarm: durable ingestion before projection

### Core-event inbox

Swarm adds a bounded durable inbox keyed by stable Core event ID. In one SQLite
transaction it records a normalized event, its binding/session/turn fences, and
the source checkpoint needed for reconciliation. Only after that commit may the
reader advance its durable ingestion checkpoint.

The inbox is not a second transcript authority. It is a delivery buffer between
Core and Swarm projections. Payloads remain bounded and redacted under the
existing Core schema.

### Projection lanes

The projector drains inbox events in source and turn order. A projection update,
its Run/Main Card view changes, and its CardKit outbox intent remain one SQLite
transaction. Duplicate events are no-ops.

Projection retry state belongs to the event/turn lane, not the Primary execution
FIFO. If one event repeatedly fails deterministic validation:

1. retain it in the inbox with a bounded failure summary;
2. attempt exact-turn recovery from Core once to replace a truncated or corrupt
   batch with authoritative normalized events;
3. if the same event still cannot project, classify the failure before advancing:
   a leaf event (Agent Message, Tool activity, Goal, or Task List) is quarantined
   individually and later events continue; a structural event (Human Message,
   turn start, completion, or abort) quarantines the rest of that turn and moves
   only to the next exact indexed turn boundary;
4. persist one visible projection-gap marker for the affected turn and keep
   draining unrelated or later turn lanes.

A missing Tool result may leave that Tool failed/unknown, but it does not block a
later Agent Message. A missing turn boundary is never inferred: the projector
first uses Core's exact turn recovery bundle, and if that still fails it marks
the affected projection incomplete from Core's terminal receipt before
advancing to the next proven turn boundary.

### Delivery isolation

Feishu delivery consumes only durable outbox intent. Transient failures retry;
known-defunct targets are dismissed or rebuilt according to the existing lane
policy; uncertain effects remain quarantined for operator-safe recovery. None of
these states changes Prompt execution or the Core-event inbox checkpoint.

If an Answer target cannot be reused, recovery creates a new CardKit continuation
from the canonical SQLite projection. Frozen pages remain immutable. Main Card
convergence uses the latest projection and never truncates or rewrites the
conversation source state.

## Recovery-first Primary FIFO policy

For a `running/detached` Primary Prompt, reconciliation follows this order:

1. If exact turn identity exists, observe or recover that exact turn.
2. If `native_submission_id` exists, locate its Core submission receipt.
3. If the receipt is observed or terminal, atomically claim the proven turn in
   Swarm and recover it through the exact-turn API.
4. If the receipt is still prepared and the Pane is working or blocked, leave
   the Prompt unchanged and continue observing.
5. If Core proves cancellation before terminal input, safely return the Prompt
   to queued because no external effect occurred.
6. If Core cannot recover the association, apply the bounded skip fallback only
   when all eligibility checks below pass.

Projection and Feishu failures do not participate in these execution decisions.
A terminal receipt can close the Prompt and wake the next FIFO item even while
its CardKit projection remains pending or quarantined.

## Bounded auto-skip fallback

Add `DETACHED_PROMPT_AUTO_SKIP_MS` to validated configuration:

- default `1800000` (30 minutes);
- minimum non-zero value `60000` (1 minute);
- `0` disables automatic skipping.

A Prompt is eligible only when all facts are rechecked at one fenced decision
point:

1. it is a Primary Prompt at the FIFO head with `state = running` and
   `observation_state = detached`;
2. both exact turn fields are null;
3. Core submission lookup and exact-turn recovery returned no proven owner, not
   a transient API failure;
4. age from `dispatched_at` (or legacy `created_at`) exceeds the configured
   timeout;
5. at least one later ordinary Prompt is queued for the same binding;
6. binding generation, Pane, and native session fences still match;
7. a fresh Herdr observation reports the exact Pane/session as `idle` or `done`;
8. no detached observer owns the Prompt.

The policy never selects an exact-turn Prompt, a working/blocked/unknown Pane, a
Prompt with no successor, a stale/orphaned binding, or any Worker turn.

The store transition is atomic: mark the Prompt `failed/completed`, update its
canonical projections, reserve CardKit outbox intent, and append one
`swarm.auto_skip` audit row. It never submits text to TraeX. The scheduler wakes
the next FIFO Prompt after commit regardless of Feishu delivery state.

## User-visible recovery warning

Skipped or projection-gapped history is summarized without interrupting normal
message mapping. The mutable Main Card and active Answer page may show one
compact warning such as:

> ⚠ 已跳过 2 条无法确认结果的历史请求；后续消息仍在同步。

The count is derived from durable audit/projection state, never card text. Each
affected Prompt's Answer projection retains its own terminal explanation. The
warning is a presentation element, not a timeline message, queue item, or
delivery gate. New Agent Messages, Tool activity, Task List, and Goal updates
continue below/after it normally. A successful later recovery can replace a gap
warning with `✅ 已恢复 N 条历史更新`; frozen pages receive this only through a
new continuation card.

## Worker uncertain turns

Worker `dispatch-uncertain` remains a separate protocol. It may use the same
Core exact-turn index when an exact Worker submission receipt exists, but it
does not call the Primary skip transition. Repeated unchanged supervision emits
one state transition plus coalesced counters, rather than appending duplicate
`turn.dispatch-uncertain` events on every scan.

## Observability

Expose aggregate, non-sensitive counters and last transition times for:

- Core receipts prepared, observed, terminal, cancelled, and unavailable;
- exact turns recovered from transcript after event retention;
- inbox events persisted, projected, deduplicated, retried, and quarantined;
- Feishu projections pending, delivered, rebuilt, and dead-lettered;
- detached Prompts recovered, still waiting, and auto-skipped;
- warning counts currently visible per binding;
- coalesced Worker uncertain observations.

Logs include IDs and fences but never Prompt bodies, transcript payloads, Tool
arguments, or secrets.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Live Core cursor expired | Use exact turn/submission recovery; do not jump to latest silently. |
| Core source replaced for the same session | Resolve through transcript identity and compact turn index, not old source ID. |
| Transcript identity changed or source deleted | Return `unavailable`; never guess or replay. |
| Swarm projection transaction fails | Keep inbox event pending and continue unrelated lanes. |
| One event is permanently unprojectable | Quarantine it, render one gap warning, continue safe later events. |
| Feishu create/update fails | Retry/rebuild through outbox; never block Prompt FIFO or Core ingestion. |
| Prompt receipt proves terminal turn | Close/recover the Prompt and wake FIFO even if Feishu is unavailable. |
| No ownership evidence after timeout | Apply strict audited skip only if a queued successor is blocked and Pane is idle/done. |
| Pane is blocked, working, unknown, or unavailable | Do not auto-skip. |

## Compatibility and rollout

Core adds a typed `agent events capabilities` response containing a versioned
`exact_turn_recovery_v1` capability. Swarm probes this contract directly rather
than scraping help text and uses recovery only when the capability is present.
Against an older Core, Swarm keeps the existing fail-closed/manual-skip
behavior; it does not infer ownership from text or enable unsafe replay.

Rollout order is Core first, then Swarm. Existing consumed receipts without a
durable turn association are legacy-unavailable and are handled by the strict
fallback; migration must not fabricate their turn IDs from digest matches.

## Testing

Core tests must prove:

- prepared submission, Human Message, exact turn index, and observed receipt are
  committed atomically;
- duplicate `(source, key)` decoding still produces one exact receipt instead of
  a consumed orphan;
- ordinary event pruning does not remove the compact turn/submission index;
- exact-turn recovery re-decodes the bounded transcript range after event prune;
- range recovery begins from the saved decoder checkpoint and rejects changed
  start/end anchors;
- source/terminal replacement for the same transcript session remains
  recoverable;
- file identity mismatch, ambiguous digest, missing transcript, and malformed
  boundaries fail closed;
- recovered events have stable IDs and the same redaction/bounds as live events.

Swarm tests must prove:

- an event is durable in the inbox before its ingestion checkpoint advances;
- restart between ingestion, projection, outbox reservation, and delivery
  converges without loss or duplicate cards;
- missed bridge and Herdr-originated Human Messages recover with their Agent,
  Tool, Goal, and Task List events in order;
- cursor expiry invokes exact recovery rather than opening at latest;
- one poison projection event produces one warning and does not block later safe
  messages or the Prompt FIFO;
- Feishu create/update dead letters do not stop Core ingestion or later Prompt
  execution;
- exact receipt recovery wins over auto-skip;
- stale detached skip meets every fence, never replays, wakes the successor, and
  atomically writes projection, outbox, and audit state;
- blocked/working/unknown Pane, exact-turn Prompt, no successor, transient Core
  failure, stale generation, observer ownership, and Worker uncertain turns are
  never auto-skipped;
- repeated scans and repeated Core batches are idempotent;
- the emoji warning count is correct and does not become a Human Message or
  timeline item;
- unchanged Worker uncertain supervision is coalesced.

Before deployment, run focused Core journal/API tests, focused Swarm recovery,
projection, outbox, and card tests, both type/build gates, and both full suites.

## Acceptance criteria

The feature is complete only when an integration test demonstrates this entire
sequence:

1. a native Prompt is accepted and correlated;
2. Swarm misses some live Core events and the original Core event bodies expire;
3. Core recovers the exact turn from its durable index and native transcript;
4. Swarm durably ingests and projects the missing Human, Agent, Tool, Task List,
   and Goal data without replaying the Prompt;
5. Feishu delivery is failed and later restored while a subsequent Prompt still
   runs through FIFO;
6. the rebuilt/new CardKit Answer converges from SQLite canonical state;
7. a separately constructed unrecoverable stale Prompt is audited and skipped,
   the warning count is shown, and the next Prompt proceeds;
8. no rich-text delivery, direct SQLite repair, prompt replay, or unsafe Worker
   resolution occurs.
