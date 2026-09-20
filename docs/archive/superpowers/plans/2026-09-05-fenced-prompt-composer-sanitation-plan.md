# Fenced Prompt Composer Sanitation Implementation Plan

## Objective

Prevent an idle TraeX composer rejection from leaving an identityless detached
prompt at the FIFO head. Managed Primary and TraeX Worker dispatches clear stale
composer text before submission, submit exactly once, and clear again when an
exact-session transcript proves that no turn started.

## Invariants

- SQLite remains authoritative for FIFO ownership and terminal prompt state.
- Herdr plus the exact TraeX transcript remain authoritative for pane, session,
  composer readiness, and turn identity.
- Prompt text is submitted at most once.
- A possibly delivered prompt is never replayed.
- `ctrl+u` is sent only through the logical Herdr agent key surface after exact
  pane/session and settled-state checks.
- Primary and TraeX Worker use one submission outcome vocabulary.
- Unknown slash-prefixed text remains an ordinary prompt.

## Batch 1: Submission result and red tests

1. Add explicit `started`, `not_started`, `rejected`, and `uncertain` submission
   outcomes to the external prompt capability.
2. Add adapter/shim tests reproducing a synchronous slash-command rejection: no
   fresh transcript turn, unchanged exact session, idle composer, and residual
   submitted text.
3. Assert the command sequence is `ctrl+u`, one prompt submission, `ctrl+u`;
   assert that conflicting identity or lifecycle evidence never returns
   `not_started`.
4. Add Primary integration coverage proving `not_started` terminalizes the head
   and lets the next FIFO prompt become claimable.
5. Add TraeX Worker coverage proving it uses the same sanitation capability.

## Batch 2: Herdr submission boundary

1. Extend the installed TraeX shim with a session-fenced managed prompt command
   that opens the exact transcript cursor before terminal mutation.
2. Validate settled runtime, exact session, and composer readiness before sending
   logical `ctrl+u`; repeat the identity/transcript check before submitting.
3. Submit prompt text exactly once and reuse current transcript settlement for a
   fresh exact turn, including very short completed turns.
4. When no turn starts, perform the second fenced `ctrl+u`, recheck the target
   and transcript, and return `not_started`; preserve `uncertain` for all
   ambiguous evidence.
5. Normalize and redact command results in `HerdrCliAdapter`; propagate the new
   capability through the circuit-breaker and snapshot-cache decorators.

## Batch 3: Durable Primary and Worker integration

1. Make `PromptRunWorkflow` call the fenced capability for exact-session TraeX
   bindings and map its result to existing exact-turn observation.
2. Add one atomic store transition for `not_started` that fails the prompt,
   updates Run/Main Card projections, and records outbound intent before wake-up.
3. Preserve detached/no-replay behavior for `uncertain`, and use the existing
   safe pre-dispatch path for `rejected`.
4. Route `TraexDriver` Worker dispatch through the same capability and map
   `not_started` to a terminal failed `InstanceTurn`; leave other agent drivers
   on their existing contract.
5. Keep historical identityless detached prompts unchanged; recovery requires
   evidence captured by the new protocol.

## Batch 4: Verification and rollout

1. Run focused shim, Herdr adapter, concurrency, Worker driver/observer, and
   SQLite tests.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Commit implementation in dependency-complete batches.
4. Install the immutable release and force-restart the service.
5. Verify `/health`, `/ready`, build identity, SQLite integrity, and one
   disposable live slash-rejection smoke.
6. Recover the existing `task-f1hq` identityless detached head only through an
   explicit operator action; do not retroactively apply evidence that was not
   captured at its dispatch boundary.
