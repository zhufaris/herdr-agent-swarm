# Strict Prompt FIFO and Detached Recovery

## Problem Statement

An ordinary Feishu Prompt can currently be submitted through `herdr agent prompt`
while its bound Agent is already `working`. The Swarm treats the presence of a
native submission receipt as if Herdr supplied a next-turn queue. Herdr's actual
contract is weaker: it writes the input to the active terminal, does not track an
individual turn, and an already-running turn can satisfy its wait. TraeX can
therefore consume the new `human_message` inside the current Core turn.

This happened on binding `eca85fcd-165e-4c00-91f6-ce6818fa9cc4`. Prompt
`a38891c2-0dfe-4850-90d3-fcd70e57e200` appeared as a `human_message` in Core
turn `01a0f80b-3332-7a30-b1c6-74d8fc5130ed`, which was already owned by Prompt
`080d5079-b519-4773-a100-2d969785921b`. The owner correctly retained the turn
and its Answer, while `a38891c2-...` had no independent turn or Answer and stayed
`recovering/detached`.

Historical `recovering/detached` Prompts do not occupy the ordinary execution
slot, so they do not directly block admission or dispatch. However, recovery is
oldest-first and currently cannot advance a head whose durable Core evidence
shows a conflicting owner or whose submission receipt is unavailable. This can
leave a visible empty Answer and an indefinitely growing recovery backlog even
though later ordinary Prompts execute.

## Solution

Enforce strict SQLite-owned FIFO for ordinary Prompts. An ordinary Prompt may be
submitted only when the exact bound pane and session are dispatchable and the
pane is `idle` or `done`; `working`, `blocked`, and `unknown` are not dispatchable.
Native submission identity remains useful evidence, but it no longer grants
permission to bypass the execution slot. Explicit steering remains the only
path that may inject input into an active exact turn.

Submit at most one native ordinary Prompt per dispatcher drain and require the
Herdr adapter to observe post-submission `working` or `blocked` activity when
the submission began from a settled state. A timeout or stalled observation is
treated as possibly dispatched: persist detached recovery state and never
replay it.

Extend projected Core recovery to distinguish a matching submission found in a
turn owned by another Prompt. Such a Prompt must not claim that turn or copy its
Answer. Instead, the existing exact-pane, exact-session, idle/done and
oldest-first bounded recovery path terminalizes it as `uncertain`. A missing
submission receipt is also eligible for bounded recovery. A later exact Core
projection may still repair an `uncertain` Prompt through the existing late
repair path.

No production SQLite row is edited manually. Existing historical rows converge
through the normal recovery workflow after deployment. Installation and restart
are separate operational actions and are not authorized by this specification.

## User Stories

### SCN-1: Ordinary input arrives during an active turn

As a Feishu user, when I send one or more ordinary messages while the bound Agent
is `working`, each message is durably admitted in FIFO order but no message is
written into the active terminal. After that turn settles, only the FIFO head is
submitted as the next ordinary turn.

### SCN-2: A settled pane receives a native submission

As the workflow coordinator, when the exact pane and session are `idle` or
`done`, I submit only the FIFO head with its Prompt ID as the native submission
ID. I do not submit another ordinary Prompt in the same drain. The submission
must produce observed `working` or `blocked` activity; otherwise its effect is
uncertain and it enters detached recovery without replay.

### SCN-3: Explicit steering targets an active turn

As a Feishu user, I can still use the explicit steering command against the
identity-fenced active turn. Steering does not enter the ordinary FIFO and does
not weaken ordinary Prompt serialization.

### SCN-4: A detached submission was absorbed by another Prompt's turn

As a Feishu user, when durable Core events show my submission inside a turn that
another Prompt already owns, the owner keeps its Answer and my Prompt is shown
as `uncertain` after bounded recovery. My request is never replayed and the old
owner's Answer is never copied to my card.

### SCN-5: A detached submission has no retrievable receipt

As an operator, when an identity-fenced historical Prompt has no submission
receipt and the exact pane/session is settled, recovery records bounded attempts
and eventually marks the FIFO recovery head `uncertain`. It then advances the
remaining recovery backlog while ordinary dispatch remains available.

### SCN-6: Exact evidence arrives after uncertainty

As a Feishu user, if exact projected Core evidence later becomes available for
an `uncertain` Prompt, its Answer can be repaired through the existing late
recovery path without submitting the request again.

## Implementation Decisions

### Domain Model

The affected bounded context is **Prompt Execution**. SQLite owns ordinary
Prompt admission, FIFO order, lifecycle, submission identity, and turn
ownership. Herdr owns live pane/session identity and Agent state. Core events
are evidence about submissions and turns. Lark is a projection and never
decides workflow state.

The canonical terms are:

- **ordinary Prompt**: a new user request that requires its own Core turn;
- **steering**: explicit input to one exact active turn;
- **execution slot**: the right for one ordinary Prompt to be submitted or run
  for a binding;
- **detached recovery**: observation of a possibly executed Prompt without
  replay;
- **conflicting turn owner**: another Prompt that already owns the exact
  `(pane, session, turn, startedAt)` tuple containing the submission.

No new entity or aggregate is introduced. `PromptJob` remains the lifecycle
entity, and the SQLite prompt stores remain the atomic consistency boundary for
claiming FIFO work, assigning turn ownership, and terminalizing recovery.

#### INV-1: One ordinary execution at a time

A binding submits at most one ordinary Prompt at a time. A native capability or
submission receipt cannot bypass this invariant. The dispatch store enforces
the atomic claim, while the coordinator verifies live runtime state immediately
before external submission.

#### INV-2: Recovering history does not monopolize dispatch

A historical identity-less `recovering/detached` Prompt does not occupy the
ordinary execution slot. Once the exact pane is settled and no submitted or
running ordinary Prompt owns the slot, the next queued Prompt may dispatch.

#### INV-3: Possible delivery is never replayed

After terminal input may have been written, failures, timeouts, or missing
receipts can only lead to observation or `uncertain`; they cannot requeue the
same Prompt for automatic submission.

#### INV-4: A Core turn has one Prompt owner

Conflicting ownership evidence cannot transfer or duplicate an existing
Answer. The losing Prompt becomes `uncertain` through fenced recovery.

#### INV-5: Detached recovery is bounded and fenced

Automatic terminalization requires the oldest eligible recovery head, matching
binding generation, pane ID and native session ID, plus `idle` or `done` runtime
state. It occurs after the configured age or the existing due-attempt limit and
is committed atomically with the Run Card and outbox intent.

### Architecture

#### ARCH-1: Dispatch store owns eligibility

`PromptDispatchStore.claimNextDispatchablePrompt` exposes one strict ordinary
FIFO contract. It must not accept a capability flag that changes `working` into
a dispatchable state or bypasses existing submitted/running work. Recovering
rows remain excluded from the execution-slot predicate.

#### ARCH-2: Coordinator submits one ordinary Prompt

`PrimaryPromptDispatcher` chooses native versus observed submission only after
the strict claim and exact runtime identity check. It rejects
`working/blocked/unknown`, submits at most one native Prompt per drain, and
returns after persisting either its receipt or its uncertain effect. The
`PromptRunWorkflow` does not start a second native queue worker merely because a
new ordinary Prompt arrived while another binding worker exists.

#### ARCH-3: Herdr adapter exposes activity acknowledgement

The Herdr adapter continues to own CLI argument and JSON conversion. Its native
submission interface guarantees that calls begin only from a non-working state
and use the CLI's atomic submit-and-wait behavior to observe `working` or
`blocked`. Adapter errors retain existing pre-dispatch versus possibly-dispatched
classification; the coordinator owns the no-replay decision.

#### ARCH-4: Recovery store exposes precise evidence

`PromptRecoveryStore.recoverProjectedBridgeTurn` returns a distinct
`turn_owned_by_other_prompt` outcome, carrying only bounded identifiers needed
for logging and recovery. The SQLite implementation derives it transactionally
from projected Core events and existing turn ownership. It never mutates either
Prompt when reporting the conflict.

#### ARCH-5: Recovery coordinator owns bounded progression

`PromptRunWorkflow` maps `turn_owned_by_other_prompt` and
`submission_receipt_unavailable` into the existing bounded recovery operation.
After terminalizing one head, it wakes durable recovery work again so later
detached rows converge. Ordinary `prompt-ready` scheduling remains independent.

Source dependencies continue inward through domain-owned prompt-run ports:
coordinators depend on those ports, SQLite and Herdr adapters implement the
contracts, and `src/main.ts` remains the composition root. No adapter type or
raw CLI response enters coordinator policy.

### Behavior & Failure Modes

- A Prompt arriving during `working` remains `queued/not_started`; it is not a
  submission failure and does not create detached state.
- A native submission rejected before input is written releases the atomic
  claim and remains eligible for later FIFO dispatch.
- A native submission that may have written input becomes detached and is never
  automatically replayed.
- A native submission accepted from `idle/done` cannot be followed by another
  native ordinary submission in the same drain, even if Herdr state propagation
  lags.
- A conflicting turn owner produces no Answer reassignment. Recovery records
  the uncertainty on the losing Prompt and preserves the existing owner.
- A missing receipt is not treated as proof of non-delivery. It only becomes
  eligible for fenced, bounded uncertainty.
- `blocked` and `unknown` never trigger automatic ordinary dispatch or recovery
  terminalization.
- Duplicate wake hints are harmless: SQLite claims and recovery fences provide
  idempotency, and only one state transition/outbox intent can win.

### Compatibility & Migration

No schema migration is required. Existing Prompt states and the
`detached_prompt_recovery_attempts` table are sufficient. The behavior change
removes the unsupported assumption that native prompt submission is a
turn-aware queue. Existing explicit steering and late Answer repair remain
compatible.

After deployment, aged conflicting or receipt-less recovery heads can converge
through the normal safety scan. Current production data is not rewritten during
installation, and no Prompt is replayed.

## Testing Decisions

- `tests/primary-prompt-dispatcher.test.ts` verifies INV-1 and ARCH-2: a working
  pane is not submitted to, a settled pane submits one native Prompt per drain,
  and possibly-dispatched errors detach without replay.
- `tests/concurrency-controls.integration.test.ts` verifies SCN-1 and SCN-2
  through the public coordinator/message seam: multiple messages during an
  active turn remain queued, then form distinct turns in FIFO order after
  settlement.
- `tests/herdr-adapter.test.ts` verifies ARCH-3 at the command-runner seam:
  native submission requests activity acknowledgement and preserves receipt and
  error classification.
- `tests/sqlite-store.test.ts` and
  `tests/detached-core-recovery.integration.test.ts` reproduce SCN-4 with one
  owner Prompt and one matching submission in the same Core turn. They verify
  that ownership and Answer remain unchanged while the losing Prompt converges
  to `uncertain` and the next recovery head can advance.
- `tests/core-event-recovery.test.ts` and
  `tests/prompt-run-safety-scan.test.ts` verify SCN-5 and INV-5, including a null
  receipt, due-attempt persistence, exact session/runtime fences, wake-up of the
  next head, and disabled auto-recovery behavior.
- Existing steering integration tests verify SCN-3 without changing its
  contract. Existing late-repair tests verify SCN-6.
- Each implementation ticket runs its focused tests plus `npm run typecheck`
  and `npm run build`. Delivery runs the full `npm test` suite and reviews the
  source dependency direction separately.

## Out of Scope

- Adding a turn-aware queue to Herdr Core.
- Splitting one Core turn's Answer among multiple Prompt cards.
- Replaying or reconstructing the text of possibly delivered Prompts.
- Manual edits to the production SQLite database.
- Changing explicit steering semantics or remote approval behavior.
- Installing, activating, restarting, or force-restarting the service.

## Further Notes

- Workspace mode: in place.
- Rationale: `main` has no staged or tracked working-tree changes, the task owns
  a new uniquely named specification and later focused source/test edits, and
  no existing worktree is required. Existing user-owned untracked paths remain
  untouched.
- Branch: `main`, ahead of `origin/main` by 122 commits.
- Starting revision: `55cf73104f072bab4d6bd4bc5724c9bc0d553332`.
- Initial untracked paths preserved:
  `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh baseline on 2026-10-01:
  - `npm run typecheck`: passed;
  - `npm run build`: passed;
  - `npm test`: 235 files and 3,234 tests passed.
- An earlier parallel baseline attempt caused eight installer tests to observe
  `dist/build-info.json` while the concurrent build was replacing `dist/`.
  Re-running `npm test` after build completion passed all tests; implementation
  verification must not run full tests concurrently with `npm run build`.
- Gate 1 design and Gate 2 specification were approved by the user on
  2026-10-01.
- No unresolved load-bearing decisions remain.
