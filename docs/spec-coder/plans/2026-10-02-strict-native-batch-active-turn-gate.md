# Strict Native Batch Active-Turn Gate Plan

Specification: [Strict Native Batch Active-Turn Gate](../specs/2026-10-02-strict-native-batch-active-turn-gate.md)

Workspace: `/workspace/herdr-agent-swarm/.trae/worktrees/fix_active_turn_batch_gate`

Branch: `worktree-fix_active_turn_batch_gate`

Starting revision: `87a8edf5027bb6e612ab59bdfc4e8b8cc79f8ff7`

Baseline on 2026-10-02:

- `npm ci`: passed, with one pre-existing high-severity audit advisory;
- `npm run build`: passed;
- `npm run typecheck`: passed;
- serial `npm test`: 251 files and 3,593 tests passed.

Approval status:

- Gate 1 corrective design: approved 2026-10-02;
- Gate 2 specification: approved 2026-10-02;
- Gate 3 tickets and implementation authorization: approved 2026-10-02.

## Tickets

### - [x] T1: Keep every successor batch behind the durable and live execution gate

**What to build**

Make formed Native Input Batches obey the same binding-scoped Ordinary
Execution Slot as every other ordinary Prompt. The transactional dispatch claim
must keep a successor queued while any same-binding Prompt is `submitted`,
`running`, `recovering`, or `uncertain`, and must require the persisted Agent
state to be `idle` or `done`. After a successful claim, the dispatcher must
freshly confirm the exact Pane, workspace and Agent session and refuse every
ordinary submission, including a batch, unless the live state is `idle` or
`done`.

This ticket is a complete safety increment: even if a duplicate or legacy wake
attempts to drain a formed batch, it cannot cross the Herdr submission boundary
beside a current or possibly current execution owner.

**Spec references**

- SCN-3, SCN-4 and SCN-5;
- INV-1, INV-2, INV-3 and INV-4;
- ARCH-2 and ARCH-3;
- Behavior & Failure Modes: atomic one-winner claim, pre-effect release, stale
  persisted observation, detached/uncertain blocking and no replay.

**Ownership and implementation path**

- Prompt Execution owns the binding-scoped execution-slot rule and Prompt
  lifecycle evidence. SQLite remains authoritative for claim eligibility and
  performs selection plus `queued -> submitted` in one transaction.
- Tighten `SqlitePromptDispatchStore.claimNextDispatchablePrompt` so
  `nativeInputBatchOnly` is only a candidate selector. It must not bypass the
  persisted `idle | done` requirement or the blocker predicate covering
  `submitted | running | recovering | uncertain`.
- Preserve oldest-formed-batch FIFO, generation/session fences, exact batch
  identity, the frozen execution body and the existing competing-claim winner.
- `PrimaryPromptDispatcher` keeps using the domain-owned Herdr port and existing
  runtime-identity check. Remove the Native Input Batch exception for
  `working | blocked`; missing, unknown or changed runtime evidence remains a
  refusal.
- A refusal before the external call uses the existing exact release fence to
  restore only the still-unstarted Prompt to `queued/not_started`. A stale
  release loses safely. Receipt handling and every possibly-delivered outcome
  remain on the existing detached/uncertain path.
- Do not change Herdr Core, the Herdr adapter signature, Prompt states, schema,
  batch membership, cards or production data.

**Acceptance criteria and verification**

- A formed batch cannot be claimed when the binding's persisted Agent state is
  `working`, `blocked`, `unknown` or absent; it becomes claimable only after
  `idle | done` is durably observed.
- A same-binding predecessor in each of `submitted`, `running`, `recovering`
  and `uncertain` blocks the formed successor, including when the binding row
  says `idle`; terminal predecessors do not block the oldest formed successor.
- Duplicate or competing claims after eligibility has one winner and cannot
  overtake the oldest formed batch.
- If the runtime becomes `working` or `blocked` after claim, `queuePrompt` and
  `queueModelPrompt` are not called, the exact unstarted claim is released, and
  receipt/dispatch evidence is not fabricated.
- Missing Pane, unknown state, workspace/session mismatch and observation
  failure retain the existing fail-closed pre-effect behavior.
- Accepted, uncertain, timed-out-after-call and mismatched-receipt cases remain
  detached or uncertain and are never automatically requeued or replayed.
- Red-Green seams: SQLite dispatch tests in `tests/sqlite-store.test.ts` and
  dispatcher tests in `tests/primary-prompt-dispatcher.test.ts`.
- Affected verification: the two focused files above, relevant detached/native
  receipt recovery tests, `npm run typecheck`, and `npm run build`.

**Blocked by**

None.

**Completion evidence — 2026-10-02**

- Red: all four nonterminal predecessor states returned and claimed the formed
  successor; persisted `working | blocked` also claimed it; fresh
  `working | blocked` Pane evidence did not release the claimed batch.
- Green: blocker and persisted-state focused tests passed 6/6; fresh-Pane
  preflight tests passed 2/2.
- Affected verification: `tests/sqlite-store.test.ts` plus
  `tests/primary-prompt-dispatcher.test.ts` passed 493/493; Core-event,
  detached-recovery and prompt-safety tests passed 48/48; `npm run typecheck`
  and `npm run build` passed.
- Compatibility review: historical multiple-receipt fixtures no longer use
  dispatch claim to manufacture invalid concurrency, while their exact
  recovery/adoption behavior remains covered and green.

### - [x] T2: Run active-turn batching through one workflow worker and one later submission

**What to build**

Remove the process-local path that starts a parallel native-submission
dispatcher when `prompt-ready` arrives beside an existing binding worker.
Active-turn input must still be admitted, reconciled at its durable deadline,
formed into its immutable batch and scheduled for another wake, but no Herdr
call occurs until the existing execution owner settles. The ordinary worker
path then submits the oldest eligible formed batch exactly once through T1's
durable and live gates.

Complete the observable correction by updating current architecture, Prompt
Execution domain and Feishu operator documentation. Preserve public diagnostics
and compatibility fields while removing any claim that Herdr/Core provides a
semantic future-turn queue.

**Spec references**

- SCN-1, SCN-2 and SCN-6, with the end-to-end protection from SCN-3 through
  SCN-5;
- INV-1 through INV-5;
- ARCH-1, ARCH-4 and ARCH-5, consuming the ARCH-2/ARCH-3 gates delivered by T1;
- Compatibility & Migration and all approved documentation corrections.

**Ownership and implementation path**

- `PromptRunWorkflow` remains the coordinator for durable batch reconciliation,
  collection deadlines and ordinary worker scheduling. Process-local workers,
  timers and wake hints remain accelerators only.
- On `prompt-ready` beside an existing binding worker, reconcile the due Native
  Input Batch and schedule its next durable deadline without calling
  `PrimaryPromptDispatcher.drain` through a second worker.
- Remove the separate native-submission worker as a scheduling capability.
  Preserve the existing public diagnostics/restart-safety shape; its compatible
  native-submission-worker count reports no parallel workers rather than
  deleting the field.
- Ensure ordinary worker settlement and existing scheduler hints make the
  oldest formed batch eligible for the normal worker path without a busy loop,
  lost wake or in-memory ownership requirement.
- Preserve the approved fixed two-second window, max-three FIFO formation,
  immutable body, batch/Prompt identity, source backpressure, one Run/Answer
  projection, model selection, exact observation and steering separation.
- Correct `docs/architecture.md`,
  `docs/domain/prompt-execution/CONTEXT.md` and
  `docs/feishu-group-usage.md`. Historical completed specifications and plans
  remain unchanged as evidence of the invalidated assumption.

**Acceptance criteria and verification**

- While Prompt A is active, later ordinary Feishu inputs form their normal
  durable batch after the fixed window, but neither native submission method is
  called and no second dispatcher is active.
- After A reaches a terminal Prompt state and the exact Pane becomes
  `idle | done`, the normal wake path submits B exactly once with its original
  frozen body, Prompt/batch submission ID and Agent-session fence.
- Several wake hints, timer reconciliation and worker settlement cannot produce
  duplicate calls, reorder batches or lose the eligible successor.
- A detached or uncertain A continues to block B until existing exact recovery
  or creator-authorized `/swarm skip` terminalizes the blocker.
- The workflow diagnostic/restart-safety contract remains wire-compatible and
  reports zero parallel native-submission workers.
- Existing batching, restart recovery, no-replay receipts, source
  backpressure, steering, model selection and Run/Answer/Main projection tests
  remain green.
- Current documentation defines one Ordinary Execution Slot, treats
  `queuePrompt` as receipt-bearing native submission/PTY serialization, and
  identifies SQLite plus fresh Herdr observation as the dispatch authority.
- Red-Green seam: `tests/concurrency-controls.integration.test.ts` proves the
  active-collect/no-submit/settle/submit sequence; focused workflow and
  restart-safety tests cover worker scheduling and diagnostics.
- Affected verification: concurrency controls, prompt workflow/safety scan,
  restart-safety, architecture-boundary and documentation-relevant tests,
  `npm run typecheck`, and `npm run build`.

**Blocked by**

T1.

**Completion evidence — 2026-10-02**

- Red: while an ordinary recovery worker owned the Binding, a `prompt-ready`
  wake reported one parallel `nativeSubmissionWorkers` worker on the old path.
- Green: active-turn input reconciliation reports zero parallel native
  submission workers; the end-to-end concurrency seam forms B beside active A,
  performs no Herdr call, then submits B exactly once with its frozen body and
  exact session fence after A settles and the Pane becomes idle.
- Affected verification: concurrency controls, PromptRun safety scan, Prompt
  admission, Primary/Worker flow, restart-safety and architecture-boundary
  suites passed 192/192; `npm run typecheck` and `npm run build` passed.
- Documentation review: current architecture, Prompt Execution domain language
  and Feishu operator guidance now define one Ordinary Execution Slot and
  describe Core acceptance as a no-replay PTY boundary rather than future-turn
  ownership. Historical specifications and plans remain unchanged.

## Final delivery checks

- [x] Map SCN-1 through SCN-6 and INV-1 through INV-5 to passing test evidence and
  completed ticket commits.
- [x] Review the complete diff against ARCH-1 through ARCH-5 and confirm no path can
  bypass the store claim or fresh live preflight.
- [x] Confirm the repository contains no Herdr Core change, schema migration, live
  database rewrite, Prompt replay or historical-artifact rewrite.
- [x] Run focused and affected checks, then fresh sequential `npm run typecheck`,
  `npm run build` and `npm test` before delivery claims.
- [x] Create one path-scoped Conventional Commit per completed ticket. Do not
  install, activate, restart, deploy, push, open a PR or drop the separate
  `herdr-core` backup stash without separate authorization.

### Delivery evidence — 2026-10-02

- Ticket commits: `0504de50` enforces the durable execution slot and live gate;
  `4fee83c3` serializes batch reconciliation and submission through one worker.
- Review repairs: `6993876c` refuses Native Input Batches without exact live
  session identity; `019dec2a` preserves a wake when reconciliation outlives
  its worker; `6ca76b96` makes explicit skip terminally release recovering or
  uncertain blockers; `fdfc06e2` preserves exact late Core recovery without
  reacquiring the released slot. `26b6b7ff` aligns historical test fixtures
  without weakening production claims.
- Fresh final verification passed: 251/251 Vitest files and 3,602/3,602 tests,
  `npm run typecheck`, and `npm run build` with build identity
  `sha256:6b812b52410668c7c40971aea56f33b42a94fee40a5ed8f6978d4c4f58a5e424`.
- Delivery review found no remaining Standards or Spec defects. The final diff
  changes only Swarm source, tests, current documentation and spec-coder
  evidence; no service install/restart, deployment, push, PR, live database
  mutation or Herdr Core stash change was performed.
