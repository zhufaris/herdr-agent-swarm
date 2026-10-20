# Detached Submission Lifecycle and Turn Recovery Plan

Approved specification: [Detached Submission Lifecycle and Turn Recovery](../specs/2026-10-01-detached-submission-turn-recovery.md)

## Planning Record

- Workspace: in place at `/workspace/herdr-agent-swarm` on
  `main`.
- Starting revision for the revised lifecycle plan:
  `45a201ce1f41dae8422500e16925587472ae27ba`.
- Rationale: the revised specification and this plan are task-owned paths. The
  checkout also contains concurrent task-owned historical-recovery source edits
  and unrelated untracked `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
  and `handoff.md`; those paths must not be cleaned, staged, or overwritten.
  Lifecycle implementation waits for the overlapping historical-recovery ticket
  to finish before editing its recovery/workflow files.
- Fresh baseline on the current concurrent working snapshot:
  `npx vitest run tests/detached-core-recovery.integration.test.ts
  tests/external-turn-observer.test.ts tests/sqlite-store.test.ts --reporter=dot`
  passed 3 files and 441 tests; `npm run typecheck` passed; `npm run build`
  passed with build identity
  `sha256:7b5a9a821279575ac69b0e3267e4b8d1212193b8326e228a01d554a332d8581b`.
- An earlier broad baseline passed 8 files and 719 tests. A transient baseline
  failure during the concurrent T2 edit was resolved by its owner before the
  successful baseline above.
- Gate 1 revised lifecycle design: approved by the user on 2026-10-01.
- Gate 2 revised specification: approved by the user on 2026-10-01.
- Gate 3 ticket set and implementation authorization: approved by the user on
  2026-10-01.

## Tickets

- [x] T1: Complete exact Bridge submission ownership across split Core frames

  **What to build:** Preserve canonical `turn_started` evidence across
  one-event-per-observation Core delivery so a later Human Message with the
  exact managed `submission_id` can claim the correct Prompt and project its
  final Answer even when older identity-less detached rows exist.

  **Spec references:** SCN-1, SCN-2, SCN-3, and SCN-5; INV-1, INV-2, INV-3,
  INV-4, and INV-5; ARCH-3.

  **Ownership and implementation path:** Prompt Execution owns exact
  submission-to-turn identity. The Core cursor restores one settled canonical
  start before projecting a later frame; the existing SQLite adoption
  transaction retains binding generation, pane, native session, turn, and start
  fences. Conversation Projection consumes only the proven owner. No Lark-side
  inference or Herdr resubmission is introduced.

  **Acceptance criteria and verification:** Separate start, Human Message,
  final Agent Message, and terminal frames complete exactly one managed Prompt;
  duplicate/mismatched evidence does not cross-attribute output; older detached
  work does not block the exact later submission. Focused observer and SQLite
  tests, typecheck, and build pass.

  **Delivered by:** `45a201ce fix: recover split-frame prompt ownership`.

  **Blocked by:** None.

- [x] T2: Recover already-ingested exact completed Bridge turns safely and idempotently

  **What to build:** Recover a historically detached managed Prompt from one
  exact, already-settled Core turn and its unambiguous terminal evidence. Apply
  the original final Answer or canonical abort through the existing Prompt,
  Run Projection, audit, and outbox transaction without replaying input or
  duplicating external effects.

  **Spec references:** SCN-4 and SCN-5; INV-1, INV-2, INV-3, INV-5, and INV-6;
  ARCH-2 and ARCH-3.

  **Ownership and implementation path:** Prompt Execution owns candidate
  qualification and recovery. The Core inbox supplies immutable evidence;
  SQLite atomically checks Prompt origin/state, binding generation, pane,
  native session, exact submission, turn/start uniqueness, and terminal
  uniqueness before updating the Prompt and projection. The application
  workflow invokes the recovery seam during bounded scans and logs only fenced
  outcome metadata. It must not call `queuePrompt`, `queueModelPrompt`, or
  rewind a generic Core lane checkpoint.

  **Acceptance criteria and verification:** Completed and aborted exact turns
  recover correctly; running recovery twice is idempotent; missing, duplicate,
  cross-session, cross-pane, cross-generation, or conflicting-owner evidence
  produces no mutation; no Herdr submission occurs. Run the focused recovery,
  observer, and SQLite suites, `npm run typecheck`, `npm run build`, and because
  this slice crosses persistence, recovery, and delivery semantics, `npm test`.

  **Delivered by:** `c798493b fix: recover settled bridge turns`.

  **Verification:** Focused recovery, observer, and SQLite coverage passed;
  the full suite passed 235 files and 3,220 tests; `npm run typecheck` passed;
  `npm run build` passed with build identity
  `sha256:999e7284d0b00f24be79e5a6e1379d9e07119eb247969d11486d2cee779f5f87`.

  **Blocked by:** T1.

- [x] T3: Persist explicit submitted, running, and recovering execution semantics

  **What to build:** Introduce the approved Prompt lifecycle vocabulary and
  schema migration so native acceptance becomes `submitted`, exact turn claim
  becomes `running`, and identity-less observer loss becomes non-blocking
  `recovering`. Migrate existing nonterminal rows from durable evidence and
  make dispatch/observation use explicit transitions. Exact-owned detached work
  must remain running and retain the one execution slot.

  **Spec references:** SCN-1, SCN-2, SCN-3, SCN-6, and SCN-10; INV-1 through
  INV-7; ARCH-1, ARCH-2, ARCH-3, and ARCH-6; Compatibility & Migration.

  **Ownership and implementation path:** Prompt Execution owns the lifecycle
  terms, transition preconditions, and Execution Slot. Expand Prompt state and
  Run Projection types/schema, migrate old rows idempotently, and replace
  generic state writes along native dispatch, exact adoption, startup detach,
  and follower dispatch with domain-shaped store operations. Adapt T1/T2 exact
  recovery predicates from identity-less `running/detached` to
  `recovering/detached`. SQLite remains the atomic adapter; Herdr provides only
  normalized runtime/Core evidence. Direct PTY dispatch continues to require a
  fresh idle/done pane when native queueing is unavailable.

  **Acceptance criteria and verification:** Migration maps exact-owned,
  identity-less attached, identity-less detached, and genuinely undispatched
  rows to the approved states without changing historical terminal rows;
  reopen is idempotent; submitted/recovering rows never replay; exact-owned
  detached rows retain the slot; recovering rows do not block a later native
  submission/FIFO owner; mismatched fences fail closed. Add focused migration,
  dispatcher, observer, concurrency, and integrity tests. Run affected SQLite,
  prompt dispatcher, recovery, observer, and concurrency suites, architecture
  checks, `npm run typecheck`, and `npm run build`.

  **Delivered by:** `fix: persist prompt execution lifecycle`.

  **Verification:** SQLite store coverage passed 409 tests; the focused
  dispatcher, recovery, observer, concurrency, lifecycle, integrity, and
  architecture set passed 11 files and 220 tests; the full suite passed 235
  files and 3,220 tests; `npm run typecheck` passed; `npm run build` passed with
  build identity
  `sha256:bed8a0b19116f4a0dbdae9d8a08c3afe236576d804534ffa21c0b01b03b6e719`.

  **Blocked by:** T2, because this ticket migrates the historical-recovery
  preconditions and must start from its completed atomic interface rather than
  race its concurrent implementation.

- [x] T4: Terminalize bounded recovery as uncertain and repair late exact proof

  **What to build:** Replace identity-less auto/manual skip failure semantics
  with the approved `uncertain` terminal outcome. Preserve the durable recovery
  schedule and idle/done fences, then allow strict late Core evidence to repair
  uncertain work exactly once. Freeze the uncertain Answer page and publish a
  separate idempotent recovery continuation rather than patching frozen history.

  **Spec references:** SCN-4, SCN-5, SCN-7, and SCN-11; INV-1, INV-2, INV-3,
  INV-5, INV-6, and INV-8; ARCH-1 through ARCH-4; Behavior & Failure Modes.

  **Ownership and implementation path:** Prompt Execution owns recovering to
  uncertain and uncertain to proven-terminal transitions. SQLite fences the
  oldest eligible recovering Prompt by generation, pane, session, state,
  observation mode, due time, and exact-identity absence. Conversation
  Projection maps uncertain and late repair facts; Delivery and Operations
  reserves one continuation intent under a stable repair idempotency identity.
  `/swarm skip` uses the same uncertain transition with creator fencing. No
  path terminates or resubmits the native turn.

  **Acceptance criteria and verification:** Expiry or the third due observation
  terminalizes only an idle/done, same-identity recovering Prompt; working,
  blocked, changed identity, and transient Core failure do not consume attempts;
  `/swarm skip` records uncertain rather than failed; exact late evidence
  produces one proven result and one continuation; duplicates, ambiguity, and
  races produce no duplicate outbox effect or frozen-page mutation. Run focused
  recovery, command, projection, outbox, and card suites, `npm run typecheck`,
  `npm run build`, and `npm test` before commit.

  **Delivered by:** `fix: repair uncertain prompt outcomes`.

  **Verification:** SQLite store, projected recovery, and bounded safety-scan
  coverage passed 3 files and 439 tests; the full suite passed 235 files and
  3,223 tests; `npm run typecheck` passed; `npm run build` passed with build
  identity
  `sha256:c1d77f68c7218b6584709e7fb12546f498226ddba0403b8c225339f3c1e8d070`.

  **Blocked by:** T3.

- [x] T5: Align cards, diagnostics, readiness, and restart safety with lifecycle truth

  **What to build:** Present distinct submitted, running, recovering, uncertain,
  proven failure, and repaired states; keep historical Recovery Backlog entries
  from replacing the current Main Card execution heading. Expose lifecycle-
  specific counts and oldest recovery age. Preserve dependency readiness while
  degrading operational status for an overdue backlog, and stop treating
  recovering/uncertain records as independent restart blockers.

  **Spec references:** SCN-2, SCN-6, SCN-8, SCN-9, and SCN-11; INV-4, INV-6,
  INV-7, and INV-8; ARCH-4, ARCH-5, and ARCH-6.

  **Ownership and implementation path:** Conversation Projection owns visible
  phase mapping and Topic selection precedence. Delivery and Operations owns
  diagnostics and restart evaluation based on persisted lifecycle facts.
  Readiness continues to report database/project/Herdr/Lark/lease/Core health;
  operational degradation carries bounded counts and age only. Restart safety
  retains queued, submitted/attached, exact-running, active worker, and delivery
  gates while excluding recovering and uncertain rows by themselves.

  **Acceptance criteria and verification:** Answer and Main Card tests show the
  approved labels and precedence; status exposes separate queued/submitted/
  running/recovering/uncertain metrics without Prompt text; overdue recovery
  degrades operational status but not dependency readiness; restart evaluator
  blocks the approved active states and permits recovery-only backlog; existing
  non-Prompt restart gates remain unchanged. Run Run/Card, health snapshot,
  status, service lifecycle, and architecture suites, `npm run typecheck`, and
  `npm run build`.

  **Delivered by:** `fix: align prompt recovery operations`.

  **Verification:** Run Card, health, restart-safety, migration, lifecycle,
  and Prompt integrity coverage passed; the full suite passed 235 files and
  3,228 tests; `npm run typecheck` passed; `npm run build` passed with build
  identity
  `sha256:f5d012059cae1bbbee0a4ddd0a5e2e034f725dd0649d7cc9676034e9767df1b4`.

  **Blocked by:** T4, because visible uncertain/repaired semantics and final
  lifecycle counts must be stable before operational consumers are contracted.

- [x] T6: Persist structured status title and render it as the Answer Task List title

  **What to build:** Persist the latest structured Core `statusTitle` separately
  from native `planSteps`, and show it as the bounded plain-text heading of the
  Answer Card Task List.

  **Spec references:** Approved Answer Task List title extension.

  **Ownership and implementation path:** Conversation Projection maps only the
  structured Core status field into the Run Projection. The Run Card reducer
  updates title and plan independently. SQLite migration v71 adds the nullable
  field and projects it through `run_cards_view`; CardKit rendering uses it only
  as the Task List heading. No ANSI frame or pane-text inference is introduced.

  **Acceptance criteria and verification:** A title-only status update advances
  the projection once; a duplicate does not. A plan-only update retains the
  title and preserves native plan identity. Legacy databases migrate with null,
  saved titles survive reopen, and Answer cards render a whitespace-normalized,
  96-character-bounded heading. Focused Run Card, event projection, card, and
  SQLite suites pass with `npm run typecheck` and `npm run build`.

  **Delivered by:** `fix: show Core status in Answer task lists`.

  **Verification:** Four focused files passed 538 tests; `npm run typecheck`
  passed; `npm run build` passed with build identity
  `sha256:5df7f45fdfc4bfdd81c551d680a47959fc73022ea162a13cf0ac949e909f86b5`.

  **Blocked by:** T5, because the Answer projection and lifecycle presentation
  must be stable before extending its durable visible state.

- [x] T7: Repair the Prompt lifecycle migration version collision

  **What to build:** Ensure databases that already recorded migration version 69
  for Worker expired-target recovery still rebuild the legacy `prompt_jobs.state`
  constraint before any queued Prompt can transition to `submitted`.

  **Spec references:** SCN-10; ARCH-2; Compatibility & Migration.

  **Ownership and implementation path:** SQLite migration orchestration owns this
  compatibility repair. Give the Prompt lifecycle migration a unique version and
  retain its existing foreign-key-safe rebuild and evidence-based state mapping.
  Do not edit live rows or schema outside normal startup migration.

  **Acceptance criteria and verification:** A database with migration 69 already
  present and the legacy Prompt-state CHECK migrates on reopen, records the new
  unique version, accepts `queued -> submitted` through the public dispatch store
  seam, remains foreign-key clean, and reopens idempotently. Run the focused
  SQLite test, the affected SQLite suite, architecture checks, typecheck, and
  build before the repair commit.

  **Delivered by:** `fix: repair Prompt lifecycle migration collision`.

  **Verification:** The focused collision regression passed; the complete
  SQLite store suite passed 413 tests; `npm run typecheck`, `npm run build`, and
  `npm run architecture:check` passed. The repair build identity is
  `sha256:4627374e258f51b02608dae7b3481f508c4038d9cc44bd26649faf3c45f0286d`.

  **Blocked by:** T3, whose migration behavior this ticket repairs without
  changing the approved lifecycle model.

## Final Delivery Checks

- Map SCN-1 through SCN-11 and INV-1 through INV-8 to completed tickets and
  fresh test evidence.
- Review the complete diff against `docs/architecture.md`, `CONTEXT-MAP.md`, and
  the Prompt Execution, Primary Session, Conversation Projection, and Delivery
  and Operations context documents. Update domain language where submitted,
  Execution Slot, Recovery Backlog, and Uncertain Outcome become canonical.
- Verify no path replays a Prompt after Dispatch Evidence, infers ownership from
  text/time/order, writes directly to a working PTY because a logical slot was
  released, or patches a frozen Answer page.
- Verify migration and every lifecycle transition are atomic, idempotent under
  duplicate scans/events, and fenced by the approved SQLite preconditions.
- Run the full Vitest suite, `npm run typecheck`, `npm run build`, architecture
  checks, and documentation checks freshly.
- Confirm T2 through T7 each produce one atomic Conventional Commit containing
  only ticket-owned paths. Never stage `.tmp-*`, `.trae/`, `handoff.md`, or
  unrelated concurrent work.
- Do not install, restart, mutate live SQLite, push, open a PR, or repair a
  production row without separate explicit authorization after verified
  delivery.

## Coverage Review

- T1 covers live exact split-frame adoption: SCN-1, SCN-2, SCN-3, SCN-5 and
  the identity/no-replay subset of INV-1 through INV-5.
- T2 covers already-ingested exact terminal recovery: SCN-4, SCN-5; INV-1,
  INV-2, INV-3, INV-5, INV-6; ARCH-2, ARCH-3.
- T3 covers the explicit execution lifecycle, migration, execution-slot
  ownership, and non-blocking follower behavior: SCN-1, SCN-2, SCN-3, SCN-6,
  SCN-10; INV-1 through INV-7; ARCH-1, ARCH-2, ARCH-3, ARCH-6.
- T4 covers bounded uncertainty, honest terminal meaning, manual skip, late
  exact repair, and frozen-card continuation: SCN-4, SCN-5, SCN-7, SCN-11;
  INV-1, INV-2, INV-3, INV-5, INV-6, INV-8; ARCH-1 through ARCH-4.
- T5 covers user-visible and operational consistency: SCN-2, SCN-6, SCN-8,
  SCN-9, SCN-11; INV-4, INV-6, INV-7, INV-8; ARCH-4, ARCH-5, ARCH-6.
- T6 covers the approved Answer Task List title extension without changing
  native plan identity or terminal parsing boundaries.
- T7 covers the production migration-version collision that could otherwise
  leave the legacy Prompt-state CHECK in place despite completed migration 69.
- Every approved scenario and invariant has at least one responsible ticket.
  T2 -> T3 -> T4 -> T5 -> T6 and T3 -> T7 are real dependency chains; T1 is already complete.
  There are no unresolved load-bearing decisions or cyclic blockers.
