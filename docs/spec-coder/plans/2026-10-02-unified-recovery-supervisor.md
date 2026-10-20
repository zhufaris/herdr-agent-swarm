# Unified Recovery Supervisor Implementation Plan

Specification: [Unified Recovery Supervisor](../specs/2026-10-02-unified-recovery-supervisor.md)

## Workspace and Baseline

- Workspace mode: isolated linked worktree at
  `/tmp/herdr-agent-swarm-install-4e8db27a`.
- Branch: `feat/unified-recovery-supervisor`.
- Starting revision: `524695929447efa5881d18065816cf685b6d10d1`.
- Accounted-for initial change: the approved test-fixture isolation repair is
  committed as `b3e0d090 test(lifecycle): isolate TraeX home in fixtures`.
- Fresh baseline after that repair: `tests/service-lifecycle.test.ts` 118 tests
  passed; `npm run typecheck` passed; `npm run build` passed with identity
  `sha256:409d36f211d7c9014f6d3f8bc0c7ee0fa22c99c1235166af92af5aa5ffd27498`;
  `npm test` passed 243 files and 3413 tests.
- Gate status: Gate 1 design, Gate 2 specification, and Gate 3 implementation
  authorization approved.
- Commit policy: one Conventional Commit per completed ticket, explicit
  ticket-owned paths only, with hooks disabled to prevent an injected
  `Trae CLI co-author attribution` trailer.

## Tickets

- [x] T1: Run background recovery through one supervisor

  **What to build:** Add `RecoverySupervisor` as the single owner of the
  periodic recovery cadence and coalesced full/prompt/Worker-turn hints. Adapt
  execution safety scanning and projection delivery recovery into separately
  testable executors under that supervisor. Wire startup and shutdown so the
  historical projection-repair barrier still runs before the publisher can
  claim old-target work, and prompt recovery is prepared before the common
  periodic loop begins. Preserve current automatic recovery outcomes.

  **Spec references:** SCN-1, SCN-3, SCN-4, SCN-5, SCN-7, SCN-8; INV-1, INV-2,
  INV-3, INV-4, INV-5, INV-7, and INV-8; Architecture sections covering the single periodic
  runner, executor separation, composition, startup, and shutdown.

  **Ownership and implementation path:** The supervisor is an application
  coordinator and depends on execution-scan and projection-delivery ports.
  `PromptSafetyScanner` retains durable prompt selection and scheduler hints but
  yields timer ownership. `ProjectionDeliveryRecoveryWatchdog` retains Primary
  Answer and Worker Task convergence, generation/idempotency behavior, and
  typed targeted requests but yields timer ownership. Composition and managed
  lifecycle assemble and start the supervisor. No concrete SQLite, Herdr,
  Gateway, or Feishu SDK type may enter the supervisor contract.

  **Acceptance criteria and verification:** Begin with focused failing tests for
  ordered full scans, typed-key coalescing, one follow-up scan for a hint arriving
  while active, item/stage failure isolation, periodic rediscovery, and shutdown.
  Preserve stale undispatched-claim handling, exact detached-observer scheduling,
  Primary/Worker targeted convergence, historical backfill, and the pre-publisher
  repair barrier. Assert zero calls to prompt submission in recovery cases. Run
  the new supervisor suite, `tests/prompt-safety-scanner.test.ts`,
  `tests/projection-delivery-recovery-watchdog.test.ts`,
  `tests/managed-bridge-runtime.test.ts`, the relevant architecture-boundary
  cases, `npm run typecheck`, and `npm run build`.

  **Blocked by:** None.

- [x] T2: Cascade committed execution outcomes into delivery recovery

  **What to build:** After a detached execution is durably settled and its
  completion/failure event is committed, send a prompt-scoped hint through the
  supervisor so projection/delivery convergence begins without waiting for the
  periodic interval. Keep the durable full scan as the fallback when the hint
  is lost or the projection is not yet eligible.

  **Spec references:** SCN-2, SCN-4, SCN-5, SCN-8; INV-1, INV-2, INV-3, INV-4,
  INV-6, INV-7, and INV-8; Behavior & Failure Modes sections covering committed-only
  cascade, races, and lossy hints.

  **Ownership and implementation path:** `DetachedPromptObserver` and the
  existing prompt recovery transaction remain responsible for deciding and
  committing the exact execution outcome. The lifecycle event/projector remains
  responsible for canonical Answer state. A narrow application callback or
  event-facing port notifies the supervisor only after the durable boundary;
  the supervisor routes the typed prompt key to the existing delivery executor.
  Ambiguous observation and shutdown detachment do not synthesize downstream
  projection work.

  **Acceptance criteria and verification:** Write an integration Red that
  settles a recovered prompt and proves a prompt-targeted delivery request is
  made after persistence and before any periodic tick. Cover completed and
  explicit failed outcomes, exclude uncertain/ownership-mismatch outcomes, and
  prove that dropping the hint is repaired by a later full scan. Spy on prompt
  submission and assert zero calls. Run the focused detached-observer,
  prompt-run, projection/event, supervisor, and recovery integration suites,
  followed by `npm run typecheck` and `npm run build`.

  **Blocked by:** T1.

- [x] T3: Make `/swarm awake` the binding-scoped earliest-stage recovery entry

  **What to build:** Route the existing durable `/swarm awake` command through
  the supervisor. For the frozen binding context, choose detached execution
  observation first; otherwise request proven Primary Answer and Worker Task
  delivery debt belonging to the binding. Render the selected normalized stage
  and a conservative result, and change execution-specific user wording from
  "恢复观察" to "恢复执行观察" without changing persisted run-card phase values.
  Update the help and Feishu operator guide.

  **Spec references:** SCN-1, SCN-3, SCN-4, SCN-6, SCN-7; INV-1, INV-2, INV-3,
  INV-4, and INV-5;
  the binding-scoped routing, compatibility, and terminology decisions.

  **Ownership and implementation path:** `CommandIntentDispatcher` calls a
  binding-scoped supervisor port and keeps existing command authorization,
  frozen identity, idempotency, and durable result semantics. The supervisor
  queries only normalized execution and delivery debt owned by the binding and
  returns a closed result type using the approved stage vocabulary.
  Presentation maps that type to bounded Feishu text; adapters do not decide
  recovery order.

  **Acceptance criteria and verification:** Start with command/integration Reds
  for execution-before-delivery routing, delivery-only recovery, no-debt no-op,
  busy/unavailable and `needs_human` outcomes, duplicate command idempotency,
  stale binding rejection, and zero prompt submission. Card tests require
  "恢复执行观察" and forbid the old ambiguous execution label in affected views.
  Documentation describes the broadened compatible behavior and the two safety
  boundaries. Run command, card, parsing/policy, pane-thread lifecycle, and
  supervisor suites plus `npm run typecheck` and `npm run build`.

  **Blocked by:** T1.

- [x] T4: Expose unified bounded recovery diagnostics

  **What to build:** Add a supervisor snapshot to service health/status with
  runtime state, last pass time/outcome, normalized stage counts, oldest pending
  age where current durable evidence supports it, and a bounded last failure.
  Use the same normalized stage mapping for `/swarm awake` results. A recoverable
  backlog remains operationally visible without changing readiness; a failed
  supervisor scan contributes to degraded status under the existing diagnostic
  policy.

  **Spec references:** SCN-5, SCN-6, SCN-8; INV-3 through INV-5, INV-7, and
  INV-8; Architecture and Compatibility decisions for diagnostics, bounded
  data, readiness, and conservative translation.

  **Ownership and implementation path:** The supervisor owns process-local scan
  diagnostics and derives stage summaries through narrow read capabilities over
  existing durable state. `HealthSnapshotCollector` consumes only the snapshot
  interface. It never receives prompt bodies, transcript content, SDK errors,
  credentials, or concrete database rows. Missing evidence maps conservatively
  instead of inventing a persistent state or migration.

  **Acceptance criteria and verification:** Write health/status Reds for every
  normalized stage, fresh-to-stale version protection, bounded error output,
  scan failure degradation, recoverable-backlog readiness preservation, restart
  reconstruction, and absence of sensitive fields. Extend architecture tests
  for dependency direction. Run supervisor, health server/snapshot, command
  presentation, architecture-boundary, `npm run typecheck`, and `npm run build`.

  **Blocked by:** T1.

- [x] T5: Repair merged recovery, redelivery, batching, and migration invariants

  **What to build:** Atomically supersede Primary completion actions whenever a
  newer native Human input is accepted, preserve still-valid fixed and dynamic
  completion actions during `/swarm awake` Answer redelivery, continue
  binding-scoped recovery through downstream projection/delivery evaluation
  after execution recovery, expose bounded non-sensitive per-item recovery kind
  and correlation identity in diagnostics without changing readiness, and make
  all SQLite migration identities unique and monotonic.

  **Spec references:** Choice-list one-shot and stale-action fencing; native
  batching accepted-input identity and atomicity; awake-redelivery canonical
  snapshot preservation; unified-recovery SCN-2, SCN-6, INV-1, INV-3, INV-5,
  INV-6, and readiness compatibility.

  **Ownership and implementation path:** Use public SQLite admission seams for
  action supersession, the redelivery workflow/store seam for canonical Answer
  rendering, RecoverySupervisor executor and durable-evidence ports for stage
  continuation and diagnostics, and migration registration/reopen seams for
  schema identity. Preserve exact-turn no-replay and existing outbox authority.

  **Acceptance criteria and verification:** Begin with failing public-seam tests
  covering immediate, collecting, and formed native acceptance; fixed and
  dynamic redelivery actions; post-execution `delivering`, `awaiting_ack`, and
  `needs_human`; bounded diagnostic identity/kind and unchanged `/ready`; and
  globally unique monotonic migration IDs. Run affected tests Red then Green,
  `npm run typecheck`, `npm run build`, commit the ticket atomically with hooks
  disabled, then run full `npm test` and final Git/message/status audit.

  **Blocked by:** T1 through T4 and the approved batching/redelivery merge.

- [x] T6: Repair synchronous recovery staging and native-action cleanup

  **What to build:** Make recovered execution settlement synchronously queue and
  await prompt-specific Answer projection/delivery convergence before
  `recoverBinding` reports its downstream stage; derive that stage from a
  binding-scoped authoritative query rather than the globally bounded
  diagnostic sample; include `workerTurnId` in bounded, content-free diagnostic
  identities; and make native immediate, collecting, and formed input
  supersession schedule the same `answer-converge` cleanup effect as legacy
  acceptance while keeping supersession transactional.

  **Spec references:** Unified-recovery SCN-2 and SCN-6, INV-1, INV-3, INV-5,
  INV-6, and INV-7; native-batching SCN-1, SCN-2, SCN-8 and durable admission
  atomicity; choice-list one-shot action consumption, successor supersession,
  and final-card convergence.

  **Ownership and implementation path:** Await the existing recovered-prompt
  callback through the prompt recovery workflow and composition seam without
  submitting or replaying a Prompt. Add a narrow binding-scoped recovery-stage
  read capability alongside, but separate from, globally capped diagnostics.
  Extend diagnostic correlation identity with Worker turn ID. Return and
  schedule the existing Answer-converge effect from native admission's durable
  completion-action supersession transaction.

  **Acceptance criteria and verification:** Begin with public-seam Reds proving
  synchronous recovered-prompt convergence and downstream stage reporting,
  authoritative target binding `needs_human` visibility behind more than 20
  unrelated diagnostic items, `workerTurnId` diagnostic identity, and
  Answer-converge cleanup for immediate, collecting, and formed native input.
  Assert zero prompt resubmission. Run affected suites Red then Green,
  `npm run typecheck`, and `npm run build`; commit atomically with hooks
  disabled; then run full `npm test` and audit Git status/log/message.

  **Blocked by:** T5.

- [x] T7: Repair mixed-stage priority and durable native-action convergence

  **What to build:** Make binding-scoped recovery report unrecoverable uncertain
  execution as `needs_human` ahead of pending delivery or acknowledgement while
  retaining recoverable detached execution as the first stage. Make native-input
  completion-action supersession leave a durable, transactional Answer projection
  obligation that startup and periodic convergence can rediscover after a
  post-commit throw, process crash, or database reopen.

  **Spec references:** Unified-recovery SCN-3 and SCN-6, INV-1, INV-2, INV-3,
  INV-5, and INV-7; native-batching durable admission atomicity, restart recovery,
  and lossy-hint rules; choice-list successor supersession, fail-closed callbacks,
  and startup/final-card convergence.

  **Ownership and implementation path:** Preserve execution-first recovery by
  ranking recoverable `recovering` prompts first, then rank uncertain execution
  debt before projection/delivery stages in the binding-authoritative SQLite
  query. At native admission, update the superseded final Answer's existing
  durable projection revision inside the same SQLite transaction so the current
  startup/periodic view scan and Answer convergence path reserve an idempotent
  button-removal snapshot without replaying TraeX.

  **Acceptance criteria and verification:** Begin with public-seam Reds proving
  mixed uncertain-plus-delivery and uncertain-plus-acknowledgement bindings report
  `needs_human`, while recoverable detached execution remains first. Add a
  file-backed store test that accepts native input, simulates loss of its
  process-local cleanup effect, reopens SQLite, and proves startup convergence
  reserves a button-free final Answer update without duplicate admission or
  Prompt replay. Run affected tests Red then Green, `npm run typecheck`, and
  `npm run build`; commit atomically with hooks disabled; then run full
  `npm test` and audit Git status/log/message.

  **Blocked by:** T6.

- [x] T8: Close final delivery-review recovery and batching gaps

  **What to build:** Drain an expired native collection window before admitting
  a later ordinary Feishu message, keep uncertain native-batch members inside
  source-work backpressure, include ordinary pending Answer and Worker delivery
  in bounded recovery diagnostics, and route the supervisor cadence through the
  shared periodic runner's guarded error path.

  **Spec references:** Native-batching SCN-2, SCN-5, INV-2, INV-5, and INV-7;
  unified-recovery SCN-5, SCN-6, SCN-8, INV-3, INV-7, and INV-8.

  **Ownership and implementation path:** The binding prompt workflow performs a
  due-batch reconciliation before native admission; SQLite remains authoritative
  for deadlines, membership, backpressure, and diagnostic outbox evidence. The
  recovery supervisor delegates cadence and rejection handling to the existing
  `PeriodicWorkflowRunner`.

  **Acceptance criteria and verification:** Observe public-seam Reds for
  drain-before-late-admission, uncertain-member backpressure, and ordinary
  delivery/ack diagnostic counts and identities. Preserve bounded content-free
  diagnostics, duplicate admission, batching atomicity, no replay, and periodic
  failure isolation. Run affected tests, architecture checks, typecheck, build,
  one atomic hooks-disabled commit, then the full suite and final Git audit.

  **Blocked by:** T7.

- [x] T9: Preserve duplicate-ingress effect idempotency during due-batch draining

  **What to build:** Detect an already accepted ordinary Feishu source message
  before using that arrival as a due-batch drain hint, so redelivery returns its
  durable acceptance result without forming a batch or emitting workflow and
  delivery effects. Keep the normal late-message drain-before-admission order.

  **Spec references:** Native-batching SCN-4, INV-2, INV-4, and INV-6.

  **Ownership and implementation path:** SQLite remains authoritative for the
  durable source-message identity. `BindingPromptWorkflow` consults that public
  store seam only to suppress pre-admission drain effects for known duplicate
  ingress; atomic acceptance methods remain the final concurrency authority.

  **Acceptance criteria and verification:** A public workflow test proves a
  duplicate collected message does not call the due-batch drain or emit effects,
  while the T8 late-new-message ordering test remains green. Update boundary
  fakes to implement the existing public store contract, run affected tests,
  typecheck, build, and commit one hooks-disabled repair commit before repeating
  full delivery verification.

  **Blocked by:** T8.

- [x] T10: Narrow duplicate-ingress source identity boundary

  **What to build:** Preserve T9 behavior while replacing its full Prompt Input
  read port with a consumer-shaped accepted-source existence query.

  **Spec references:** Native-batching SCN-4 and INV-6; architecture rule
  “Consumer-shaped ports preserve deep modules.”

  **Ownership and implementation path:** The application port accepts one named
  accepted source identity and returns only a boolean. The SQLite capability
  adapter translates that query to its richer internal Prompt Input lookup;
  persisted record shape does not cross the boundary.

  **Acceptance criteria and verification:** Keep the duplicate no-effects and
  late-new-message ordering tests green, run the architecture boundary suite,
  typecheck, and build. Commit the structural repair atomically with hooks
  disabled, then repeat final review and full verification.

  **Blocked by:** T9.

- [x] T11: Align the integration store adapter with the narrowed source port

  **What to build:** Expose the T10 accepted-source existence query through the
  shared SQLite integration-test kernel so background inbound processing uses
  the same prompt-acceptance contract as production composition.

  **Spec references:** Native-batching SCN-4 and INV-6; architecture dependency
  evidence for the Prompt Acceptance port.

  **Ownership and implementation path:** The test adapter translates the named
  source identity to its existing rich SQLite inspection method, matching the
  production capability adapter without widening the application port.

  **Acceptance criteria and verification:** The six integration files that
  timed out after T10 pass without changing production behavior or timeout
  thresholds. Run typecheck/build, commit atomically with hooks disabled, then
  repeat the full suite and final Git audit.

  **Blocked by:** T10.

- [x] T12: Preserve periodic recovery debt across failed convergence and overlapping ticks

  **What to build:** Make a committed native completion-action supersession
  periodically rediscoverable while the same process remains alive after its
  immediate Answer convergence throws. Preserve a periodic full-scan request
  that arrives while a targeted supervisor pass is active, so the targeted
  pass is followed by one bounded full scan instead of losing the cadence tick.

  **Spec references:** Unified-recovery SCN-4, SCN-5, SCN-8, INV-1, INV-3,
  INV-4, INV-7, and INV-8; native-batching durable admission atomicity and
  lossy-hint recovery; choice-list successor supersession and final-card
  convergence.

  **Ownership and implementation path:** Extend the existing SQLite Primary
  Answer recovery selection with current, final, actionable projection debt
  whose `view_version` exceeds `answer_delivered_version`; keep Answer
  convergence and the outbox as the only delivery effect. Let the shared
  periodic runner notify `RecoverySupervisor` of every cadence tick before
  request coalescing, so its existing `fullScanPending` drain owns the bounded
  follow-up without adding another timer or concurrent recovery pass.

  **Acceptance criteria and verification:** Begin with public-seam Reds proving
  acceptance commit, failed immediate convergence, same-process periodic
  rediscovery, idempotent Answer cleanup, and no Prompt replay. Add a
  timer-during-blocked-target Red proving no concurrent full scan begins and one
  full scan follows after release. Run affected recovery, projection, and
  periodic-runner tests, typecheck, and build; commit atomically with hooks
  disabled, then repeat final dual review, full `npm test`, and Git audit.

  **Blocked by:** T11.

- [x] T13: Normalize actionable Primary Answer projection debt in recovery diagnostics

  **What to build:** Include completed-final actionable Primary Answer debt whose
  durable run-card view is newer than its delivered Answer view in normalized
  recovery diagnostics as `rebuildingProjection`, including oldest-pending age
  and one bounded content-free correlation item. Do not double count a prompt
  already represented by unresolved delivery recovery or pending Answer outbox
  work.

  **Spec references:** Unified-recovery SCN-4, SCN-5, SCN-8, INV-1, INV-3,
  INV-4, INV-7, and INV-8; bounded diagnostics and no-replay requirements.

  **Ownership and implementation path:** SQLite durable state remains the
  diagnostics authority. Reuse the current-binding, completed-card,
  completion-action identity, latest-page, and view-version fences used by the
  periodic Primary Answer recovery selector; add diagnostic-only exclusion
  fences for active delivery-recovery and pending Answer outbox evidence.

  **Acceptance criteria and verification:** Public SQLite tests first fail and
  then pass for count, oldest timestamp, bounded content-free binding/prompt
  identity, both double-count exclusions, and unchanged Prompt execution state.
  Run affected tests, typecheck, build, commit atomically with hooks disabled,
  then repeat final dual review, full `npm test`, architecture/docs audit, and
  Git/message audit.

  **Blocked by:** T12.

## Final Delivery Checks

- Reconcile SCN-1 through SCN-8 and INV-1 through INV-8 against completed
  ticket evidence; no scenario or invariant may rely only on a checked box.
- Review the complete branch diff for accidental prompt replay, weakened exact
  identity checks, cross-context state flattening, non-idempotent delivery,
  stale-target activation, unbounded diagnostic data, or unrelated changes.
- Run all affected focused suites, `npm run typecheck`, `npm run build`, and a
  fresh `npm test`.
- Inspect every new commit body and confirm none contains
  `Trae CLI co-author attribution`.
- Do not push, open a PR, install, or restart without separate user
  authorization.
