# Unified Agent Input and Explicit Command Routing

## Problem Statement

The current Primary input path maintains a second execution model beside Herdr
Core. A Feishu message becomes a Prompt Input, may wait in a two-second Native
Input Batch, becomes a Prompt Job, claims a per-Binding Ordinary Execution
Slot, and is dispatched only after local queue, runtime-state, and detached-turn
gates permit it. Recovery then tries to reconnect that local execution identity
to Core events and visible cards.

That model has two observable failures.

First, an earlier Prompt whose observer becomes detached blocks later ordinary
input even though detachment proves only that Swarm lost observation. It does
not prove that Herdr cannot accept another input. Flow control and observation
reliability have therefore been conflated.

Second, exact-turn recovery can ignore Core's ordered event batch and rebuild a
Turn by querying inbox rows with `ORDER BY occurred_at, event_id`. Events that
share a timestamp are then ordered by a hash-derived identifier. A read-only
reproduction against the affected Turn found eight inversions, including a
human message placed after a following tool call. Prompt creation time, Feishu
time, SQLite row order, hashes, and local sequence values cannot reconstruct
the JSONL conversation order.

The production incident that motivated this change is already terminal in
Core:

- submission `f98e75a4-c9be-4e65-837a-c9b6a4c70bc5`;
- session `01a1019d-e7b6-7141-9f75-bdba80bcbd8e`;
- Turn `01a10222-a095-7953-a82d-d74624d63023`;
- canonical start `2026-10-03T14:19:46.214Z`;
- Core receipt state `terminal`, terminal state `completed`;
- `agent events recover-turn` outcome `recovered`, `complete=true`, with 61
  events ordered from `turn_started`, through `human_message`, to
  `turn_completed`.

The card remains stale because Swarm has not consumed that complete ordered
result through its normal projection path. Replaying the prompt is neither
needed nor safe.

The intended result is one Agent-input model. Feishu-originated text and text
entered directly through Herdr use the same Herdr/Core submission and event
chain. Swarm retains only the responsibilities it actually owns: ingress
authorization, route selection, source-message idempotency, durable effect
evidence, explicit Swarm controls, Core-event projection, and Gateway delivery.

## Solution

Replace the Swarm-managed Prompt Input, Native Input Batch, Prompt FIFO, and
Ordinary Execution Slot path with a deep Agent Input module. Every eligible
human message is frozen once, durably recorded once, and offered directly to
Herdr with a caller-owned submission identity. Herdr Core owns acceptance,
terminal serialization, native session and Turn identity, and the durable
receipt. Core JSONL owns the final order of human, assistant, tool, goal, and
terminal events.

Swarm must not claim that ingress order is conversation order. It submits each
eligible input independently. The position at which Core records a
`human_message` is the position of that input in the conversation. An older
message that was never submitted is not backdated ahead of later JSONL events
when it is eventually submitted. An observer becoming detached or a submission
remaining uncertain does not block later Agent Input.

Live projection and exact recovery have deliberately different commit
semantics. A live source batch is incrementally reduced in its returned JSONL
order and advances only its opaque live cursor. Exact recovery pages are staged
without formal Turn/CardKit effects until Core returns `complete=true`. That
completed result is an authoritative Turn snapshot: Swarm reduces it from an
empty Turn state in the returned JSONL order, then atomically replaces the
materialized Turn projection and records repair delivery intent.

Core currently generates the same stable event IDs for live and exact-recovery
forms. Before snapshot replacement, every event already projected live for the
Turn must be present with matching identity/content in the completed snapshot.
If the live projection contains an extra or conflicting event, recovery opens
an `ambiguous` gap and does not merge, sort, or partially replace anything.
Thus a live projection `A,C` followed by a completed snapshot `A,B,C` converges
to `A,B,C`, never `A,C,B`.

Explicit Swarm and Worker controls remain outside Agent Input. `/swarm ...`,
authorized CardKit actions, and documented Worker-management commands continue
through their existing policy, confirmation, and Command Intent boundaries.
All other text in an Agent-bound thread, including unknown slash text such as
`/model` or `/compact`, is submitted verbatim to the Agent. Natural-language
control interpretation does not intercept ordinary text in an already bound
Agent thread.

The final state contains no compatibility fallback to the old Prompt executor.
A staged migration may run both paths for disjoint legacy and new records, but
new input switches only when the required Core capability is advertised. After
legacy convergence, the Prompt Input, Native Input Batch, ordinary Prompt FIFO,
detached blocker, queue-position projection, and sessionless observed-executor
fallback are removed.

## User Stories

### SCN-1: Submit ordinary Feishu input

As a participant in an Agent-bound Feishu thread, when I send ordinary text,
the bridge authorizes and deduplicates the source message, records one
Submission Intent, and submits the unchanged body to the bound Herdr Agent. A
Core `human_message` establishes the input's actual session, Turn, and
conversation position. Assistant and tool output then appears through the same
Answer projection used for Herdr-originated work.

### SCN-2: Submit while the Agent is working or blocked

When an Agent is already working or blocked, Swarm does not use that local
state as a pre-submission gate. It calls the Core submission contract. Core may
accept, serialize, or definitely reject the input according to its runtime
contract. A definite rejection is visible and creates no Turn. Swarm does not
create a competing semantic queue.

### SCN-3: Preserve Core order under concurrent ingress

When two Feishu callbacks are processed concurrently, each source message is
deduplicated and submitted independently. Swarm does not derive a conversation
order from callback arrival, message timestamps, database rows, or local
sequence values. The order of their Core `human_message` events is final and is
preserved exactly in the projection.

### SCN-4: Recover around the external-effect boundary

If the bridge stops while a Submission Intent is still `recorded`, no external
effect has started and submission may begin later. If it stops after the intent
enters `attempting`, the bridge first queries Core by submission ID. A
`prepared`, `observed`, or `terminal` receipt is adopted without resubmission.
A `cancelled` receipt is a definite non-delivery and is reported as rejected.
No automatic retry after cancellation is part of this change; a new human
message creates a new source identity. A missing receipt remains uncertain and
is never replayed automatically.

### SCN-5: Continue after detached or uncertain work

If observation of input A detaches or its receipt remains uncertain, input B is
still eligible for immediate Core submission. Recovery of A proceeds
independently. If Core JSONL later contains A before B, after B, or not at all,
Swarm projects exactly that evidence and does not repair it using local age.

### SCN-6: Adopt direct Herdr input

When a person submits text directly in Herdr, Core emits an unmatched
`human_message`. Swarm creates or updates a Herdr-origin Turn projection and
feeds all later events through the same reducer and outbox used for a correlated
Feishu submission. No synthetic Feishu Prompt Job is required.

### SCN-7: Route Agent-native and Swarm commands explicitly

In a Primary Agent thread, `/swarm status` remains an explicit Swarm Control,
while `/model`, `/compact`, and any other non-reserved slash text are Agent
Input and are submitted verbatim. In a documented Worker Session thread,
reserved Worker-management grammar remains control; other text follows the
Worker Agent Input route. An ordinary bot mention in an already bound thread is
Agent Input, not a natural-language Swarm mutation.

### SCN-8: Project live events without invented order

When a live Core source returns an ordered batch, the inbox persists its opaque
continuation evidence and the projector applies the array in the returned
order. Duplicate delivery of the same event IDs is idempotent. Presentation
revision numbers and CardKit stream sequence numbers may order transport work,
but they do not define Agent conversation order.

### SCN-9: Recover one exact Turn

When a projected Turn has a proven gap, recovery requests one exact Core Turn
using agent kind, session ID, Turn ID, and canonical start. Recovery pages are
staged in their returned order but do not change formal Turn views, freeze
Answer pages, or enqueue CardKit work. Only a `complete=true` result becomes an
authoritative Turn snapshot. Swarm reduces that complete snapshot from empty
state and atomically replaces the Turn projection when existing live events
are a matching subset. `indexing` and incomplete reads remain pending;
`not_found`, Core `ambiguous`, or a live/snapshot conflict open an explicit
projection gap. None of those outcomes causes prompt replay or guessed merging.

### SCN-10: Recover the affected terminal Turn

For the incident submission and Turn listed in the Problem Statement, Swarm
queries the terminal Core receipt, obtains the complete 61-event exact recovery
snapshot, rebuilds the Turn from empty state in those 61 events' JSONL order,
atomically replaces its projection, and converges Answer/Main Card delivery by
advancing the materialized view revision, reserving the existing idempotent
late-recovery continuation card, and reserving the replaceable Main Card update.
It never invokes `agent prompt` for that submission, patches a frozen Answer
page, or rewrites Core execution truth.

### SCN-11: Bootstrap the first native session

When an exact Pane and terminal host a supported Agent but no native session
exists yet, the new versioned Core submission capability accepts a
caller-provided submission ID under the exact terminal and Agent-kind fence.
The first resulting human message binds the pending submission to the newly
created native session and Turn. Swarm does not fall back to the observed
`runPrompt` executor.

### SCN-12: Migrate legacy input without replay

Legacy source messages proven never to have crossed the Core effect boundary
become independent Submission Intents. A former batch is decomposed into its
durable source members; its old member ordinal is not conversation order.
Legacy submitted, running, recovering, uncertain, or detached work is never
submitted again. It converges only from Core receipt and exact-turn evidence.

## Implementation Decisions

### Domain Model

#### Affected bounded contexts

| Context | Model and authority after the change | Exclusions |
| --- | --- | --- |
| Ingress and Routing | Owns Gateway authorization, configured-chat scope, input limits, explicit command classification, route resolution, and source-message deduplication | Does not order Agent conversation events or inspect Agent runtime state to admit ordinary input |
| Agent Input | Owns immutable Submission Intent, external-effect certainty, Core receipt adoption, and correlation metadata | Does not own a Prompt FIFO, active-turn slot, Turn lifecycle, or Answer order |
| Herdr/Core Runtime | Owns terminal serialization, submission idempotency, native session and Turn identity, durable receipts, JSONL order, live reads, and exact-turn recovery | Does not own Feishu authorization, cards, or Gateway delivery |
| Conversation Projection | Owns idempotent reduction of one Core-ordered batch into Turn/Answer/Main views | Does not submit input, infer missing order, or mutate Core state |
| Swarm Control | Owns explicit `/swarm`, CardKit, and Worker-control policies, permissions, confirmations, Command Intents, and exact control effects | Does not reinterpret unreserved Agent text |
| Delivery | Owns immutable delivery intent, Gateway-scoped lane ordering, retries, quarantine, and dead letters | Card state is never execution or recovery authority |

#### Canonical language

**Agent Input** is immutable human text offered to one exact Herdr Agent route.
It includes ordinary prose and Agent-native slash text. It does not include an
explicit Swarm or Worker control.

**Submission Intent** is the durable Agent Input aggregate root. Its business
identity is the caller-owned submission ID; its source identity is the unique
pair of ingress source and source-message key. It freezes the body, actor audit
data, owner route, Binding/Instance generation, Pane, terminal, optional native
session fence, and Core effect evidence. Reconstitution restores persisted
state without initiating submission or producing projection effects.

The proposed Submission Intent states are `recorded`, `attempting`,
`prepared`, `observed`, `terminal`, `cancelled`, and `uncertain`:

- `recorded` proves the external call has not started;
- `attempting` is durably written immediately before the external call and is
  not replayable after an unclassified interruption;
- `prepared`, `observed`, and `terminal` translate the corresponding durable
  Core receipt states;
- `cancelled` records either a Core-cancelled receipt or a structured definite
  pre-effect rejection, together with its reason;
- `uncertain` means Core evidence is absent or cannot be trusted and forbids
  automatic replay.

`prepared` is already beyond the safe replay boundary even if no Turn exists
yet. `observed` supplies native session and Turn correlation. `terminal`
supplies the terminal outcome. `cancelled` proves a definite non-delivery
outcome before terminal input. No state asserts conversation position; only the
Core event stream does.

**Live Core Event Batch** is an ordered incremental value returned by one Core
live read. Its cursor is opaque. Equality and duplication are determined by
stable event identity, not position inferred outside the batch.

**Authoritative Turn Snapshot** is the complete ordered event sequence returned
by exact recovery for one fenced session, Turn, and canonical start after Core
asserts `complete=true`. Incomplete recovery pages are only snapshot staging;
they are not projection facts. Snapshot equality/conflict checks use stable
event identity and content, while sequence is exactly the returned JSONL order.

**Turn Projection** is an authorized read model of Core events. It is not an
aggregate that can repair Agent execution. Run/Answer/Main Card records may
retain existing public identities during migration, but their lifecycle is
derived from Core facts rather than a local Prompt executor.

#### Invariants and enforcing owners

- **INV-1 — Source idempotency:** one ingress source and source-message key owns
  at most one Submission Intent. The Agent Input store enforces this unique
  constraint atomically with admission.
- **INV-2 — Frozen effect identity:** one Submission Intent keeps one immutable
  body, target fence, and Core submission ID. The aggregate/store rejects
  conflicting duplicate input.
- **INV-3 — No replay after possible effect:** after `attempting`, Swarm does
  not call the prompt operation again unless Core has supplied a future
  explicitly approved definitely-not-started retry contract. This
  specification chooses rejection for `cancelled`; it does not introduce such
  a retry contract.
- **INV-4 — Detached is not a lock:** detached observation and uncertain receipt
  state never prevent admission or submission of another Agent Input. The
  Agent Input workflow has no predecessor-state eligibility predicate.
- **INV-5 — Core owns conversation order:** only the order in a returned Core
  live event batch or completed Authoritative Turn Snapshot can order human,
  assistant, tool, goal, and terminal facts. The projector applies that order
  without a local sort.
- **INV-6 — Completed snapshot replacement, never cross-batch merge:** live
  batches may advance one materialized Turn incrementally. Exact recovery has no
  formal projection effect before `complete=true`; afterward it rebuilds from
  empty state and atomically replaces the Turn projection. Existing live events
  must be a matching subset of the snapshot. Timestamps, hashes, source IDs,
  local ordinals, database insertion order, and append-after-dedup cannot merge
  live and recovery reads into a new order.
- **INV-7 — Cards are projections:** Gateway messages, CardKit revisions, and
  delivery outcomes never mutate Submission Intent or Core Turn truth.
- **INV-8 — Explicit control grammar:** only documented Swarm/Worker grammar or
  authenticated CardKit actions enter Swarm Control. All other eligible text in
  a bound Agent route is Agent Input.
- **INV-9 — Exact recovery is non-executing:** receipt lookup, Turn enumeration,
  live reads, and exact recovery never call Agent submission or terminal-input
  operations.
- **INV-10 — Legacy uncertainty is preserved:** migration cannot convert an
  old submitted/running/recovering/uncertain/detached row into new input work.

### Architecture

#### Agent Input module

Ingress depends on one consumer-owned application interface equivalent to:

```ts
interface AgentInputWorkflow {
  submit(input: AgentInputRequest): Promise<AgentInputResult>;
}
```

The crossing request contains normalized source identity, actor/audit context,
immutable text, owner identity and generation, Pane and terminal fences, and an
optional known native session. The result distinguishes duplicate, recorded,
prepared/observed/terminal adoption, definite rejection, and uncertainty. It
does not expose queue position, a local execution phase, or a guessed Turn.

The module hides source deduplication, transactional state transitions, Core
submission, receipt queries, restart recovery, and post-receipt wake-ups. The
external seam earns its depth because Primary input, Worker input, and initial
provisioning input all use the same contract without learning those mechanics.

An internally owned Herdr/Core port supplies the minimum runtime operations:

- submit one immutable Agent Input under a caller submission ID and exact
  terminal/session fence;
- query one durable submission receipt;
- read one live ordered event batch after an opaque cursor;
- recover one exact ordered Turn batch;
- enumerate session Turns only when reconciliation needs discovery.

Adapters translate CLI/API payloads and structured error codes into internal
results. Domain and application modules do not import Herdr response schemas or
execute commands directly.

#### Core submission capability

Installed Herdr 0.9.3 already supplies durable pending submissions, duplicate
protection, receipt lookup, human-message correlation, stable event IDs, exact
Turn recovery, historical indexing, and session Turn enumeration. Existing
receipt-bearing `agent prompt` requires both a submission ID and an existing
expected session ID.

The first-session case therefore requires a new advertised, versioned Core
capability rather than silently changing the meaning of an existing stable
endpoint. Its logical request contains:

- Pane target;
- expected terminal ID;
- expected Agent kind;
- optional expected native session ID;
- caller submission ID;
- immutable text.

With an existing session, Core preserves the exact session precondition. With
no session, Core accepts only while the same terminal still hosts the expected
Agent kind and still has no native session, persists a pending submission under
that terminal fence, then binds the first matching human message to the new
session. Duplicate identity never causes another terminal write. A changed
terminal, changed Agent kind, or unexpected existing session is a definite
pre-effect rejection.

Swarm feature-detects this capability. During staged migration, old records may
continue through legacy convergence, but new-path readiness is false when the
configured Agent requires the capability and it is absent. There is no
sessionless observed-executor fallback in the final composition.

#### Ordered event projection and authoritative replacement

Socket notifications and periodic reconciliation are wake-up hints to the same
Core readers. Live reads are authorized incremental evidence. Exact recovery is
an authorized authoritative replacement only after the fenced Turn is complete.

The live projector validates batch identity and owner routing, reduces events
in array order, performs stable-ID idempotency checks, and commits view changes,
live cursor settlement, projection-gap bookkeeping, and outbox intent in the
existing SQLite transaction boundary.

The exact-recovery path uses a deeper replacement interface whose caller only
supplies fenced recovery pages. Its implementation:

1. durably stages pages and their opaque continuation without Run/Answer/Main
   view or outbox effects;
2. waits for Core `complete=true` and validates session, Turn, canonical start,
   stable event identity, and page continuity;
3. compares already projected live events with the completed snapshot and
   requires them to be a matching subset;
4. reduces the completed snapshot from an empty Turn state in returned order;
5. in one SQLite transaction, replaces the Turn-owned execution/read-model
   projection, settles the recovery checkpoint/gap, advances the applicable
   Run/Topic view revisions, and reserves an idempotent history continuation
   plus replaceable Main Card delivery intent;
6. on extra/conflicting live evidence or malformed snapshot identity, leaves
   the current projection untouched and records an `ambiguous` gap.

No global query reconstructs order, and no recovery page is appended to a live
view. `occurred_at` remains audit metadata. A presentation list may retain
materialized positions and CardKit may retain transport sequence numbers, but
neither can override Core JSONL order or be fed back into execution truth.
Known-prefix-gap active Turns do not freeze new Answer pages; formal repair waits
for terminal exact recovery. Already frozen Answer pages and their immutable
delivery coverage remain history and are not rewritten. The existing
late-recovery continuation mechanism creates a new history Answer card keyed by
the fenced Turn/snapshot revision, while the Main Card follows its normal
replaceable view-version lane.

#### Command routing

The Ingress and Routing decision order becomes:

1. enforce configured chat, actor, size, and thread scope;
2. handle documented Worker Session controls in their specific thread scope;
3. parse explicit `/swarm ...` grammar;
4. handle authenticated CardKit actions through Swarm Control;
5. if an Agent route is bound, send every remaining text to Agent Input;
6. only in an unbound/root provisioning scope may existing Orchestrator and
   natural-language control interpretation run.

The existing `unsupported-slash-command` rejection is removed. Command Intent
continues to own Swarm mutations and queries. `/swarm awake` becomes Core
projection catch-up plus card redelivery and does not wake a Prompt dispatcher.
`/swarm skip` remains legacy-only until all old detached blockers are resolved,
then is removed. `/swarm resume` loses any Prompt-FIFO meaning. `/swarm status`
reports Submission Intent receipt states, Core projection lag/gaps, and outbox
state instead of an ordinary Prompt queue.

#### Dependency direction and composition

```text
Feishu / Gateway adapter
        |
        v
Ingress application workflow -----> Swarm Control application workflows
        |
        v
Agent Input application module ----> internally owned Core + store interfaces
        |                                      ^
        v                                      |
domain state and invariants          Herdr/SQLite adapters

Core ordered readers -> Conversation projector -> Delivery intent -> Gateway adapter
```

The composition root assembles concrete adapters and capability detection. It
does not classify effect certainty, gate later input on earlier input, sort
events, or mutate projection state directly.

### Behavior and Failure Modes

Admission and creation of a Submission Intent are one SQLite transaction. The
source-message unique constraint provides duplicate convergence. `recorded ->
attempting` is a compare-and-swap transition committed before invoking Core.
Core results and receipt queries transition only the same immutable submission
identity. A stale generation or target fence before `attempting` rejects the
operation without an external call.

Once `attempting` is durable, these outcomes apply:

| Evidence | Local outcome | Later input | Replay |
| --- | --- | --- | --- |
| Core prepared receipt | `prepared` | allowed | forbidden |
| Core observed receipt | `observed` with session/Turn | allowed | forbidden |
| Core terminal receipt | `terminal` with outcome | allowed | forbidden |
| Core cancelled receipt or structured definite pre-effect rejection | `cancelled` with reason | allowed | no automatic retry in this scope |
| timeout, malformed response, process loss, or receipt not found after an attempt may have begun | `uncertain` | allowed | forbidden |

A duplicate Core-submission response is not a failure and does not trigger a
new prompt call; receipt lookup determines the durable result. The store may
scan `recorded` work after restart because no call started. It may scan
`attempting`/`uncertain` work only for receipt and event evidence.

Core `agent_blocked` remains a definite Core decision made before terminal
input. Swarm does not predict it from a snapshot. Rejection feedback is
durable, and later unrelated inputs are still independently eligible.

Exact recovery has four explicit results:

- `recovered` with `complete=false`: stage the returned page and continuation
  only, with no formal projection or CardKit effect;
- `recovered` with `complete=true`: validate the completed staged snapshot,
  rebuild from empty state, and atomically replace the Turn projection plus
  repair delivery intent;
- `indexing`: retain recovery work and retry the read under the existing bounded
  recovery scheduler;
- `not_found`: open/retain a Turn projection gap without prompt replay;
- `ambiguous`, including a completed-snapshot conflict with live evidence:
  retain the old projection and open/retain a gap requiring operator evidence.

Core stable event IDs prove subset compatibility; they do not authorize append
after deduplication. The recovery path never concatenates live and recovery
batches or sorts their union.

### Compatibility and Migration

Migration is expand, migrate, then contract. Every intermediate release remains
restart-safe and never replays possibly delivered work.

1. **Core capability first:** release the versioned first-session submission
   contract while preserving existing endpoint behavior. Verify duplicate,
   terminal/session fencing, restart, and human-message binding in Core.
2. **Expand Swarm persistence and adapters:** add Submission Intent storage,
   receipt query support, durable exact-recovery snapshot staging, atomic Turn
   projection replacement, capability/readiness reporting, and new status
   fields. Existing Prompt execution remains intact for legacy rows.
3. **Recover the incident through authoritative replacement:** consume the
   existing terminal receipt and complete 61-event Core snapshot, prove the
   existing live projection is a compatible subset, atomically rebuild the
   Turn, and enqueue repair delivery without prompt submission. This is the
   first production-shaped proof of ordered recovery.
4. **Switch new Primary input:** route explicit controls separately and send all
   remaining eligible bound-thread text through Agent Input. Stop creating
   Prompt Inputs, Native Input Batches, or Prompt Jobs for those messages.
5. **Switch initial and Worker input:** reuse the same deep module and preserve
   owner-specific authorization and cards.
6. **Migrate legacy never-submitted work:** convert only rows with durable proof
   that no effect attempt began. Decompose batches into original source
   messages. Their later Core JSONL position is authoritative; old ordinals and
   timestamps do not backdate them.
7. **Converge legacy possible effects:** for submitted, running, recovering,
   uncertain, and detached rows, query receipt and recover exact Turns only.
   Terminal rows remain historical projections.
8. **Contract:** after migration diagnostics prove no eligible legacy work
   remains, remove Prompt admission/batching/dispatch/recovery composition,
   queue feedback, detached blocking, sessionless executor fallback, old status
   counters, and obsolete schema in a separately verified migration.

Existing public cards may retain their message IDs and visual identity while
their backing execution fields are translated to Core projection state.
Delivery outbox identities and CardKit stream sequencing remain compatible.
No migration reads Lark cards to repair SQLite or Core.

The standalone service can temporarily expose legacy and new metrics side by
side, but final readiness and status use Submission Intent and Core projection
language. Documentation in `docs/architecture.md`, domain contexts, and
`docs/feishu-group-usage.md` must be updated in the same delivery before old
queue semantics are removed.

## Testing Decisions

### Gate 2 traceability

Every approved scenario and invariant has an observable verification seam. The
detailed test decisions below are authoritative; this table prevents later
ticket decomposition from silently dropping a behavior.

| Reference | Responsible verification seam |
| --- | --- |
| SCN-1 | Inbound-routing tests plus Agent Input submission/projection integration |
| SCN-2 | Routing tests and Core structured-acceptance/rejection integration |
| SCN-3 | Concurrent submission and ordered-projection integration |
| SCN-4 | Submission Intent persistence and restart-recovery integration |
| SCN-5 | Non-blocking persistence/concurrency integration with detached or uncertain A and eligible B |
| SCN-6 | Unmatched Core `human_message` projection integration |
| SCN-7 | Primary/Worker command-routing integration |
| SCN-8 | Live ordered-batch projection, duplicate-idempotency, and same-timestamp regression tests |
| SCN-9 | Incomplete snapshot staging, complete atomic replacement, subset/conflict, and gap integration |
| SCN-10 | The 61-event incident snapshot fixture with atomic-repair and no-submission assertions |
| SCN-11 | Core first-session contract tests, installed-binary smoke, and Swarm capability integration |
| SCN-12 | Legacy migration persistence and recovery-only integration |
| INV-1, INV-2 | SQLite uniqueness, immutable duplicate, and round-trip tests |
| INV-3 | Restart tests proving query-only recovery after `attempting` |
| INV-4 | Detached/uncertain A and independently submitted B integration |
| INV-5, INV-6 | Live `A,C` then complete `A,B,C` replacement regression, incomplete-page no-effect, and conflict tests |
| INV-7 | Projection/delivery tests plus source-dependency checks preventing card-to-execution feedback |
| INV-8 | Bound-thread explicit-control routing tests |
| INV-9 | Recovery tests whose submission port fails the test if invoked |
| INV-10 | Legacy possible-effect migration tests proving no new submission work is created |

### Core contract verification

Core tests must prove:

- first-session submission under exact Pane, terminal, and Agent-kind fences;
- existing-session exact fencing;
- duplicate submission identity never writes terminal input twice;
- conflicting identity/body rejection;
- restart persistence of pending submissions;
- blocked and stale-fence rejection before input;
- first human-message binding to the newly created session and Turn;
- receipt state transitions through prepared, observed, terminal, and
  cancelled;
- live and exact-recovery forms produce stable matching event IDs and preserve
  JSONL order.

The real installed-binary smoke must feature-detect the capability and exercise
one disposable first-session submission; unit tests alone do not prove the
deployed CLI/API contract.

### Swarm domain and persistence tests

At the SQLite adapter seam, tests cover INV-1 through INV-4 and INV-10:

- duplicate Feishu delivery returns the same immutable Submission Intent;
- conflicting body/target reuse is rejected;
- `recorded -> attempting` is atomic under competing drainers;
- reopen of `recorded` work remains eligible;
- reopen of `attempting`, `prepared`, or `uncertain` work performs queries only;
- a detached/uncertain A does not block admission or submission of B;
- receipt transitions round-trip without changing frozen body or route fences;
- legacy never-submitted members migrate once, while possible-effect rows never
  become submission work.

Persistence tests verify controlled reconstitution: loading a Submission
Intent cannot call Core, publish lifecycle events, or make an uncertain state
replayable.

### Routing and command tests

Existing inbound-routing and command integration seams prove SCN-1, SCN-2, and
SCN-7:

- ordinary and unknown slash text in a bound Primary thread reach Agent Input
  unchanged;
- `/swarm ...` continues through Command Intent with current authorization and
  confirmation rules;
- reserved Worker controls remain scoped to Worker Session threads;
- ordinary bot mentions in a bound thread bypass natural-language control
  interpretation;
- unbound root provisioning and administrative controls retain their existing
  behavior;
- size, chat, actor, and project allowlists cannot be bypassed by the simpler
  routing path.

### Submission and recovery integration tests

Coordinator/adapter integration tests prove SCN-3 through SCN-6 and SCN-8
through SCN-12:

- two concurrent ingress messages create independent submissions and project
  the Core human-message order, not callback order;
- working and blocked snapshots do not suppress the Core call;
- Core structured rejection produces no Turn and no retry;
- timeout after the attempt fence is uncertain, B still submits, and restart
  queries rather than resends A;
- duplicate Core response triggers receipt lookup;
- unmatched Herdr human input creates the same Turn projection shape;
- incomplete exact-recovery pages survive reopen but leave formal Turn views,
  frozen Answer pages, and outbox work unchanged;
- live `A,C` followed by a completed `A,B,C` snapshot atomically produces
  `A,B,C`, never `A,C,B`, with one repair revision and no duplicate delivery
  intent;
- a terminal repair retains frozen Answer-page delivery history, creates one
  idempotent late-recovery continuation card, and advances the normal
  replaceable Main Card view rather than patching frozen content;
- duplicate complete recovery is idempotent by snapshot identity/revision;
- an extra or content-conflicting live event leaves the existing projection
  unchanged and opens an `ambiguous` gap;
- a crash before replacement commit leaves the old projection; a crash after
  commit reopens the new projection and its durable repair intent together;
- `indexing`, `not_found`, and `ambiguous` produce their specified recovery and
  gap outcomes without an external submission;
- the incident fixture rebuilds all 61 events in their Core order and produces
  terminal Answer/Main repair delivery intent without calling `queuePrompt` or
  its replacement submission port;
- first-session input uses only the advertised Core capability and has no
  `runPrompt` fallback.

An explicit regression fixture must use same-timestamp human/tool events whose
hash order differs from JSONL order. The projected order must equal the input
array exactly. A test that merely produces a deterministic local order is
insufficient. A second fixture must exercise the cross-read `A,C` / `A,B,C`
case; per-batch order plus append-after-dedup is explicitly not an acceptable
result.

### Structural and full verification

Architecture-boundary tests verify that routing depends on the Agent Input
interface, the Agent Input application module owns Core/store ports, domain
code imports no Herdr or Gateway adapter types, and no new-input caller reaches
Prompt batching/dispatch stores. Source searches and composition tests verify
that final composition has no new-path use of `NativeInputBatch`,
`claimNextDispatchablePrompt`, ordinary queue-position projection, or
sessionless `runPrompt` fallback.

Each implementation ticket runs its focused tests, `npm run typecheck`, and
`npm run build`. Cross-workflow, persistence, and migration tickets also run the
full `npm test`. Core tickets run the repository-prescribed Core checks and a
real disposable runtime smoke before Swarm cutover. Final delivery repeats all
applicable full suites and validates status/readiness against the installed
candidate without mutating the production database during test discovery.

## Out of Scope

- Remote approval or denial of high-risk Agent prompts remains forbidden.
- Arbitrary terminal input, process kill, Pane kill, and CardKit-to-terminal
  passthrough are not introduced.
- The Lark outbox, CardKit transport sequencing, pagination, and general
  historical dead-letter cleanup are not redesigned. They remain delivery-only
  concerns, although the incident's resulting delivery must converge.
- Worker topology, worktree allocation, Pane lifecycle, model catalog policy,
  and project authorization rules are not broadened.
- Core JSONL producer semantics beyond the approved first-session submission
  correlation contract are not changed.
- A global chronological merge across sessions, Turns, sources, or recovery
  batches is not created.
- Automatic retry after a Core-cancelled submission is deferred; the approved
  behavior is a visible rejection and a new human source message if desired.
- This specification does not authorize deployment, production database
  mutation, pushing, a pull request, or external issue creation.

## Further Notes

### Workspace and baseline

- Workspace mode: isolated linked Git worktree.
- Workspace: `/tmp/herdr-agent-swarm-unified-agent-input`.
- Branch: `feat/unified-agent-input`.
- Starting revision: `312fc759d8c4577ee11d40b703e741b40d1a6920`.
- Isolation rationale: the original checkout contains user-owned modifications
  and untracked work, while this change spans ingress, persistence, Core
  integration, projection, commands, status, migration, and documentation.
- Original-checkout changes preserved and excluded: modified `TODO.md`; untracked
  `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Dependency preparation: `npm ci` completed with 115 packages installed. npm
  reported two existing high-severity audit findings; dependency remediation is
  outside this specification and no package versions were changed.
- Fresh baseline on Node `v24.14.1`, npm `11.11.0`:
  - `npm run typecheck` passed;
  - `npm run build` passed and generated build identity
    `sha256:5a14ca70d2a24f23427639a4a1637746aed2d8e2d560eb4c567d0c6046eea9e2`;
  - `npx vitest run tests/standalone-install.test.ts` passed, 26/26;
  - a final serial `npm run build` followed by `npm test` passed all 254 test
    files and all 3711 tests.

Two earlier validation attempts exposed command-order constraints rather than
source failures: running the suite before build left `dist/build-info.json`
absent, and running build concurrently with the suite raced on the generated
`dist` tree. The final build and complete suite were run serially and passed
without a source change.

### Approval status and cross-repository readiness

Gate 1 originally approved the selected design after live Herdr 0.9.3 and
Core-source verification. It was reopened when continued review proved that
per-batch ordering plus event-ID dedup cannot preserve order across a live
`A,C` projection and later `A,B,C` recovery. The user then approved complete
Turn snapshot staging and atomic replacement as the authoritative recovery
strategy. This revised document is the Gate 2 artifact and does not authorize
implementation.

There are no unresolved load-bearing design decisions at Gate 2. The Core v2
capability is a delivery prerequisite, not an undecided contract: its required
request fences, idempotency identity, receipt behavior, feature detection, and
failure outcomes are specified above. Its implementation still requires a
separate safe Core workspace and fresh Core baseline.

Implementation spans this repository and the local Herdr Core contract. The
Core ticket requires its own safe workspace, current project instructions, and
fresh baseline before mutation. Core capability delivery and installed-binary
verification block new-input cutover, but they do not block isolated Swarm
persistence, routing, projector, or migration-fixture preparation that remains
green behind an unadvertised capability.
