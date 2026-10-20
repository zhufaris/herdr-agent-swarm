# Runtime Model Preference Deep Module Design

## Goal

Make `/swarm model` easy to understand and hard to misuse by concentrating the
runtime model-preference lifecycle behind one deep module and by rendering an
explicit state projection in Feishu.

The command keeps its current safety contract: a validated model choice applies
only to the next ordinary FIFO prompt. It never interrupts an active turn,
drives the interactive TraeX `/model` terminal UI, or automatically replays a
prompt whose delivery may have started.

## Scope

This change covers Primary bindings backed by an attached native TraeX session.
It includes model catalog lookup, preference selection, prompt claim, structured
model-prompt evidence, crash recovery, Main Card projection, and the dedicated
model-selection card.

It does not add Worker model switching, provider selection, reasoning modes, or
arbitrary terminal control. Removing the standalone `👤 Human message` card is
a separate TDD slice because it changes Answer/outbox presentation rather than
runtime model preference semantics.

## Deep module and seam

Introduce a `RuntimeModelPreference` domain module. Its interface exposes only
the intents callers need:

1. request a validated preference for an exact binding generation;
2. read a presentation snapshot for a binding; and
3. record a discriminated dispatch-evidence event for an already pinned prompt.

The module implementation owns revision allocation, allowed state transitions,
prompt/session/generation fences, rollback eligibility, uncertain-state rules,
and durable persistence. Callers do not choose the next state directly.

The existing atomic prompt-claim transaction remains the only place that pins a
`pending` preference to the next ordinary prompt. The SQLite adapter invokes the
module's internal claim transition inside that transaction and returns the
resulting model dispatch with the claimed prompt. It must not split prompt claim
and model pinning into separate transactions.

`ModelSelectionWorkflow` remains the interaction adapter. It validates the
binding, obtains the public catalog from `traex models --json`, resolves the
requested catalog name, invokes the module, and publishes the returned
projection. `PrimaryPromptDispatcher` sends a model-aware prompt only through
the Herdr Core capability. Canonical Herdr event adoption owns the atomic
transition from the durable submission receipt to an effective preference.

## Durable state machine

The persisted states remain `pending`, `applying`, `effective`, and `uncertain`:

- `pending`: a desired revision is durable and can be pinned only by the next
  ordinary FIFO prompt for the same binding generation.
- `applying`: the revision is pinned to exactly one claimed prompt. The record
  carries that prompt ID while Core performs the same-pane model resume.
- `effective`: a canonical `HumanMessage` event with the matching native
  submission ID proves the pinned revision belongs to the exact turn. The
  desired model becomes the confirmed effective preference.
- `uncertain`: the request may have reached TraeX but exact acceptance was not
  proved. No automatic retry or replacement is allowed.

A rejection proven to occur before Core accepts the submission may roll
`applying` back to `pending`. Once acceptance may have happened, the prompt is
detached and is observed without replay. Every transition checks binding
generation, desired model and revision, prompt ID, and submission ID. Native
session identity remains
`herdr:traex / traex / id / <uuid>` and is required before model-aware dispatch.

A new selection may replace `pending` or follow `effective` by allocating the
next revision. It cannot overwrite `applying` or `uncertain`; those outcomes are
reported as busy and keep the existing durable intent unchanged.

## Request and dispatch flow

For `/swarm model` without a name, the workflow reads the session-scoped catalog
and returns a fresh selection card without changing preference state.

For `/swarm model <name>` or a card selection:

1. Validate that the binding is active, attached, Primary TraeX, and has an exact
   native session identity.
2. Read `traex models --json` and resolve one canonical model name.
3. Persist the new desired revision before publishing any success notice.
4. Wake normal prompt scheduling and converge the Main Card.
5. Publish a model-state card. A text command creates a new reply card; a card
   action updates only the originating model card.

When the next ordinary prompt is claimed, the SQLite transaction pins the
pending revision to that prompt and changes the preference to `applying`. The
dispatcher passes the pinned model, prompt ID, and exact session identity to
Herdr Core's fail-closed `agent.prompt_model` capability. Core resumes the same
interactive TraeX session in the same pane with the selected model, waits for
exact readiness, and queues the prompt. Swarm persists the Core submission
receipt without assuming a turn ID. The canonical Herdr `HumanMessage` event
later binds that submission to its exact turn and atomically makes the model
preference effective. Steering messages and priority control actions never
consume a pending model preference.

## Card projection

The dedicated model card and Main Card consume the same immutable presentation
snapshot rather than interpreting storage rows independently. The snapshot
distinguishes:

- confirmed current model;
- desired next model and revision;
- applying model and the owning prompt;
- uncertain model with an explicit no-automatic-retry warning; and
- absence of a pending preference.

User-facing text uses `Current`, `Next turn`, `Applying`, and `Uncertain` with a
  compact revision indicator. Internal session UUIDs and submission IDs are not
shown. They remain available in structured logs and durable records for
correlation.

Card coloring is deterministic: pending is green, applying is blue, uncertain
is orange, and effective/no pending change is blue. A successful selection says
that it is saved for the next ordinary message; it must not claim that the
running Agent was switched immediately.

## Failure and recovery

- Catalog failure creates or updates only the model response card and does not
  mutate preference state.
- Unsupported agent kinds, missing native session identity, stale generations,
  and ambiguous model names fail closed.
- An outbox failure retries only the card delivery effect. It never repeats the
  selection mutation or submits a TraeX prompt.
- Startup recovery derives `pending` versus `uncertain` from durable dispatch
  evidence and the same exact fences; it does not infer state from Feishu.
- Existing `uncertain` state survives restart until future explicit recovery
  behavior is separately designed. This change does not add a remote force
  retry.
- The historical `230001: This message is NOT a card` failure cannot recur:
  text-originated commands enqueue a reply card, while card callbacks enqueue a
  card update.

## Testing

Use TDD at the module interface and retain focused adapter/integration coverage:

- domain tests cover every accepted and rejected state transition, revision
  allocation, and exact-fence mismatch;
- SQLite tests prove preference pinning is atomic with ordinary prompt claim and
  that steering/control work does not consume it;
- dispatcher tests cover Core capability detection, accepted submission
  receipts, proven pre-send rejection, ambiguous submission, and no replay;
- SQLite adoption tests cover exact submission binding, model effectiveness,
  generation/revision fences, and transaction rollback on mismatches;
- command integration tests cover list, exact selection, ambiguous/unknown
  names, stale sessions, busy states, text-card creation, and callback-card
  update;
- card tests cover the four states and verify the Main Card and model card are
  driven from the same presentation snapshot;
- regression tests preserve FIFO, one ordinary turn per binding, exact native
  session ownership, frozen Answer pages, outbox idempotency, and no prompt
  replay.

Before deployment, run all affected Vitest files, `npm run typecheck`,
`npm run build`, and the full Vitest suite. Install through `./install.sh`, then
use the supported forced restart only after inspecting live prompt/outbox state.
