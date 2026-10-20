# Feishu Native Input Batching Plan

Specification: [Feishu Native Input Batching](../specs/2026-10-02-feishu-native-input-batching.md)

Workspace: `/tmp/herdr-agent-swarm-feishu-native-input-batching`

Branch: `worktree-fix/feishu-native-input-batching-v2`

Starting revision: `883f008f81dc37a61cd51ff10e0c7f4aad1d8bf0`

Baseline on 2026-10-02:

- `npm run typecheck`: passed;
- `npm run build`: passed;
- serial `npm test`: 237 files and 3,293 tests passed.

Approval status:

- Gate 1 design: approved 2026-10-02;
- Gate 2 specification: approved 2026-10-02;
- Gate 3 tickets and implementation authorization: approved 2026-10-02.

## Tickets

### - [x] T1: Admit one Feishu Prompt Input and execute one immediate batch

**What to build**

Deliver the smallest complete Native Input Batch path for a settled Primary.
One eligible normal ordinary Feishu message is durably admitted as one Prompt
Input, immediately formed as a one-member batch, represented by one execution
Prompt and one Run/Answer Card, and made available to the existing settled-pane
dispatcher. Duplicate ingress returns the same durable input/batch result and
creates no second execution or delivery intent.

This ticket includes the additive persistence foundation needed by every later
slice: Prompt Input, Native Input Batch and ordered membership records; their
domain-owned ports and mappings; one-to-one batch/execution identity; required
indexes and constraints; instance-lease fencing; and legacy schema reopen.

**Spec references**

- SCN-1, SCN-4 and the idle portion of SCN-8;
- INV-1, INV-2 for a one-member drain, INV-3, INV-7 and INV-8;
- ARCH-1, ARCH-2, ARCH-5 and the formation portion of ARCH-7;
- Compatibility & Migration: additive schema and untouched legacy Prompts.

**Ownership and implementation path**

- Prompt Execution owns Prompt Input admission, source dedupe, immediate batch
  formation and the batch aggregate transaction.
- Primary Session supplies the binding-generation fence and exact source route.
- Conversation Projection receives only the formed execution Prompt and creates
  one Run/Answer projection/outbox intent.
- Extend domain types and Prompt acceptance/dispatch ports before concrete
  SQLite implementation. Keep SQLite rows and Lark payloads outside domain
  policy.
- `BindingPromptWorkflow` routes only eligible normal Feishu ordinary text to
  batch admission. Steering classification and non-Feishu paths remain on their
  existing contracts.
- The batch ID, execution `PromptJob.id`, native submission identity and Run
  projection owner ID are equal. Member source IDs are never used as execution
  owners.
- The formation transaction inserts ordered membership, freezes the formatted
  body, creates the execution Prompt and Run projection, and reserves one
  Answer delivery intent. It must either commit all effects or none.

**Acceptance criteria and verification**

- A settled, generation-current binding accepts one Feishu source message and
  forms one one-member batch without a two-second delay.
- The persisted combined body uses the approved deterministic
  `[Feishu message 1/1]` format and does not expose internal/source IDs.
- Exactly one execution Prompt, Run projection and Answer create intent exist;
  no per-member Run projection exists.
- Re-delivering the same Feishu source identity returns the existing result and
  does not increment queue depth, duplicate membership or reserve another
  outbox entry.
- `MAX_QUEUE_DEPTH` counts the source input, and a full source queue rejects a
  new input without partial rows or delivery effects.
- Closing and reopening SQLite preserves input identity, ordered membership,
  frozen body, batch/execution identity and outbox idempotency.
- New tables reject writes after instance-lease ownership changes.
- Existing legacy queued Prompt, priority, continuation, direct-Herdr and
  steering tests remain unchanged and green.
- Focused verification: new domain/store tests,
  `tests/sqlite-store.test.ts`, `tests/inbound-message-routing-workflow.test.ts`,
  `tests/architecture-boundaries.test.ts`, `npm run typecheck`, and
  `npm run build`.

**Blocked by**

None.

### - [x] T2: Collect active-turn inputs into durable two-second FIFO batches

**What to build**

Extend the T1 admission path so an exact `working` or `blocked` Primary opens a
durable fixed two-second Collection Window instead of forming immediately.
At its deadline, atomically drain at most three FIFO Prompt Inputs into one
frozen batch. Leave overflow unassigned and open a new two-second window after
the prior drain. Recover both pending and expired windows across process
restart, with process-local timers and work hints serving only as accelerators.

**Spec references**

- SCN-2, SCN-3 and SCN-5;
- INV-1, INV-2, INV-3, INV-4 for formation order, INV-6 and INV-7;
- ARCH-2, ARCH-3 and ARCH-5;
- Behavior & Failure Modes: fixed deadline, capped drain, restart and competing
  wake behavior.

**Ownership and implementation path**

- Native Input Batch remains the aggregate root for the collection window,
  selected membership, frozen text and execution-Prompt creation.
- SQLite decides deadline eligibility and one winning drain transaction.
  Coordinator timers never carry authoritative members or state.
- Add a prompt-worker batch-drain path and durable scan hints through the
  existing scheduler/reconciliation style. Per-binding work is serialized;
  different bindings may progress independently.
- The next overflow window begins after the previous batch is formed. Later
  input does not slide or extend an existing deadline.
- Generation changes make the old window ineligible for submission; they do not
  silently move members to a replacement generation.

**Acceptance criteria and verification**

- With fake time, no active-turn batch forms before two seconds and it becomes
  eligible exactly at/after the durable deadline.
- One, two and three messages form one ordered batch; four messages form a
  three-member batch followed by a new one-member window; seven messages
  converge as `3 + 3 + 1` with a new window per drain.
- Member ordinals and frozen combined text preserve source FIFO across batches.
- A transition from active to idle after a window opens does not dissolve the
  window or dispatch it early.
- Duplicate admission and concurrent drain attempts have one durable winner.
- Restart before the deadline waits only the remaining duration; restart after
  the deadline drains immediately without duplicating membership, execution
  Prompt, card intent or batch ID.
- Cross-binding windows do not block one another.
- Backpressure counts every nonterminal source input, including unassigned
  overflow, plus legacy queued ordinary Prompts.
- Focused verification: batch workflow/store tests,
  `tests/concurrency-controls.integration.test.ts`, startup/durable-work scan
  tests, `tests/sqlite-store.test.ts`, `npm run typecheck`, and `npm run build`.

**Blocked by**

T1.

### - [x] T3: Submit formed batches into the active Herdr native queue safely

**What to build**

Dispatch the oldest formed batch through `queuePrompt` while the exact pane is
`working` or `blocked`, without waiting for the current turn to settle. Serialize
one native submission call per binding while allowing several confirmed future
batches to wait inside Herdr/Core. Preserve exact generation, pane, workspace
and Agent-session fences, model selection, submission ordering, exact Core turn
adoption, and the existing no-replay uncertain-effect rule.

This ticket replaces the batching path's single Execution Slot assumption with
the approved Native Submission Slot and Active Turn Slot distinction. It does
not permit parallel Core turn ownership.

**Spec references**

- SCN-2, SCN-6, SCN-7 and SCN-9;
- INV-3, INV-4, INV-5, INV-6 and INV-8;
- ARCH-4, ARCH-5 and ARCH-6;
- Behavior & Failure Modes: pre-effect rejection, uncertain effect, identity
  mismatch and exact observation.

**Ownership and implementation path**

- Prompt Execution owns oldest-batch eligibility, the Native Submission Slot,
  durable attempt fence and submission outcome classification.
- Herdr remains authoritative for pane/session identity and owns native queue
  transport. Reuse the existing adapter signature and redacted command runner.
- `PrimaryPromptDispatcher` claims a formed execution Prompt/batch, passes only
  the persisted frozen body and shared ID, and returns after persisting receipt
  or uncertainty. It never reconstructs combined text.
- The SQLite transition before the external call must distinguish work proven
  not to have started from a call that may have crossed the boundary.
- Confirmed `not_started`/rejected outcomes may retry the same batch and ID;
  timeouts, disconnects, mismatched receipts and stale receipt fences detach
  without replay.
- Existing exact Core submission evidence adopts each batch's later turn. FIFO
  order is not accepted as ownership evidence.
- A pending binding model preference pins once to the batch execution Prompt
  and retains the existing fail-closed model queue contract.

**Acceptance criteria and verification**

- Exact `working` and `blocked` panes call `queuePrompt` after the batch deadline
  with the frozen combined text, batch submission ID and expected session ID.
- Unknown/missing pane, workspace change, generation change, session mismatch
  or missing exact session for active runtime performs no native call.
- Two or more formed batches submit in batch FIFO order with at most one
  external call in flight; confirmed native-queued batches do not masquerade as
  parallel running turns.
- A confirmed rejection retries the same frozen batch without re-forming it or
  duplicating its card. An uncertain call is persisted detached and is never
  automatically invoked again after worker/service restart.
- A receipt identity mismatch is uncertain and retains the authoritative batch
  ID.
- Exact Core events for multiple queued submissions associate each later turn
  and Answer only with its matching batch ID.
- Settled first-session bootstrap and legacy single-Prompt dispatch remain
  compatible.
- Explicit steering is classified before admission and never appears as a batch
  member.
- Focused verification: `tests/primary-prompt-dispatcher.test.ts`,
  `tests/concurrency-controls.integration.test.ts`,
  `tests/herdr-adapter.test.ts`, Core-event/detached-recovery integration tests,
  model-selection tests, `npm run typecheck`, and `npm run build`.

**Blocked by**

T2.

### - [x] T4: Converge Main/Answer presentation and operational state for batches

**What to build**

Complete the user-visible and operational slice. Project collection backlog,
formed/native-queued batch work and the exact active turn into the Primary Main
Card through durable events, reducers and outbox intents. Preserve one shared
Run/Answer Card per batch, presentation-only retry/redelivery, accurate status
and restart-safety summaries, and implementation-backed domain/architecture and
Feishu usage documentation.

**Spec references**

- SCN-5, SCN-8 and SCN-9;
- INV-3, INV-4, INV-5, INV-7 and INV-8;
- ARCH-3, ARCH-6 and ARCH-7;
- Compatibility & Migration and all documentation changes named there.

**Ownership and implementation path**

- Prompt Execution emits durable facts/counts; Conversation Projection reduces
  them into Topic and Run views; Delivery and Operations owns only outbox
  publication and checkpoints.
- Main projection distinguishes unbatched source-message backlog from formed or
  native-queued batches and the exact active turn. It does not infer state from
  Lark delivery.
- Answer outbox idempotency remains keyed by the shared execution Prompt ID and
  view version. Member inputs never reserve Answer work.
- Operational prompt summaries and restart safety account for collecting
  inputs, formed work, native-queued future batches and the exact active turn
  without counting future batches as parallel running turns.
- Update Prompt Execution and Primary Session context language for Prompt Input,
  Native Input Batch, Native Submission Slot, Active Turn Slot and the approved
  identity equality. Update architecture and Feishu usage docs to match actual
  implementation and retain the no-replay/local-approval boundaries.

**Acceptance criteria and verification**

- Admission, window formation, batch formation, native acceptance and exact
  turn settlement each cause the required Main projection convergence.
- Main Card renders source-message backlog and formed/native-queued batch count
  without showing stale per-member run state.
- Each batch has exactly one Run/Answer Card across duplicate ingress, process
  restart, outbox retry and `/swarm awake` redelivery; no member has a card.
- Lark delivery failure or redelivery does not alter collection, membership,
  submission eligibility or detached recovery.
- `/status` and restart-safety summaries expose accurate bounded counts and do
  not treat native-queued future batches as concurrent active turns.
- Startup recovery wakes expired windows and presentation convergence without
  repeating native effects.
- Documentation uses the context-map terms and states the two-second, max-three,
  fixed-window and no-replay contracts.
- Focused verification: Main/Run/Answer projection tests,
  `tests/primary-card-redelivery-workflow.test.ts`, startup convergence,
  health/status/restart-safety tests, docs audits,
  `tests/architecture-boundaries.test.ts`, `npm run typecheck`, and
  `npm run build`.

**Blocked by**

T3.

## Delivery review repairs

- [x] Persist the exact native-submission attempt fence before calling Herdr/Core; restore only a confirmed pre-effect rejection and never replay a possibly-started call.
- [x] Require the live Pane's exact Agent-session identity for native submission while preserving first-session idle bootstrap.
- [x] Preserve an opened fixed Collection Window after the Primary settles.
- [x] Count recovering batch members in source-message backpressure while retaining terminal `uncertain` semantics.
- [x] Fail closed when the new Native Input restart-safety metrics are absent.
- [x] Keep persistence inspection helpers off the workflow-facing Prompt acceptance port.

Repair verification on 2026-10-02:

- focused Red: 6 intended failures across dispatch fencing, live-session identity, fixed-window admission, recovering backpressure, and restart metrics;
- affected Green: 4 files and 505 tests passed;
- `npm run typecheck`: passed;
- `npm run build`: passed.

## Final Delivery Checks

After all tickets are complete and independently committed:

1. Review the complete diff and ticket/spec traceability in both directions.
2. Run `npm run typecheck`.
3. Run `npm run build`.
4. Run `npm test` serially after build completion; do not run it concurrently
   with build because installer tests read the atomically replaced `dist` tree.
5. Confirm `git status --short --branch`, commit boundaries and absence of
   `Trae CLI co-author attribution` in every new unpushed commit.
6. Report the immutable worktree/branch/commit range and deployment validation
   targets. Do not install, restart, deploy, push, publish tickets, open a PR or
   alter production SQLite without separate explicit authorization.
