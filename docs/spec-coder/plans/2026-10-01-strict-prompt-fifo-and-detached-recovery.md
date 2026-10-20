# Strict Prompt FIFO and Detached Recovery Plan

Specification:
[`docs/spec-coder/specs/2026-10-01-strict-prompt-fifo-and-detached-recovery.md`](../specs/2026-10-01-strict-prompt-fifo-and-detached-recovery.md)

Workspace: in place on `main`, starting at
`55cf73104f072bab4d6bd4bc5724c9bc0d553332`. The checkout had no staged or
tracked modifications. Preserve the pre-existing untracked paths
`.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
`docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
`handoff.md`.

Baseline on 2026-10-01:

- `npm run typecheck` passed;
- `npm run build` passed;
- `npm test` passed: 235 files, 3,234 tests.

Run full tests and build sequentially because `npm run build` atomically
replaces `dist/`, while installer tests read `dist/build-info.json`.

Approval status: Gate 1 design, Gate 2 specification, and Gate 3 ticket set
approved. Implementation authorized.

## Tickets

### - [x] T1: Serialize ordinary Prompt submission into distinct turns

**What to build**

Make SQLite FIFO eligibility authoritative for ordinary Prompt dispatch. A
`working`, `blocked`, or `unknown` pane must leave ordinary messages queued. An
`idle` or `done` pane may submit only the FIFO head, and a successful or
possibly-successful native submission ends that drain so no second Prompt can
race ahead of runtime state propagation. Require post-submission activity
acknowledgement from the Herdr adapter. Preserve explicit steering as the only
active-turn injection path.

**Spec references**

- SCN-1, SCN-2, SCN-3
- INV-1, INV-2, INV-3
- ARCH-1, ARCH-2, ARCH-3

**Ownership and implementation path**

- Prompt Execution owns the ordinary FIFO and execution slot.
- Tighten the domain-owned `PromptDispatchStore` interface so native capability
  cannot alter dispatch eligibility.
- Make the SQLite dispatch store atomically claim only settled bindings with no
  submitted/running ordinary Prompt; recovering history remains outside the
  slot predicate.
- Simplify `PromptRunWorkflow` scheduling so a new ordinary Prompt does not
  create a concurrent native queue worker while an existing binding worker is
  active.
- Make `PrimaryPromptDispatcher` submit at most one native Prompt per drain and
  preserve pre-dispatch release versus possibly-dispatched detach behavior.
- Keep Herdr CLI argument/result translation in the adapter and require observed
  `working` or `blocked` activity for a native submission that begins from a
  settled state. No raw CLI response enters coordinator policy.

**Acceptance criteria and verification**

- A message admitted while the pane is `working` remains `queued/not_started`;
  neither ordinary nor model-native submission is called.
- Two messages admitted during one active turn remain FIFO ordered and are not
  injected into that turn.
- After the pane settles, one drain submits only the FIFO head; the next item
  waits for a later wake/settlement.
- A pre-dispatch rejection releases the claim; a timeout or stalled activity
  after possible terminal input detaches without replay.
- Exact runtime identity fencing remains enforced.
- `/swarm steer` integration tests remain green.
- Red-Green tests: `tests/primary-prompt-dispatcher.test.ts`,
  `tests/concurrency-controls.integration.test.ts`, and
  `tests/herdr-adapter.test.ts`.
- Affected verification: those files, steering integration tests,
  `npm run typecheck`, and `npm run build`.
- Dependency evidence: coordinator imports only domain ports; CLI flags and JSON
  parsing stay in `src/adapters/herdr-adapter.ts`.

**Blocked by:** None.

**Implementation evidence (2026-10-01)**

- Removed native queue eligibility overrides from the domain/store contract.
- Working, blocked, and unknown bindings leave ordinary work queued; one settled
  drain claims and submits at most one Prompt.
- Native submissions wait for observed `working` or `blocked` activity.
- Removed the parallel native queue worker from `PromptRunWorkflow`.
- Focused and affected tests passed; full `npm test` passed with 235 files and
  3,234 tests. `npm run typecheck` and `npm run build` passed sequentially.

### - [x] T2: Converge conflicting and receipt-less detached Prompts safely

**What to build**

Recognize when a detached submission's projected Core `human_message` belongs
to a turn already owned by another Prompt. Preserve that owner and its Answer,
then feed the losing Prompt through exact-session, idle/done, oldest-first
bounded recovery to `uncertain`. Treat a missing submission receipt as another
bounded-recovery input, and continue waking recovery until later detached heads
can advance. Ordinary dispatch must remain independent throughout.

**Spec references**

- SCN-4, SCN-5, SCN-6
- INV-2, INV-3, INV-4, INV-5
- ARCH-4, ARCH-5

**Ownership and implementation path**

- The SQLite recovery store owns transactional interpretation of projected Core
  evidence and returns a domain result distinct from generic ambiguity when an
  exact turn has another Prompt owner.
- The domain-owned recovery port carries only bounded identifiers and outcome
  semantics; it does not expose SQLite rows or Core JSON.
- `PromptRunWorkflow` maps conflicting ownership and unavailable receipts to the
  existing bounded recovery operation. It preserves generation, pane, session,
  oldest-head, runtime-state, attempt, timeout, Run Card and outbox fences.
- Terminalizing a head schedules another durable recovery pass without coupling
  recovery completion to ordinary Prompt admission.
- The late-repair path remains authoritative if exact ownership evidence later
  appears for an `uncertain` Prompt.

**Acceptance criteria and verification**

- Given owner Prompt `080d...` and submission `a388...` in the same exact Core
  turn, recovery reports `turn_owned_by_other_prompt` instead of generic
  ambiguity.
- The owner remains delivered with its original Answer and ownership tuple.
- The losing Prompt never receives the owner's Answer and becomes `uncertain`
  through bounded recovery without replay.
- A null submission receipt advances attempts only under exact binding, pane,
  session and `idle/done` fences; `blocked`, `unknown`, changed session, or
  disabled auto-recovery cannot terminalize it.
- After one oldest head terminalizes, the next detached head becomes eligible
  and recovery is woken again; a queued ordinary Prompt remains dispatchable.
- Duplicate recovery wake-ups create only one terminal transition and outbox
  intent.
- Existing late-repair behavior remains green.
- Red-Green tests: `tests/sqlite-store.test.ts`,
  `tests/detached-core-recovery.integration.test.ts`,
  `tests/core-event-recovery.test.ts`, and
  `tests/prompt-run-safety-scan.test.ts`.
- Affected verification: those files, late-repair tests,
  `npm run typecheck`, and `npm run build`.
- Dependency evidence: recovery policy remains in coordinator/domain contracts;
  SQLite event queries and transactions remain in the store adapter.

**Blocked by:** None.

**Implementation evidence (2026-10-01)**

- Projected Core recovery now distinguishes `turn_owned_by_other_prompt` from
  generic ambiguous evidence without changing either Prompt's ownership.
- Conflicting ownership and unavailable submission receipts enter the existing
  exact-session, idle/done, oldest-first bounded recovery path.
- Automatic and explicit head terminalization request an immediate durable scan
  so later detached work can advance independently of ordinary FIFO work.
- The owner Prompt and its Answer remain unchanged; duplicate recovery attempts
  are fenced by the existing transactional state transition.
- Affected tests passed: 6 files and 480 tests. Full `npm test` passed with 235
  files and 3,235 tests; `npm run typecheck` and `npm run build` passed.

## Final Delivery Checks

- Review the complete diff against SCN-1 through SCN-6 and INV-1 through INV-5.
- Verify that ordinary dispatch has no path that treats `working` as eligible.
- Verify that no recovery path replays a possibly delivered Prompt or reassigns
  another Prompt's Answer.
- Run `npm run typecheck`.
- Run `npm run build`.
- After build completes, run `npm test` separately.
- Inspect `git status`, staged paths, and each atomic commit to ensure none of
  the preserved user-owned untracked paths is included.
- Do not install, restart, push, or open a pull request without separate user
  authorization.
