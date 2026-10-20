# Detached Submission Lifecycle and Turn Recovery

## Problem Statement

A Feishu-originated Primary Prompt can cross the Agent boundary and acquire
durable Dispatch Evidence while Swarm still lacks its exact Core turn identity.
The current `running` state conflates three different facts: accepted by the
Herdr/Core native queue, actively executing with an exact Transcript Identity,
and detached with an execution result that cannot yet be proven. This makes an
identity-less historical Prompt appear active, count against restart safety,
and keep an Answer Card in an indefinite executing state even though later work
can safely progress without replaying it.

The live split-frame ownership defect is a related but narrower problem. Core
can deliver `turn_started`, an exact `human_message.submission_id`, final Agent
output, and `turn_completed` in separate frames. If the canonical start is not
retained across those frames, the managed Prompt remains identity-less despite
the exact submission evidence. Commit `45a201ce` implements the first approved
slice of that repair by restoring the settled canonical start before projecting
the later frame. Historical exact completed turns still require bounded fenced
repair, which is represented by the concurrent task-owned working changes
present when this revision was written.

Current behavior preserves the critical no-replay invariant, but it does not
give scheduling, restart safety, operational metrics, and cards one canonical
answer to whether a detached Prompt still occupies the execution slot.

## Solution

Make Prompt lifecycle state explicit:

- `queued`: accepted by Swarm but not submitted to the Agent boundary;
- `submitted`: accepted by Herdr/Core with durable Dispatch Evidence but not
  yet bound to an exact turn;
- `running`: owns an exact session, turn ID, and canonical start;
- `recovering`: detached after dispatch without an exact turn identity;
- `uncertain`: terminal because bounded recovery cannot prove success or
  failure;
- existing `delivered`, `failed`, and `cancelled` terminal outcomes.

`observation_state` remains the supervision mode in this change. An exact-owned
`running/detached` Prompt still occupies the one execution slot. A
`recovering/detached` Prompt does not occupy that slot, block later native
queue/FIFO progress, or block restart solely because it exists. Dispatch
Evidence permanently prevents replay in both cases.

Prompt Execution owns these meanings and persists every transition atomically.
Conversation Projection maps lifecycle facts to Run and Answer views without
deciding ownership. Delivery and Operations reports separate submitted, active,
recovering, and uncertain counts and applies restart safety to their approved
semantics. Strict persisted Core evidence may repair either `recovering` or
`uncertain` without submitting Prompt text again.

## User Stories

- **SCN-1 — Exact live adoption:** When a submitted managed Prompt later emits
  a matching `human_message.submission_id`, it claims that exact turn and its
  Answer completes even if older recovering Prompts exist.
- **SCN-2 — Non-blocking recovery backlog:** An identity-less recovering Prompt
  cannot block later admission, native queueing, exact turn ownership, Answer
  projection, or FIFO progress.
- **SCN-3 — Split-frame delivery:** Separate `turn_started`, Human Message,
  final Agent Message, and terminal frames produce the same completed Prompt
  and Answer as one combined observation.
- **SCN-4 — Safe historical repair:** Already-settled Core evidence can repair
  a recovering or uncertain Prompt only when one exact fenced turn and one
  unambiguous terminal exist. Recovery never resubmits input and is idempotent.
- **SCN-5 — Fail closed:** Missing, conflicting, or cross-generation identity
  does not consume another turn's output and does not fabricate success or
  failure.
- **SCN-6 — Exact detached work stays active:** Losing the process-local
  observer after exact turn ownership keeps the Prompt `running/detached`,
  preserves its execution slot, and continues to block unsafe concurrent direct
  execution and ordinary restart.
- **SCN-7 — Bounded uncertain outcome:** An identity-less recovering Prompt
  enters `uncertain` only after the same binding generation, pane, and native
  session are freshly `idle/done` and either the configured maximum wait or the
  durable three-observation policy is exhausted. `working`, `blocked`, changed
  identity, and transient Core failure do not consume the observation budget.
- **SCN-8 — Honest card semantics:** Submitted, running, recovering, uncertain,
  and proven failure have distinct user-visible labels. Historical recovering
  work does not make the Main Card claim that the current session is executing
  it.
- **SCN-9 — Restart safety:** Queued, submitted/attached, exact-running work,
  active workers, and applicable delivery work retain their existing restart
  protection. Recovering and uncertain records do not independently block a
  restart.
- **SCN-10 — Safe migration:** Existing nonterminal rows are classified from
  durable identity evidence without replay. Historical terminal `failed` rows
  are not bulk rewritten.
- **SCN-11 — Late proof after uncertainty:** Strict Core evidence may correct an
  uncertain outcome to delivered or failed. A frozen uncertain Answer Card is
  not patched; one idempotent recovery continuation records the correction.

## Implementation Decisions

### Domain Model

The affected bounded contexts remain Prompt Execution, Conversation Projection,
Delivery and Operations, with Primary Session supplying binding generation,
pane, and native-session fences.

Prompt Execution owns the `PromptJob` lifecycle, Dispatch Evidence, Transcript
Identity, the per-binding **Execution Slot**, and **Recovery Backlog**. A
Submitted Prompt has crossed the no-replay boundary but has not acquired the
Execution Slot. A Running Prompt owns an exact turn and therefore owns the slot,
including while observed in detached mode. A Recovering Prompt has durable
dispatch evidence but no exact turn identity and belongs to the non-blocking
Recovery Backlog. **Uncertain Outcome** means that bounded recovery ended without
proof of success or failure; it is not equivalent to failed execution.

Conversation Projection owns only the user-visible Topic, Run, Answer Page, and
recovery-continuation read models. Delivery and Operations owns delivery intent,
restart diagnostics, and operational degradation, but does not infer execution
ownership from card or transport state.

- **INV-1 — Exact managed identity:** `prompt.id == native_submission_id ==
  human_message.submission_id` is the only managed-submission identity. Text,
  time proximity, FIFO position, receipt turn hints, and newest-turn order are
  never fallback identity.
- **INV-2 — Runtime fences:** Binding generation, pane, native session, turn ID,
  and canonical start must match before assigning or repairing turn ownership.
- **INV-3 — No replay after dispatch:** Any durable Dispatch Evidence permanently
  forbids automatic resubmission, regardless of submitted, running, recovering,
  or uncertain state.
- **INV-4 — Recovery is non-blocking:** Recovering and uncertain Prompts do not
  occupy the Execution Slot or block later proven work.
- **INV-5 — One exact owner:** One exact turn has at most one Prompt owner;
  duplicate observations are idempotent and conflicting ownership fails closed.
- **INV-6 — Atomic lifecycle effects:** Prompt lifecycle change, Run Projection,
  audit evidence, and outbound reservation commit in one SQLite transaction.
  Lark delivery remains asynchronous.
- **INV-7 — One execution slot:** One binding has at most one exact `running`
  ordinary turn. Exact-owned detached work retains that slot; submitted and
  recovering work do not.
- **INV-8 — Honest terminal outcomes:** `failed` requires canonical failure or a
  pre-dispatch rejection. Exhausted identity-less recovery produces `uncertain`.
  Late repair requires exact durable evidence and cannot patch frozen Answer
  history.

No new aggregate or external protocol is introduced. `PromptJob` remains the
aggregate root for execution lifecycle; Run and Topic models remain projections.

### Architecture

- **ARCH-1 — Lifecycle authority:** A Prompt Execution domain module defines the
  allowed lifecycle transitions and capability predicates. Store workflows use
  explicit operations such as submit, exact-turn claim, detach, bounded
  uncertainty, and exact repair instead of a generic arbitrary state update.
- **ARCH-2 — Atomic SQLite adapter:** SQLite performs transition compare-and-set,
  binding/session fencing, uniqueness enforcement, projection changes, audit,
  and outbox reservation in one transaction. Concurrent recovery and Core-event
  adoption race through the same persisted preconditions; one wins and the
  loser returns stale/idempotent without external effects.
- **ARCH-3 — Observation coordination:** Core-event observation retains or
  recovers canonical `turn_started` evidence across split frames and attempts
  exact submission adoption before ambiguous active-Prompt heuristics.
  Historical recovery reads normalized durable Core events and never rewinds a
  generic lane checkpoint or calls the Herdr submission interface.
- **ARCH-4 — Passive projections:** Conversation reducers receive submitted,
  running, recovering, uncertain, repaired, completed, and failed lifecycle
  facts. They never query Lark or derive Prompt ownership from visible cards.
- **ARCH-5 — Operational consumers:** Health/status and restart evaluation
  consume lifecycle-specific counts. Readiness still reflects service
  dependencies; an over-age Recovery Backlog degrades operational status without
  making dependency readiness false.
- **ARCH-6 — Dependency direction:** Coordinators and runtime modules depend on
  domain-owned prompt/recovery interfaces; SQLite and Herdr satisfy those
  interfaces; composition remains in `src/main.ts`. No domain/application module
  imports Lark SDK representations.

The public Prompt workflow remains a deep module. Callers request admission,
dispatch, observation, recovery, or control; they do not learn the SQL predicates
that distinguish submitted, exact-running, recovering, and uncertain work.

### Behavior & Failure Modes

The canonical transitions are:

```text
queued -> submitted -> running -> delivered | failed
                    \-> recovering -> delivered | failed | uncertain
running/attached -> running/detached -> delivered | failed
uncertain -> delivered | failed       (strict persisted repair only)
```

Native queue submission moves a Prompt to `submitted` atomically with Dispatch
Evidence. Exact Core identity moves `submitted` or `recovering` to `running`.
Observer loss moves identity-less submitted work to `recovering`; observer loss
does not remove an exact running owner's slot.

The direct/PTY dispatcher still requires a fresh `idle/done` pane when native
queueing is unavailable. Releasing the logical slot from an identity-less row
never authorizes writing into a working or blocked terminal.

Bounded recovery uses the existing durable attempt schedule. It operates only
on the oldest eligible recovering Prompt under the exact binding/pane/session
fence. Repeated scans before the next due time are no-ops. Once the maximum wait
or third due observation is reached while the pane is freshly `idle/done`, the
same transaction records `uncertain`, updates the Run Projection, reserves the
terminal card effect, deletes attempt state, and writes audit evidence.

`/swarm skip` performs the same uncertain terminal transition with creator and
generation fencing. It stops Swarm from waiting; it does not claim that TraeX
failed or terminate/replay the native turn.

Late repair of uncertain work changes the durable execution result only when
Core evidence is exact and unambiguous. Because terminal Answer pages are frozen,
repair reserves one idempotent CardKit continuation rather than mutating the
uncertain page. Duplicate scans observe the repaired terminal and emit nothing.

Operational status exposes queued, submitted, exact running, recovering, and
uncertain counts plus the oldest recovering age. Restart safety preserves all
existing non-Prompt gates and blocks queued, submitted/attached, and exact
running work, but not recovering or uncertain records by themselves.

### Compatibility & Migration

This design requires a SQLite schema migration and replaces the previous
assumption that no schema change was necessary. Prompt state checks and domain
types gain `submitted`, `recovering`, and `uncertain`; Run Projection phases gain
the corresponding visible phases while preserving `blocked`, completed, failed,
and existing CardKit page rules.

Migration classifies existing nonterminal rows from durable evidence:

- exact `transcript_turn_id` plus canonical start remains `running`;
- identity-less attached work with Dispatch Evidence becomes `submitted`;
- identity-less detached work with Dispatch Evidence becomes `recovering`;
- genuinely undispatched work remains `queued`;
- existing terminal delivered, failed, and cancelled rows remain unchanged.

Startup convergence renders changed active/recovering projections through the
normal outbox. It does not edit live SQLite ad hoc or replay Prompt input.
Historical auto-skip failures are not bulk converted. They may be repaired only
through the same exact fenced recovery path when qualifying durable evidence is
explicitly found.

The implemented split-frame restoration in `45a201ce` and the concurrent
historical-repair work remain valid prerequisites. The lifecycle migration must
adapt their preconditions from identity-less `running/detached` to
`recovering/detached` without weakening exact identity checks.

### Approved Answer Task List title extension

The latest structured Core `statusTitle` is part of the durable Run Projection
as `taskListTitle`. Conversation Projection updates it independently from
`planSteps`; a missing title leaves the prior title unchanged, while an explicit
null clears it. The title never becomes a synthetic plan item and does not alter
plan keys, states, ordering, or identity.

Answer cards render a non-empty title as `Task List · <statusTitle>` only when
the native Task List is present. Card rendering collapses whitespace and bounds
the plain-text title to 96 characters. SQLite migration v71 adds the nullable
column additively, preserving existing rows as null and rebuilding the Run Card
view without inferring a title from ANSI frames or terminal text.

## Testing Decisions

- **SCN-1/SCN-3, INV-1/INV-2/INV-5:** feed one Core event per cursor observation
  with older recovering rows present; assert the exact submission claims one
  turn, final Answer is preserved, and duplicates or mismatches produce no
  cross-attribution.
- **SCN-2/SCN-6/SCN-9, INV-4/INV-7:** integration-test dispatch and restart
  evaluation with recovering, submitted, exact-running attached, and
  exact-running detached rows. Verify only the approved states occupy the slot
  or independently block restart.
- **SCN-4/SCN-11, INV-3/INV-6/INV-8:** seed settled exact Core evidence, run
  recovery more than once, and assert one terminal transition, one recovery
  continuation effect, no Herdr submission, and no frozen-card mutation.
- **SCN-7:** test idle/done eligibility, configured expiry, three durable due
  attempts, restart persistence, working/blocked non-consumption, changed fences,
  and transient Core failures.
- **SCN-8:** reducer and card tests distinguish submitted, running, recovering,
  uncertain, proven failure, and late repaired continuation. Topic selection
  excludes historical recovering work from the active execution heading.
- **SCN-10:** migration tests cover every old nonterminal identity combination,
  idempotent reopen, integrity checks, preserved historical terminal rows, and
  startup outbox convergence.
- **Answer Task List title extension:** reducer tests cover independent title
  updates and duplicate suppression; event projection tests preserve native plan
  identity; SQLite tests cover v71 migration and reopen persistence; card tests
  cover the bounded heading.
- Verify lifecycle transitions through Prompt workflow/store interfaces, not by
  testing private SQL helpers alone. Use service-lifecycle and health snapshot
  seams for restart/readiness/operational assertions, and existing Run/Card
  reducers for visible semantics.
- Run affected observer, SQLite, recovery, dispatcher, service lifecycle, health,
  Run Projection, and card suites for each ticket. Run `npm run typecheck` and
  `npm run build` before every ticket commit. Run the full Vitest suite plus
  architecture checks before delivery.
- Separately inspect imports and composition to verify ARCH-6; green behavior
  tests alone do not prove dependency direction.

## Out of Scope

- Replaying any Prompt or reconstructing ownership from terminal screen text.
- Changing the Herdr Core event schema or native queue ordering contract.
- General cleanup of unrelated dead letters, quarantines, projection gaps, or
  historical failed rows.
- Removing `observation_state` or redesigning Worker-turn lifecycle in the same
  change.
- Automatically rewriting frozen historical Lark cards.
- Installing, restarting, repairing production rows, pushing, or opening a PR as
  part of specification approval.

## Further Notes

- Workspace mode: in place on branch `main`.
- Current planning revision: `45a201ce1f41dae8422500e16925587472ae27ba`.
- Reason: tracked files were clean when planning began and this specification is
  task-owned. During planning, a concurrent implementation completed and
  committed T1, then began uncommitted T2 changes. This specification update is
  path-disjoint from those source edits; all `.tmp-*`, `.trae/`, and `handoff.md`
  paths remain untouched.
- Initial concurrent changes at Gate 2 baseline:
  `src/coordinator/prompt-run-workflow.ts`, `src/domain/ports/prompt-run.ts`,
  `src/domain/ports/prompt.ts`, `src/store/sqlite/prompt-capability-store.ts`,
  `src/store/sqlite/prompt-recovery-store.ts`,
  `tests/helpers/sqlite-store-kernel.ts`, and
  `tests/detached-core-recovery.integration.test.ts`.
- Fresh baseline on that exact working snapshot:
  `npx vitest run tests/detached-core-recovery.integration.test.ts
  tests/external-turn-observer.test.ts tests/sqlite-store.test.ts --reporter=dot`
  passed 3 files and 441 tests; `npm run typecheck` passed; `npm run build`
  passed and generated build identity
  `sha256:7b5a9a821279575ac69b0e3267e4b8d1212193b8326e228a01d554a332d8581b`.
- An earlier broader baseline before the concurrent T2 edits passed 8 files and
  719 tests. The first typecheck/build attempt during the partial edit failed on
  the temporarily missing `ProjectedBridgeTurnRecoveryResult` export; the owner
  completed that cross-file seam before the successful baseline above.
- Gate 1 lifecycle design: approved by the user on 2026-10-01.
- Gate 2 revised specification: approved by the user on 2026-10-01.
- Gate 3 ticket set and implementation authorization: approved by the user on
  2026-10-01; the Answer Task List title extension was separately approved the
  same day.
