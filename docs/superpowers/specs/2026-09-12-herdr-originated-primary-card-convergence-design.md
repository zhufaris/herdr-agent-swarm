# Herdr-Originated Primary Card Convergence Design

## Problem

A user can type a prompt directly into the TraeX process running in a Herdr pane,
bypassing Lark ingress. The existing `ExternalTurnObserver` can adopt that exact
transcript turn, persist a Herdr-originated prompt, and publish the same lifecycle
events used by Lark-originated work. `ConversationViewProjector` already reduces
those events into both the Primary Answer Card and Primary Main Card.

The production Herdr event route does not explicitly wake this Primary observer.
Pane hints currently reconcile Primary binding state and Worker instance/turn
state, but Primary transcript observation happens only indirectly during binding
reconciliation and through a two-second periodic scan. In addition, the first
observation of a newly tracked binding opens an EOF cursor and returns without
draining it. A direct Herdr turn can therefore wait for another periodic pass,
making both Primary cards appear stale after a single pane event.

## Goals

- Route relevant Herdr hints to the Primary external-turn observer after binding
  identity reconciliation.
- Keep canonical TraeX transcript observations as the only message/output source.
- Drive both Primary Main Card and corresponding Answer Card through the existing
  lifecycle-event projector and durable outbox.
- Preserve EOF baselining so pre-binding historical turns are not replayed.
- Keep event hints best-effort and periodic scans authoritative for convergence.
- Preserve exact turn ownership, generation/session fencing, and no Prompt
  replay.

## Non-goals

- Reading terminal screen text or shell input as message authority.
- Sending cards directly from the Herdr event router or observer.
- Creating an Answer Card for historical turns completed before a binding was
  observed.
- Updating Worker Main/Task behavior; Worker turns retain their existing
  observer.
- Changing CardKit rendering, pagination, outbox ordering, or delivery retries.
- Guaranteeing that every keystroke produces a card update; transcript records
  remain the unit of observation.

## Existing authority and reusable path

The implementation retains the current authority chain:

```text
Herdr pane identity              -> binding/runtime reconciliation
TraeX JSONL transcript           -> exact external-turn observation
SQLite                           -> prompt, RunCard, TopicView, outbox intent
BridgeEventBus                   -> low-latency projection hint
AnswerPageWorkflow/MainCardFlow  -> durable card convergence
Lark                             -> visible delivery only
```

`ExternalTurnObserver.apply()` already publishes `TurnStarted`,
`TurnOutputObserved`, `TurnCompleted`, and `TurnFailed` with `origin='herdr'`.
`ConversationViewProjector` already processes each event serially per binding:
it reduces the RunCard and schedules Answer convergence, then reduces the
TopicView and schedules Main Card convergence. No second renderer or direct Lark
path is needed.

## Considered approaches

### 1. Route Primary observation after binding reconciliation (selected)

Extend `HerdrEventRouter` with an explicit Primary observer port. For pane-scoped
hints, await binding reconciliation first, then observe the affected Primary
panes. Other independent consumers continue concurrently. This provides fresh
binding/session identity before transcript access and preserves the existing
event-driven projection path.

### 2. Let `BindingRuntimeConverger` remain the only caller

This minimizes wiring changes, but transcript observation is hidden inside a
runtime-state workflow and its first-call baseline behavior can consume the only
event wake-up. It also makes routing intent hard to test independently.

### 3. Update Main and Answer projections directly from the observer

This could reduce latency but creates a second projection implementation,
bypasses the lifecycle event bus, and risks divergent versions or duplicate
outbox intents. It is rejected.

## Herdr event routing

Add this narrow router dependency:

```ts
observePrimaryTurns(paneIds?: readonly string[]): Promise<void>;
```

Routing rules:

- **pane-scoped hint:** invalidate pane caches; await targeted binding
  reconciliation; then call `observePrimaryTurns(paneIds)`. Instance
  reconciliation, Worker turn observation, and retired-pane cleanup remain
  independent and may run alongside this ordered Primary chain.
- **workspace-scoped hint with pane IDs:** await workspace binding reconciliation,
  then observe those Primary panes. If the hint has no pane IDs, periodic Primary
  scanning remains the fallback rather than expanding one topology hint into an
  unbounded full transcript scan.
- **full-scope/socket-recovered hint:** await full binding reconciliation, then
  call `observePrimaryTurns()` once. This rebuilds observer cursors from current
  durable identities without trusting socket payloads.

The router's `run` helper continues isolating consumer failures. The ordered
Primary chain is one consumer promise: a binding-reconciliation failure prevents
that pass from reading a potentially stale transcript identity, logs one bounded
failure, and leaves periodic reconciliation available. Failures in instance or
cleanup consumers do not suppress Primary observation.

## Cursor initialization and event timing

Opening the normal `latest` transcript cursor positions it at EOF and records a
bounded lifecycle/token baseline. That is essential: it prevents old transcript
history from becoming new Lark prompts.

The observer retains this rule. It does not attempt to drain historical bytes on
first registration. Instead:

- startup/runtime reconciliation initializes cursors for already bound Primary
  panes before live Herdr event handling starts;
- later pane events explicitly invoke `observeByPane` and drain bytes appended
  after that baseline in the same routed pass;
- if a binding is newly discovered by the same event, the first call establishes
  its baseline and deliberately does not adopt a turn that predates binding
  ownership;
- the next transcript append or periodic scan handles later records.

This chooses no historical replay over guessing whether a turn written before
ownership should be surfaced. A future explicit import feature would require a
separate policy and UI.

## Projection and delivery behavior

Once an external turn has a scoped `task_started` and `user_message`:

1. `adoptExternalTurn` transactionally creates or adopts the exact prompt,
   records `execution_origin='herdr'` and transcript identity, and reserves the
   initial Answer Card intent when needed.
2. The observer wakes outbound delivery for any reserved initial Answer Card.
3. `TurnStarted` updates both RunCard and TopicView through the existing
   projector.
4. `TurnOutputObserved` carries separate Answer and Main sub-projections from one
   parsed transcript observation. Answer text/tool activity updates the RunCard;
   status/plan/token fields update the TopicView.
5. `TurnCompleted` or `TurnFailed` terminalizes the durable prompt and drives
   terminal Answer and Main convergence.
6. Both card families enter the existing claim-fenced, ordered outbox. No Lark
   call occurs in the observer or router.

The Main Card may update even when an observation contains only Main status. The
Answer Card updates only when its own view changes. Conversely, Answer content
can update while Main content remains unchanged; lifecycle phase still converges
through the shared events.

## Deduplication and recovery

- Router hints are coalesced by the existing bounded hint merger.
- Primary observation is serialized per binding by `ExternalTurnObserver`.
- The transcript cursor rejects duplicate observations and preserves exact turn
  boundaries.
- `adoptExternalTurn` rejects cross-binding turn ownership and returns
  `already_owned` for the same durable prompt.
- Repeated lifecycle events reduce idempotently and existing projection/outbox
  keys suppress duplicate visible work.
- If the event hint is lost, the two-second external-turn scan remains the
  convergence fallback.
- If projector delivery fails, durable RunCard/TopicView and startup convergence
  recreate missing delivery intent without replaying TraeX.

## Composition and startup order

`createBindingSessionRuntime` wires `externalTurns.observeByPane` and
`externalTurns.scanActiveBindings` into `HerdrEventRouter`. No new global event
bus or store capability is added.

Managed startup already completes startup recovery/runtime reconciliation before
starting `externalTurns` and the Herdr socket subscriber. That reconciliation
calls the observer for each active Primary binding and therefore remains the
single baseline pass; this slice does not add another startup stage. It opens
cursors for current active Primary bindings and publishes no historical turns.
If an individual transcript is unavailable, the observer retains its existing
bounded logging/fallback behavior and startup remains degradable rather than
destructive.

## Failure boundaries

- Missing or unsupported native session identity: do not observe transcript and
  do not synthesize card content.
- Binding/session/generation mismatch: reject adoption and publish nothing.
- Binding reconciliation failure in a hint: skip Primary observation for that
  routed pass; periodic recovery remains.
- Transcript read failure: discard that cursor, log bounded identity fields, and
  retry on a later hint/scan.
- Lifecycle subscriber failure: the event bus isolates it; durable prompt/view
  state remains authoritative and startup convergence repairs delivery intent.
- Lark delivery failure: existing outbox retry, effect-certainty, recovery, and
  quota-cooldown rules apply unchanged.
- Shutdown: stop accepting observer work and await tracked observations before
  closing SQLite, as today.

## Tests

### Router seam

- A pane-scoped agent-status hint runs binding reconciliation before targeted
  Primary observation.
- Instance reconciliation, Worker observation, and cleanup still run even if the
  Primary chain fails.
- A workspace hint with pane IDs observes those panes after binding reconcile.
- A full-scope hint performs one full Primary observation after full binding
  reconcile.
- Coalesced hints preserve the union of pane IDs and do not duplicate one routed
  pass.

### Observer and integration seams

- Startup baseline initialization creates no prompt or card intent from existing
  transcript history.
- A later direct Herdr turn is adopted once with `executionOrigin='herdr'`.
- Start, output, and completion events update both the corresponding RunCard and
  TopicView.
- With fake Lark delivery, the Answer Card and Primary Main Card both receive the
  expected latest visible state.
- Main-only status and Answer-only content exercise their independent projection
  branches.
- Duplicate pane hints do not create another prompt, Answer Card, or Main Card
  revision.
- A Worker pane does not become a Primary external prompt.
- Missing transcript/session identity and subscriber failure remain contained.

Run focused event-router, external-observer, discovery integration, card
projection, startup, and shutdown tests, followed by `npm run typecheck`,
`npm run build`, `npm run architecture:check`, `npm test`, and
`git diff --check`. Tests use fake Herdr/Lark ports and temporary transcripts and
SQLite only.

## Acceptance criteria

- A transcript turn entered directly in an already bound Primary Herdr pane is
  observed from a pane hint without waiting for the periodic scan.
- The same canonical lifecycle stream converges both Primary Main and Answer
  cards through durable outbox intents.
- Existing transcript history is not replayed during startup or first binding.
- Duplicate hints and restarts do not duplicate prompts or cards.
- Worker and Primary observation remain scoped to their own ownership models.
- No prompt is submitted to TraeX as part of external-turn adoption or recovery.
- No direct Lark mutation, sensitive logging, deployment, restart, or push is
  introduced by this slice.
