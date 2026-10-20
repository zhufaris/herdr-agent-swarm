# Unified Agent Input and Explicit Command Routing — Implementation Plan

## Planning authority

- Approved specification: [`../specs/2026-10-03-unified-agent-input-and-command.md`](../specs/2026-10-03-unified-agent-input-and-command.md)
- Gate 2: approved by the user on 2026-10-03.
- Workspace: isolated linked worktree `/tmp/herdr-agent-swarm-unified-agent-input`.
- Branch: `feat/unified-agent-input`.
- Starting revision: `312fc759d8c4577ee11d40b703e741b40d1a6920`.
- Baseline: Node `v24.14.1`, npm `11.11.0`; serial `npm run typecheck`, `npm run build`, and `npm test` passed at the approved specification boundary (254 files, 3711 tests). Build identity: `sha256:5a14ca70d2a24f23427639a4a1637746aed2d8e2d560eb4c567d0c6046eea9e2`.
- Ownership: the original checkout's modified `TODO.md` and untracked `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md` remain excluded.
- Gate 3: approved by the user; implementation authorized without deployment,
  production mutation, push, PR, or external publication authority.

The specification spans Herdr Core and this Swarm repository. T1 is delivered in a separately prepared Core workspace under that repository's instructions and baseline; it never mixes Core source into this worktree. The remaining tickets are delivered here. Each completed ticket receives its own atomic Conventional Commit in its owning repository, with the durable checkbox updated as part of the next safe Swarm plan commit when a cross-repository commit cannot contain this file.

## Tickets

- [x] **T1: Add the versioned Core Agent Input submission capability**

  **What to build:** In Herdr Core, add the advertised versioned submission contract that accepts one caller-owned submission ID under exact Pane, terminal, Agent-kind, and optional native-session fences. It must durably prepare the submission, prevent duplicate terminal writes, bind the first matching human message to a newly created session/Turn when no session existed, expose receipt lookup, and produce structured definite pre-effect rejection for stale or conflicting fences. Existing stable endpoint behavior remains unchanged.

  **Spec references:** SCN-2, SCN-4, SCN-11; INV-2, INV-3; “Core submission capability” and “Core contract verification.”

  **Ownership and implementation path:** Herdr/Core Runtime owns serialization, pending-submission persistence, receipt transitions, native session/Turn identity, and JSONL events. Prepare a separate safe Core workspace, inspect its project instructions, and establish its fresh baseline before Red. The public request/result schema is versioned; duplicate identity with the same immutable body/fences adopts the existing receipt, while conflicting reuse is rejected. No Feishu, card, or Swarm execution state enters Core.

  **Acceptance criteria and verification:** Focused Core tests prove first-session and existing-session fences, duplicate suppression, conflicting-body rejection, restart persistence, blocked/stale-fence rejection, human-message correlation, and `prepared -> observed -> terminal`/`cancelled` receipts. Live and exact reads expose stable matching event IDs in JSONL order. Run the Core-prescribed affected checks and full suite, then build/install a disposable candidate and exercise one non-production first-session smoke. No production Pane or database is used for the smoke.

  **Blocked by:** None.

  **Delivery:** Herdr Core commit `a3669e0e` (`feat(agent-events): add
  versioned agent input`); focused contract/recovery/routing tests, full 4,018-test
  suite, lint, build, and disposable first-session duplicate-suppression smoke passed.

- [x] **T2: Persist independent Submission Intents and query-only recovery**

  **What to build:** Add the Swarm-owned Submission Intent aggregate, application/store interfaces, and SQLite migration. Admission atomically freezes source identity, actor audit data, body, owner generation, Pane/terminal/session fences, and caller submission ID. Competing drainers can claim `recorded -> attempting` once; every state at or beyond `attempting` is permanently non-replayable. Restart recovery may resubmit only `recorded` work and may only query evidence for `attempting`, `prepared`, or `uncertain` work. This ticket does not switch live ingress.

  **Spec references:** SCN-1, SCN-4, SCN-5, SCN-12; INV-1 through INV-4 and INV-10; “Agent Input module,” “Behavior and Failure Modes,” and “Swarm domain and persistence tests.”

  **Ownership and implementation path:** Agent Input owns the immutable aggregate and consumer-owned Core/store ports. The SQLite adapter owns unique source-message admission, compare-and-swap transitions, controlled reconstitution, and immutable-conflict rejection. Loading state must not call Core, emit lifecycle facts, or make a possible effect replayable. There is deliberately no predecessor Prompt lookup or Binding execution-slot predicate.

  **Acceptance criteria and verification:** Red-Green persistence/integration tests cover duplicate convergence, conflicting duplicate rejection, competing claims, save/load plus subsequent valid transitions, restart eligibility for `recorded`, query-only handling after `attempting`, and independent B admission while A is detached or uncertain. Migration tests prove legacy possible-effect rows cannot become new submission work. Run affected SQLite and concurrency tests, `npm run typecheck`, `npm run build`, and the full suite because persistence and recovery semantics change.

  **Blocked by:** None.

  **Delivery:** Swarm migration 88 and the named `agentInputs` SQLite capability
  persist immutable Submission Intents, atomically converge source duplicates,
  fence `recorded -> attempting` claims, adopt only forward exact-fence Core
  receipts, and classify restart work as submit-only for `recorded` or
  query-only for `attempting`/`prepared`/`uncertain`. Focused persistence,
  migration, lease-fencing, and architecture tests passed together with
  typecheck, build, and the full 3,717-test suite. Live ingress remains on the
  legacy path until T7.

- [x] **T3: Integrate Core receipts and capability-gated Agent Input draining**

  **What to build:** Implement the Swarm Herdr/Core adapter for the versioned submission and receipt-query contracts, translate structured Core results into Submission Intent transitions, and add an Agent Input drainer that processes each eligible intent independently. Feature detection makes new-input readiness false when a configured route requires the capability and it is absent; no sessionless `runPrompt` fallback is allowed.

  **Spec references:** SCN-2, SCN-4, SCN-5, SCN-11; INV-2 through INV-4; “Agent Input module,” “Core submission capability,” and the receipt outcome table.

  **Ownership and implementation path:** Agent Input owns the port and effect-certainty policy; the Herdr adapter alone knows CLI/API schemas and structured error codes; the composition root assembles concrete dependencies and capability reporting. Persist `attempting` before calling Core. Timeout, malformed response, process loss, or absent post-attempt receipt becomes `uncertain`; duplicate submission responses converge via receipt lookup.

  **Acceptance criteria and verification:** Adapter and workflow integration tests prove accepted, duplicate, rejected, timeout, restart, and absent-capability behavior. A test-failing submission port proves uncertain A is never resent while B still reaches Core. Readiness/status tests prove capability absence is explicit and cannot silently select the old executor. Run affected adapter/workflow/config/status tests, typecheck, build, and the full suite. Verify the installed disposable Core candidate contract without touching production state.

  **Blocked by:** T1, T2.

  **Delivery:** The consumer-owned `AgentInputCorePort`, Herdr v2 adapter,
  independent drainer, startup recovery, and explicit capability/readiness
  component now translate exact Core receipts without a `runPrompt` fallback.
  The production assembly keeps the capability optional until T7 switches live
  ingress; the required mode is covered separately and fails closed when Core
  support is absent. Focused adapter, drainer, capability, command-redaction,
  startup, health, architecture, and SQLite tests passed (8 files, 672 tests),
  together with typecheck, build identity
  `sha256:f64144c99185b1734755246c62c7744abe56a8ba184137f4a722b5f46bc21a20`,
  and the full 3,734-test suite. The disposable Core candidate exposed the
  exact CLI flags and generated `agent.input.submit.v2` schema, and its already
  built exact CLI wire test passed; a fresh Core rebuild remains unavailable on
  this host because the required Zig 0.16.0 executable is absent. Live ingress
  remains on the legacy path until T7.

- [x] **T4: Project live Core batches in JSONL order and adopt direct Herdr input**

  **What to build:** Make the live Core reader/projector apply every returned batch in array order using only its opaque cursor and stable-ID idempotency. Remove timestamp/event-ID sorting from the authoritative projection path. An unmatched direct-Herdr `human_message` creates or updates the same Turn/Answer/Main projection shape as correlated Feishu input.

  **Spec references:** SCN-3, SCN-6, SCN-8; INV-5, INV-7, INV-9; “Ordered event projection and authoritative replacement” live-path decisions.

  **Ownership and implementation path:** Core readers translate ordered external evidence; Conversation Projection owns deterministic reduction and view/outbox transactions; Agent Input is not consulted to invent ownership or order. `occurred_at` remains audit metadata. Stable IDs provide duplication identity, not sorting.

  **Acceptance criteria and verification:** Regression tests use same-timestamp human/tool events whose hash order disagrees with JSONL order and assert exact array-order projection. Duplicate delivery is idempotent, cursor settlement remains atomic with view/outbox intent, and an unmatched direct Herdr human message receives the normal projection without a synthetic Prompt Job. Run affected event-inbox/projector/answer tests, typecheck, build, and the full suite.

  **Blocked by:** None.

  **Delivery:** Live Core event settlement now persists the first formal batch
  order per exact Turn and replays only that evidence; timestamp/event-ID
  fallback ordering was removed. Unmatched direct Herdr input is reduced into
  a durable non-Prompt Conversation Turn projection with atomic Answer/Main
  outbox intent, delivery checkpoints, restart continuity, and exact fenced
  supersession of a detached legacy Prompt when applicable. No synthetic
  Herdr Prompt Job is created, and T7 remains the live Feishu ingress cutover.
  Focused event-inbox, observer, lifecycle, and admission tests passed (4
  files, 81 tests), the post-review supersession tests passed (2 files, 48
  tests), typecheck passed, build identity
  `sha256:da3bbdeaeee85c07e8fc79b2ce8ebfd41d14dd1ba8f63222155708e9bd8afcf5`,
  and the full 3,737-test suite passed.

- [x] **T5: Stage and validate complete authoritative Turn snapshots**

  **What to build:** Persist exact-recovery pages and opaque continuation as snapshot staging with no Run, Answer, Main Card, frozen-page, or outbox effect until Core returns `complete=true`. Validate the fenced session/Turn/canonical start, page continuity, stable identity/content, and that already projected live evidence is a matching subset. A malformed, extra, or conflicting live event leaves the current projection unchanged and opens/retains an `ambiguous` gap.

  **Spec references:** SCN-9; INV-5, INV-6, INV-9; “Authoritative Turn Snapshot,” exact recovery results, and snapshot conflict tests.

  **Ownership and implementation path:** Conversation Projection owns staging and validation; SQLite owns crash-safe pages/checkpoints and the no-effect-before-complete boundary. Recovery scheduling may retry `indexing` or incomplete reads but cannot submit Agent Input. It never concatenates, sorts, or append-deduplicates live and recovery rows.

  **Acceptance criteria and verification:** Integration tests prove incomplete pages survive restart with byte-for-byte unchanged formal views/outbox, duplicate pages converge, complete snapshots validate, live `A,C` is accepted as a subset of snapshot `A,B,C`, and extra/content-conflicting live evidence produces `ambiguous` without mutation. Submission ports fail the test if invoked. Run focused store/recovery/projector tests, typecheck, build, and the full suite.

  **Blocked by:** T4.

  **Completed:** Exact-recovery pages now stage durably in dedicated SQLite
  snapshot tables behind a separate Conversation Projection capability. Page
  continuity, canonical Turn identity, stable event content, and ordered live
  subset compatibility are validated before a candidate becomes `ready`;
  incomplete, `indexing`, missing, malformed, conflicting, or reordered
  evidence cannot change formal Turn/CardKit projection or enqueue outbox work.
  Restart, duplicate-page, A/C-subset-of-A/B/C, discontinuity, extra-live,
  content-conflict, and live-order-conflict coverage passed. Focused affected
  verification passed (6 files, 604 tests), typecheck passed, build identity
  `sha256:207aa1f2677af516a6f52b9155405fed13c3ec6ef31191550b9847199f17b683`,
  and the full 259-file, 3,744-test suite passed.

- [x] **T6: Atomically replace terminal Turn projections and repair visible history**

  **What to build:** Reduce a validated completed snapshot from empty state in Core order and atomically replace the Turn-owned projection, recovery checkpoint/gap, view revisions, late-history continuation intent, and replaceable Main Card intent. Preserve already frozen Answer delivery history. Recover the documented 61-event incident fixture without invoking Agent submission.

  **Spec references:** SCN-9, SCN-10; INV-5 through INV-7 and INV-9; “Ordered event projection and authoritative replacement,” “Recover the affected terminal Turn,” and incident verification decisions.

  **Ownership and implementation path:** Conversation Projection owns reduction and replacement semantics; the SQLite adapter enforces the single transaction; Delivery receives idempotent projection intents but cannot change execution truth. Snapshot revision/fenced Turn identity keys the continuation so repeated complete recovery is a no-op.

  **Acceptance criteria and verification:** The `A,C` then `A,B,C` regression yields exactly `A,B,C`, never `A,C,B`. Crash-before-commit preserves the old projection; crash-after-commit reopens the new projection and its repair intents together. Duplicate completion creates no second continuation. The 61-event fixture reaches terminal Answer/Main repair with zero submission calls, frozen pages unchanged, one late-recovery continuation, and one replaceable Main update. Run focused projection/outbox/CardKit tests, typecheck, build, and the full suite.

  **Blocked by:** T5.

  **Completed:** A validated terminal snapshot is now reduced from empty state
  and replaces the Turn projection, ordered event membership, Run/Topic views,
  recovery gap/checkpoint, applied marker, and Answer/Main delivery intents in
  one SQLite transaction. Replacement preserves frozen Answer pages, creates
  one idempotent history continuation for Prompt-backed recovery, repairs the
  existing conversation-turn Answer lane for direct Herdr work, and rejects
  stale session fences or nonterminal views before mutation. Duplicate complete
  recovery is a no-op. The documented 61-event incident fixture converges in
  exact Core order without `recover-turn`, Prompt, or Agent Input submission.
  Crash-before rollback and crash-after reopen coverage passed. Focused
  projection/outbox/CardKit verification passed (14 files, 879 tests),
  typecheck passed, build identity
  `sha256:0525a96698e15df2afb1895d64e0d2d72cf5d70fbc868937a405ae8fe0f646cb`,
  and the full 259-file, 3,751-test suite passed.

- [x] **T7: Cut bound Primary text over to independent Agent Input**

  **What to build:** Change Primary inbound routing so documented `/swarm ...` controls and authenticated CardKit actions retain their control paths, while every other eligible bound-thread text—including `/model`, `/compact`, unknown slash text, and ordinary bot mentions—is submitted verbatim through Agent Input. New Primary messages stop creating Prompt Inputs, Native Input Batches, Prompt Jobs, queue positions, or Binding execution-slot work. Runtime `working`, `blocked`, detached, or uncertain predecessor state is never an admission gate.

  **Spec references:** SCN-1 through SCN-5 and SCN-7; INV-1 through INV-4 and INV-8; “Command routing” and “Switch new Primary input.”

  **Ownership and implementation path:** Ingress and Routing retains configured-chat, actor, size, route, generation, and source-idempotency checks; Agent Input owns submission; Swarm Control owns only explicit grammar/actions. The cutover is capability-gated and fails closed before accepting new-path input when Core support is absent. Unbound/root provisioning interpretation remains unchanged in this ticket.

  **Acceptance criteria and verification:** Routing/integration tests prove reserved controls remain controls, all other bound text is unchanged Agent Input, authorization/limits remain enforced, concurrent A/B inputs are independently submitted, and callback/SQLite order is never asserted as conversation order. Detached or uncertain A does not prevent B. Source searches and composition tests prove the Primary route cannot reach prompt batching/dispatch stores. Run affected inbound/command/concurrency/projection tests, typecheck, build, and the full suite.

  **Blocked by:** T3, T4.

  **Completed:** Active bound Primary text now preserves only explicit
  `/swarm ...` as Swarm Control and submits every other eligible message
  verbatim through a capability-gated Agent Input workflow. Submission Intent
  admission is durable before Core submission; TraeX and Pi session fences are
  preserved, unsupported Agent kinds fail closed, and detached or uncertain A
  cannot prevent independent B admission. The route creates no Prompt Input,
  Native Input Batch, Prompt Job, queue position, or Binding execution-slot
  work. Unbound/root provisioning and authenticated CardKit behavior remain on
  their existing paths. Legacy Prompt recovery tests now seed legacy work
  explicitly instead of using live ingress. Focused affected verification
  passed (13 files, 233 tests), typecheck passed, build identity
  `sha256:84603364ced65482d6809c90969f87425acffc80d336f2e1e2dc2240947d6e92`,
  and the full 260-file, 3,754-test suite passed.

- [x] **T8: Reuse Agent Input for Worker and first-session provisioning paths**

  **What to build:** Route eligible Worker Session text and initial Primary/Worker bootstrap input through the same Agent Input workflow while preserving Worker-control grammar, ownership fences, provisioning authorization, and card identity. Remove new-path dependency on the sessionless observed executor.

  **Spec references:** SCN-1, SCN-5, SCN-7, SCN-11; INV-1 through INV-4 and INV-8; “Switch initial and Worker input.”

  **Ownership and implementation path:** Worker Runtime retains Worker/Worker-session/owning-Primary generation fences; Primary Session retains provisioning checkpoints; both consume the Agent Input interface without duplicating effect/recovery policy. Ingress-specific translation supplies owner metadata and exact terminal/session fences.

  **Acceptance criteria and verification:** Worker and provisioning integrations prove eligible text reaches one immutable Submission Intent, reserved Worker controls do not, duplicate source delivery converges, stale generations reject before Core, and first-session submission uses the advertised capability with no `runPrompt` fallback. Existing Worker card ownership and provisioning restart tests remain green. Run affected Worker/provisioning/adapter tests, typecheck, build, and the full suite.

  **Blocked by:** T3, T7.

  **Completed:** Eligible Worker Session text now submits through the shared
  Agent Input workflow under exact Worker generation, Pane, terminal, Agent
  kind, and optional native-session fences. Reserved `/status`, `/steer`, and
  `/stop` controls retain their existing paths; other slash text is forwarded
  verbatim, unsupported Agent kinds fail closed, and acceptance cards no longer
  invent FIFO or queue position. Initial default-project, Orchestrator, selected
  project, and restart-recovered provisioning input now converges by source
  message identity into one Submission Intent with no Prompt Input, Native
  Input Batch, Prompt Job, or `runPrompt` fallback. Sessionless Worker runtime
  attachment preserves a null native-session fence for Core v2 first-session
  submission. Focused Worker/provisioning/composition verification and the
  504-test SQLite persistence suite passed; typecheck passed, build identity
  `sha256:fcfe5eb0c7baa34e0096d6cc279fd511feb0f38dc114bb593f03e993b0f0603c`,
  and the full 261-file, 3,764-test suite passed.

- [x] **T9: Migrate legacy input without replay and expose convergence status**

  **What to build:** Add restart-safe expand/migrate logic that converts only legacy source members with durable proof that no effect attempt began into independent Submission Intents. Legacy submitted/running/recovering/uncertain/detached work remains recovery-only and adopts receipts/exact Turns without submission. During convergence, status exposes legacy and Submission Intent counts separately, plus Core projection lag/gaps; `/swarm awake` performs projection catch-up/card redelivery rather than waking a Prompt dispatcher.

  **Spec references:** SCN-4, SCN-10, SCN-12; INV-3, INV-4, INV-9, INV-10; “Compatibility and Migration” steps 3, 6, and 7; “Command routing” status/awake decisions.

  **Ownership and implementation path:** Agent Input migration owns proof-based conversion and immutable source correlation; legacy recovery owns only receipt/projection convergence; Delivery remains downstream. Old batch ordinals, timestamps, and queue positions are never imported as conversation order. `/swarm skip` remains explicitly legacy-only during this stage.

  **Acceptance criteria and verification:** Migration tests decompose never-attempted batches once and preserve source-message identity, while every possible-effect fixture creates zero new submission calls. Restart and competing migration runs are idempotent. The incident fixture can converge through T6's replacement. Status/command tests prove dual counters and awake semantics; no card evidence repairs execution state. Run migration/recovery/command/status tests, typecheck, build, and the full suite.

  **Blocked by:** T6, T7, T8.

  **Completed:** Startup now detects Core Agent Input support, atomically
  decomposes only provably never-attempted legacy batch members and direct
  queued Prompt Jobs into source-idempotent Submission Intents, cancels their
  retired legacy execution records, and then runs receipt recovery before
  ingress. Submitted, running, recovering, uncertain, detached, or otherwise
  possible-effect work remains untouched and recovery-only. Migrated queued
  Run Cards are terminalized through durable view convergence. Operational
  status now separates Submission Intent receipt states, Core projection lane
  lag/events, outbox delivery, and explicitly labeled legacy convergence
  counts. `/swarm awake` performs Core projection catch-up plus durable Main
  and latest Answer redelivery without waking the legacy Prompt dispatcher;
  `/swarm skip` remains legacy-only. Migration competition/reopen, recovery,
  command, status, startup, and lifecycle coverage passed as part of the full
  262-file, 3,768-test suite; typecheck passed and build identity
  `sha256:3287794f28f64ea77cf09603156bd82983cec25fc0c5d0b392b87e73792a4dc8`
  was generated.

- [ ] **T10: Contract the obsolete Prompt executor and publish the new operating model**

  **What to build:** After migration diagnostics prove no eligible legacy input remains, remove Prompt admission/batching/dispatch/recovery composition, Ordinary Execution Slot and detached blocker semantics, queue feedback/position projection, sessionless `runPrompt` fallback, and obsolete status counters/schema through a verified contraction. Update architecture, context-map/domain language, Feishu usage, and operator status documentation to make Submission Intent, Core JSONL order, projection recovery, and delivery-only CardKit state authoritative.

  **Spec references:** All scenarios; INV-1 through INV-10; final “Contract” migration step, structural verification, and documentation requirements.

  **Ownership and implementation path:** Composition no longer wires new input to Prompt Execution. Primary Session language stops describing Prompt FIFO ownership; the proposed Agent Input/Conversation Projection boundaries become the documented model. Delivery and Operations reports receipt/projection/outbox facts rather than execution queue authority. Schema contraction must be restart-safe and must not discard unresolved possible-effect evidence.

  **Acceptance criteria and verification:** Source/dependency checks find no new-input use of `NativeInputBatch`, `claimNextDispatchablePrompt`, ordinary queue-position projection, detached blocking, or sessionless `runPrompt`. Migration fixtures retain unresolved evidence across upgrade/reopen. User docs classify commands exactly as the approved routing grammar. Run all affected tests, `npm run typecheck`, `npm run build`, full `npm test`, config validation, and non-mutating candidate status/smoke checks. No production deployment or database mutation is included.

  **Blocked by:** T9.

## Dependency order

```text
T1 Core capability ----> T3 Core integration ----+
                         ^                       |
T2 Submission Intent ----+                       +----> T7 Primary cutover ----> T8 Worker/bootstrap
                                                       |                         |
T4 ordered live projection --> T5 snapshot staging --> T6 atomic replacement ---+--> T9 migration --> T10 contract
          |                                            ^
          +--------------------> T7 --------------------+
```

Independent early slices are T1, T2, and T4. The approved plan does not authorize parallel agents; execution remains one ticket at a time unless the user separately requests delegation.

## Gate 3 coverage check

| Specification coverage | Responsible tickets |
| --- | --- |
| SCN-1 | T2, T7, T8 |
| SCN-2 | T1, T3, T7 |
| SCN-3 | T4, T7 |
| SCN-4 | T1, T2, T3, T9 |
| SCN-5 | T2, T3, T7, T8 |
| SCN-6 | T4 |
| SCN-7 | T7, T8 |
| SCN-8 | T4 |
| SCN-9 | T5, T6 |
| SCN-10 | T6, T9 |
| SCN-11 | T1, T3, T8 |
| SCN-12 | T2, T9, T10 |
| INV-1, INV-2 | T1, T2, T7, T8 |
| INV-3, INV-4 | T2, T3, T7, T8, T9 |
| INV-5 | T4, T5, T6 |
| INV-6 | T5, T6 |
| INV-7 | T4, T6, T10 |
| INV-8 | T7, T8 |
| INV-9 | T4, T5, T6, T9 |
| INV-10 | T2, T9, T10 |

Every ticket traces to approved behavior and an observable verification seam. The dependency graph is acyclic. There are no unresolved load-bearing design decisions. T1's separate Core workspace and baseline are execution prerequisites, not missing design; T3/T7/T8 cannot complete until its candidate contract is verified. T10's contraction is additionally conditional on migration diagnostics proving that removing legacy machinery preserves unresolved effect evidence.

## Final delivery checks

After every ticket is committed, `delivery-coder` performs findings-first review across both repositories, routes any repair back through the owning ticket's TDD path, and gathers fresh evidence for:

- every SCN/INV mapping above;
- Core focused and full checks plus the disposable installed-binary contract smoke;
- Swarm `npm run typecheck`, serial `npm run build`, and full `npm test`;
- architecture/source dependency checks and the absence of old new-input call paths;
- restart, duplicate, uncertain-effect, snapshot-replacement, and migration fixtures;
- non-mutating candidate configuration/readiness/status observation.

Delivery does not deploy, restart production, mutate the production database, push, open a pull request, or publish external tickets without separate explicit authorization.
