# Unified Agent Work and Control Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Feishu-origin and Herdr-origin Agent work one exact, durable
Prompt lifecycle while serializing every equivalent binding mutation through
one fenced control lane.

**Architecture:** Add source identity to `prompt_jobs` and introduce a
`BindingPromptWorkflow` facade over the proven Prompt/adoption/projection
transactions. Bridge-owned Prompts are submitted exactly once with
`prompt_id == native_submission_id == Core submission_id`; Herdr-owned turns
are deterministically adopted and observed without submission. Keep commands
outside Prompt FIFO, but route literal, confirmed natural-language, and CardKit
mutations through the same `CommandIntent` lane and exact frozen target.

**Tech Stack:** TypeScript ESM, Node.js 22+, better-sqlite3, Zod, Vitest,
Herdr Agent Events, Lark CardKit, user systemd.

**Spec:**
`docs/superpowers/specs/2026-09-30-unified-agent-work-and-control-lanes-design.md`

## Global Constraints

- Preserve the dirty shared worktree; never reset or overwrite unrelated edits.
- Never infer Prompt ownership from text, time proximity, queue position,
  newest turn, or active turn.
- Never replay Prompt text after it may have reached TraeX.
- Persist execution or delivery intent before external effects.
- Keep one ordinary Prompt active per Binding; later managed work remains in
  the durable FIFO/native Core queue.
- Herdr-origin work is observation-only and starts as `running/attached`, not a
  fabricated queued submission.
- Keep `/swarm` control work outside Prompt FIFO and preserve admin/creator,
  generation, pane, session, and exact-turn fences.
- Keep Human Review notification-only; do not add remote approval, arbitrary
  terminal input, process kill, or pane kill.
- Do not install Core, install the real TraeX integration, mutate live SQLite,
  or restart Swarm until the source gates pass and the user separately
  authorizes the production steps.
- Use migration versions 62 and 63 unless inspection immediately before the
  change shows either version has been claimed; in that case allocate the next
  two unused monotonically increasing versions and update all fixtures together.

## Review Focus

- A Herdr turn without `submission_id` whose text equals a queued Feishu
  message must create separate work and leave the queued Prompt unchanged;
  Task 3 adds this regression.
- Duplicate socket hints and historical batches for one exact native turn must
  reuse one Prompt and one Answer lifecycle; Task 3 tests restart idempotency.
- A reset or same-name replacement between natural-language request and
  confirmation must reject before any effect; Task 5 tests every frozen fence.
- A CardKit mutation and slash mutation for one Binding must never execute
  concurrently or reorder within their lane; Task 6 adds the cross-ingress
  concurrency test.
- Upgrade with legacy `session_operations` in `running` or `accepted` must not
  replay uncertain work or overlap new CommandIntent execution; Task 7 covers
  the startup barrier.

---

### Task 1: Add durable Prompt source identity

**Files:**

- Modify: `src/domain/prompt.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: `src/store/sqlite/migrations/prompt-turn-migrations.ts`
- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite/prompt-acceptance-store.ts`
- Modify: `src/store/sqlite/prompt-dispatch-store.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/prompt-admission-workflow.test.ts`

**Interfaces:**

- Produces: `PromptIngressSource = "feishu" | "herdr" | "internal"`.
- Produces: `PromptJob.ingressSource: PromptIngressSource` and
  `PromptJob.sourceMessageKey: string`.
- Produces: new managed admissions with
  `nativeSubmissionId === id` before dispatch.
- Consumes: existing `AcceptPromptInput`, Prompt mappers, and migration runner.

- [ ] **Step 1: Write failing schema and admission tests**

  Add tests named `backfills durable Prompt source identity without guessing`
  and `persists the managed Prompt identity invariant at admission`. Assert:
  Feishu rows use the Lark message ID as `sourceMessageKey`, bridge rows have
  `nativeSubmissionId === id` immediately, duplicate source keys are
  idempotent/conflicting by existing payload rules, exact legacy Herdr rows use
  their complete turn tuple, and incomplete legacy rows receive a versioned
  legacy key without text-derived identity.

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

  Run: `npx vitest run tests/sqlite-store.test.ts tests/prompt-admission-workflow.test.ts`

  Expected: FAIL because source fields do not exist and bridge admission leaves
  `native_submission_id` null.

- [ ] **Step 3: Add migration 62 and update the domain mapper**

  Add nullable-compatible `lark_message_id`, non-null new-row
  `ingress_source`, and `source_message_key`, with a unique index on
  `(ingress_source, source_message_key)`. Backfill existing rows without using
  body text. Update `PromptRow`, `mapPrompt`, and `PromptJob` with the exact
  names from the Interfaces block.

- [ ] **Step 4: Establish managed identity during the admission transaction**

  Make `acceptPromptWithEffects` insert `native_submission_id = id` for new
  bridge work. Adjust dispatch persistence to accept the already-equal value,
  reject a different value, and retain no-replay behavior after Core may have
  accepted the submission.

- [ ] **Step 5: Run tests, typecheck, and commit**

  Run:
  `npx vitest run tests/sqlite-store.test.ts tests/prompt-admission-workflow.test.ts tests/primary-prompt-dispatcher.test.ts tests/core-event-recovery.test.ts`

  Run: `npm run typecheck`

  Expected: all pass.

  Commit: `feat: add durable prompt source identity`

### Task 2: Introduce the binding-owned Prompt lifecycle facade

**Files:**

- Create: `src/coordinator/binding-prompt-workflow.ts`
- Modify: `src/coordinator/prompt-admission-workflow.ts`
- Modify: `src/domain/ports/prompt-acceptance.ts`
- Modify: `src/composition/create-primary-runtime.ts`
- Modify: `src/main.ts` only if composition is still performed there
- Modify: `tests/helpers/create-test-router.ts`
- Test: `tests/prompt-admission-workflow.test.ts`
- Test: `tests/inbound-message-routing-workflow.test.ts`
- Test: `tests/architecture-boundaries.test.ts`

**Interfaces:**

- Produces: `BindingPromptWorkflowPort.acceptManagedInput(input:
  ManagedPromptInput): Promise<PromptAcceptanceReceipt | null>`.
- Produces: `ManagedPromptInput` containing binding, body, actor, source key,
  optional parent Prompt, priority, and initial projection context.
- Consumes: Task 1 Prompt source identity and existing atomic
  `acceptPromptWithEffects` behavior.

- [ ] **Step 1: Write failing facade and routing tests**

  Assert that ordinary text, a non-Swarm slash input such as `/plan x`, and an
  initial project Prompt all call `acceptManagedInput`; `/swarm status` and a
  `/swarm` mutation never do. Assert duplicate Feishu input returns the existing
  Prompt without repeating wake, audit, or lifecycle effects.

- [ ] **Step 2: Run the focused tests and confirm the facade is missing**

  Run:
  `npx vitest run tests/prompt-admission-workflow.test.ts tests/inbound-message-routing-workflow.test.ts tests/architecture-boundaries.test.ts`

  Expected: FAIL because `BindingPromptWorkflowPort` does not exist.

- [ ] **Step 3: Implement `BindingPromptWorkflow.acceptManagedInput`**

  Move orchestration ownership, not low-level persistence, from
  `PromptAdmissionWorkflow`. The facade must preserve one transaction for the
  Prompt, initial Run/Answer projection, and outbox intent, followed by
  post-commit lifecycle/audit/wake effects exactly once.

- [ ] **Step 4: Route all managed Primary admission through the facade**

  Keep `InboundMessageRoutingWorkflow` responsible only for classification and
  authorization. Preserve current Worker routing and durable inbound ACK/retry
  behavior.

- [ ] **Step 5: Run tests, architecture checks, and commit**

  Run:
  `npx vitest run tests/prompt-admission-workflow.test.ts tests/inbound-message-routing-workflow.test.ts tests/architecture-boundaries.test.ts`

  Run: `npm run typecheck && npm run architecture:check`

  Expected: all pass.

  Commit: `refactor: centralize binding prompt admission`

### Task 3: Adopt Herdr-origin turns by exact deterministic identity

**Files:**

- Modify: `src/coordinator/binding-prompt-workflow.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/domain/ports/workflow.ts`
- Modify: `src/store/sqlite/external-turn-adoption-store.ts`
- Modify: `src/store/sqlite/capability-graph.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/external-turn-observer.test.ts`
- Test: `tests/pane-thread-lifecycle-integration.test.ts`

**Interfaces:**

- Produces: `BindingPromptWorkflowPort.adoptNativeTurn(input:
  NativeTurnAdoptionInput): ExternalTurnAdoption`.
- Produces: `nativeTurnSourceKey(input)` derived from binding ID/generation,
  pane ID, native session ID, turn ID, and canonical `startedAt`.
- Produces: stable external Prompt IDs derived from the same exact tuple.
- Consumes: Task 1 source uniqueness and Task 2 facade.

- [ ] **Step 1: Replace the old heuristic expectation with failing tests**

  Invert the existing same-text SQLite test: a no-submission Herdr turn creates
  one distinct `execution_origin='herdr'` Prompt and leaves the queued Feishu
  Prompt unchanged. Add duplicate live hint, duplicate historical batch,
  same-turn-ID/different-session, and same-session/different-start tests.

- [ ] **Step 2: Run focused tests and confirm text matching still fails them**

  Run:
  `npx vitest run tests/sqlite-store.test.ts tests/external-turn-observer.test.ts tests/pane-thread-lifecycle-integration.test.ts`

  Expected: FAIL because current adoption can consume the same-text queued row
  and external IDs are randomly allocated.

- [ ] **Step 3: Implement stable source-key and Prompt-ID derivation**

  Put the pure derivation in the Prompt lifecycle module or one focused domain
  helper. Canonicalize the exact tuple with explicit field labels and hash it;
  do not include request text. Use the source-key unique constraint to make
  live and recovered observation idempotent.

- [ ] **Step 4: Remove text/time candidate adoption**

  Retain exact `submission_id` adoption for managed Prompts. For missing
  submission ID, load-or-create only by exact source identity. Delete
  `normalizeExternalRequest` and the queued-body candidate query. Preserve
  fenced supersession and bounded recovery for older exact detached owners.

- [ ] **Step 5: Run tests, typecheck, and commit**

  Run:
  `npx vitest run tests/sqlite-store.test.ts tests/external-turn-observer.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/sqlite-prompt-running-integrity.test.ts`

  Run: `npm run typecheck`

  Expected: all pass with no Prompt replay.

  Commit: `fix: adopt native turns by exact source identity`

### Task 4: Centralize Core observation and idle steering

**Files:**

- Modify: `src/coordinator/binding-prompt-workflow.ts`
- Modify: `src/coordinator/transcript-observer.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/coordinator/prompt-turn-executor.ts`
- Modify: `src/coordinator/turn-control-workflow.ts`
- Modify: relevant Prompt observation ports under `src/domain/ports/`
- Modify: composition under `src/composition/`
- Test: `tests/transcript-observer.test.ts`
- Test: `tests/transcript-observer-identity.test.ts`
- Test: `tests/external-turn-observer.test.ts`
- Test: `tests/core-event-recovery.test.ts`
- Test: `tests/turn-control-workflow.integration.test.ts`

**Interfaces:**

- Produces: `BindingPromptWorkflowPort.applyCoreObservation(input:
  PromptCoreObservation): PromptObservationReceipt`.
- Extends: `acceptManagedInput` with explicit `priority` and source identity for
  idle steering.
- Consumes: Tasks 2 and 3 Prompt ownership.

- [ ] **Step 1: Write failing origin-parity and idle-steer tests**

  Assert bridge and Herdr origins apply Human Message, Agent output, tool, Goal,
  Task List, blocked, completed, and failed observations through the same
  lifecycle owner. Assert idle steering gets atomic initial projection,
  `PromptQueued`, audit, idempotency, and one scheduler wake; active steering
  remains exact-turn control and unsupported where native steering is absent.

- [ ] **Step 2: Run focused tests and confirm independent settlement paths**

  Run:
  `npx vitest run tests/transcript-observer.test.ts tests/transcript-observer-identity.test.ts tests/external-turn-observer.test.ts tests/core-event-recovery.test.ts tests/turn-control-workflow.integration.test.ts`

  Expected: FAIL on the new facade and idle-steering effect assertions.

- [ ] **Step 3: Implement `applyCoreObservation` and route observers through it**

  Keep adapters responsible for reading/parsing and the event projector
  responsible for reducers. Move durable Prompt owner selection and terminal
  settlement behind the facade. Preserve atomic Core inbox ACK/projection,
  projected-owner repair, projection-gap recovery, and bounded exact
  `not_found` settlement.

- [ ] **Step 4: Route idle steering through `acceptManagedInput`**

  Perform the existing exact-active-turn decision first. Only the no-active-turn
  branch becomes a priority managed Prompt; never downgrade active stop/steer
  into Prompt text.

- [ ] **Step 5: Run tests, architecture checks, and commit**

  Run the Step 2 suite, then:
  `npm run typecheck && npm run architecture:check`

  Expected: all pass.

  Commit: `refactor: unify binding prompt lifecycle`

### Task 5: Fence natural-language confirmation by frozen target

**Files:**

- Modify: `src/domain/natural-language-command-confirmation.ts`
- Modify: `src/domain/ports/natural-language-command-confirmation.ts`
- Modify: `src/coordinator/natural-language-command-workflow.ts`
- Modify: `src/coordinator/swarm-command-context-resolver.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite/natural-language-command-confirmation-store.ts`
- Test: `tests/natural-language-command-workflow.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**

- Produces: versioned Zod-validated `FrozenCommandTarget` discriminated union
  for Swarm and Worker targets.
- Produces: `ResolvedCommandTarget` in the same canonical shape.
- Changes: confirmation consumption receives the currently resolved target and
  atomically compares it with `frozenTarget` before intent creation.

- [ ] **Step 1: Write failing frozen-target and migration tests**

  Cover an unchanged target, same-name replacement, binding generation change,
  pane/session change, active-turn change, Worker session generation change,
  authorization loss, cancellation by the original actor, malformed JSON, and
  a legacy pending row without frozen identity.

- [ ] **Step 2: Run focused tests and confirm target drift is accepted today**

  Run:
  `npx vitest run tests/natural-language-command-workflow.test.ts tests/sqlite-store.test.ts tests/swarm-command-context-resolver.test.ts`

  Expected: FAIL because confirmation-time resolution is not compared with the
  stored target.

- [ ] **Step 3: Add migration 63 and the canonical target type**

  Add `frozen_target_json`. New pending rows require valid versioned JSON.
  Existing terminal rows may remain null. Atomically cancel legacy pending rows
  with `legacy_incomplete_frozen_identity`; do not infer old target identity
  from current names or runtime state.

- [ ] **Step 4: Enforce exact target equality at confirmation consumption**

  Resolve current authorization first, canonicalize it, then let the store
  compare and consume in one transaction. A mismatch settles as
  `cancelled/stale_context`, emits no CommandIntent, and invokes no instance or
  external effect. Cancellation remains actor/chat fenced and does not require
  the target to remain live.

- [ ] **Step 5: Run tests, typecheck, and commit**

  Run the Step 2 suite and `npm run typecheck`.

  Expected: all pass.

  Commit: `fix: fence confirmed commands by frozen target`

### Task 6: Admit CardKit mutations into the CommandIntent lane

**Files:**

- Modify: `src/domain/swarm-command.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports/swarm-command.ts`
- Modify: `src/coordinator/swarm-command-gateway.ts`
- Modify: `src/coordinator/command-intent-dispatcher.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Create: `src/store/sqlite/card-command-admission-store.ts`
- Modify: `src/store/sqlite/workflow-stores.ts`
- Modify: `src/store/sqlite/capability-graph.ts`
- Modify: `src/composition/create-command-control-runtime.ts`
- Test: `tests/card-interaction-integration.test.ts`
- Test: `tests/swarm-command-gateway.test.ts`
- Test: `tests/command-intent-dispatcher.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/architecture-boundaries.test.ts`

**Interfaces:**

- Produces: `CardCommandAdmissionStore.acceptCardCommandIntent(input)` that
  consumes the interaction and creates/reuses CommandIntent, Command Status,
  and outbox intent in one transaction.
- Adds: internal card-only `archive` command with primary-session scope,
  creator-and-administrator authorization, and `safe-before-effect` replay.
- Consumes: existing `SwarmCommandGateway` context resolution and
  `CommandIntentDispatcher` lane execution.

- [ ] **Step 1: Write failing atomic-admission and lane-order tests**

  Cover repeated callback idempotency, wrong actor, expired interaction, stale
  generation/pane/session, transaction rollback, card rename followed by slash
  reset in `binding:<id>` order, one executing intent per lane, exact-turn stop
  revalidation, and zero `prompt_jobs` created by card controls. Assert
  status/form/continuation actions remain query or Prompt behavior and do not
  create control intents.

- [ ] **Step 2: Run focused tests and confirm the independent lanes fail them**

  Run:
  `npx vitest run tests/card-interaction-integration.test.ts tests/swarm-command-gateway.test.ts tests/command-intent-dispatcher.test.ts tests/concurrency-controls.integration.test.ts tests/sqlite-store.test.ts tests/architecture-boundaries.test.ts`

  Expected: FAIL because card mutations still create `session_operations`.

- [ ] **Step 3: Implement atomic CardKit command admission**

  Map stop, reset, archive, resume, replace, pane close, rename, and reattach to
  internal control commands. Reject model as currently unsupported and keep
  session status as an authoritative query. Use
  `interaction:<interactionId>:<commandKind>` for source idempotency.

- [ ] **Step 4: Execute card controls through the existing dispatcher**

  Add only the card-only archive handler required by the mapping. Reuse existing
  control policies and exact context revalidation. Return callback toast after
  durable admission; project Command Status asynchronously through the existing
  outbox.

- [ ] **Step 5: Run tests, typecheck, build, and commit**

  Run the Step 2 suite, then `npm run typecheck && npm run build`.

  Expected: all pass.

  Commit: `refactor: unify card and text control lanes`

### Task 7: Retire new writes to the legacy Session-operation lane

**Files:**

- Modify: `src/coordinator/session-operation-workflow.ts`
- Modify: `src/coordinator/startup-recovery-workflow.ts`
- Modify: `src/composition/create-command-control-runtime.ts`
- Modify: `src/domain/ports/workflow.ts`
- Modify: Session-operation health/retention adapters only as required
- Test: `tests/session-operation-workflow.test.ts`
- Test: `tests/startup-recovery-workflow.test.ts`
- Test: `tests/health-server.test.ts`

**Interfaces:**

- Produces: legacy recovery with no new-admission method and no periodic
  scanner after startup convergence.
- Consumes: Task 6 as the only CardKit mutation admission path.

- [ ] **Step 1: Write failing upgrade and startup-barrier tests**

  Assert legacy `running` becomes uncertain without handler invocation;
  accepted rows drain to terminal before CommandIntent recovery/start; new
  ingress starts only after that barrier; legacy and new control effects cannot
  overlap; historical rows remain readable by health and retention.

- [ ] **Step 2: Run focused tests and confirm both scanners can overlap today**

  Run:
  `npx vitest run tests/session-operation-workflow.test.ts tests/startup-recovery-workflow.test.ts tests/health-server.test.ts`

  Expected: FAIL on the new startup ordering and no-new-admission assertions.

- [ ] **Step 3: Convert SessionOperationWorkflow to startup-only legacy recovery**

  Preserve `running -> uncertain`. Drain legacy accepted work sequentially to a
  terminal state before opening new inbound traffic. Do not convert either
  state into CommandIntent and do not drop the table in this release.

- [ ] **Step 4: Remove the legacy concurrent runtime path**

  Stop new `session_operations` writes, remove its periodic missed-wake scanner,
  and preserve read-only audit/retention support for terminal history.

- [ ] **Step 5: Run tests, full suite, and commit**

  Run the Step 2 suite, then `npm test && npm run typecheck && npm run build`.

  Expected: all pass.

  Commit: `refactor: retire legacy session operation admission`

### Task 8: Update architecture, operator docs, and TODO evidence

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/domain/primary-session/CONTEXT.md`
- Modify: `docs/feishu-group-usage.md`
- Modify: `docs/superpowers/README.md`
- Modify: `TODO.md`
- Remove: only implementation symbols/tests proven unreachable by reference
  search after Tasks 1–7

**Interfaces:**

- Consumes: all preceding behavior and test evidence.
- Produces: current documentation for Prompt sources, control lanes, migration,
  no-replay recovery, and live acceptance state.

- [ ] **Step 1: Update behavioral documentation**

  Document exact source identity, three-way managed identity, deterministic
  Herdr adoption, independent Prompt/control ordering, unified control
  admission, frozen confirmation targets, and legacy upgrade behavior.

- [ ] **Step 2: Remove only newly unreachable compatibility code**

  Use `rg` references before each removal. Keep the `session_operations` table,
  terminal record mapper, retention, and failure reporting for at least this
  release. Do not delete compatibility migrations.

- [ ] **Step 3: Update TODO truthfully**

  Mark the Binding-boundary source item complete only after Tasks 1–7 and full
  source validation pass. Keep all production acceptance items unchecked until
  installed-runtime evidence is captured.

- [ ] **Step 4: Run documentation and dead-code gates**

  Run:
  `npm run docs:audit && npm run architecture:check && git diff --check`

  Expected: all pass.

- [ ] **Step 5: Commit**

  Commit: `docs: document unified prompt and control flows`

### Task 9: Complete release validation and prepare the operator gate

**Files:**

- Modify: implementation files only if validation reveals an in-scope defect
- Modify: `TODO.md` only with verified source-gate evidence

**Interfaces:**

- Consumes: immutable Core candidate with TraeX integration, historical turn
  index, and native Goal support; Swarm Tasks 1–8.
- Produces: immutable, fully verified Core and Swarm candidates plus a captured
  pre-deployment baseline.

- [ ] **Step 1: Run the complete Swarm source gate**

  Run:
  `npm test && npm run typecheck && npm run architecture:check && npm run docs:audit && npm run build && npm run public:audit`

  Run: `git diff --check`

  Expected: every command passes.

- [ ] **Step 2: Run the complete isolated Core gate**

  In `.tmp-core-worktrees/traex-integration`, run the repository-required
  formatting, Clippy/check, schema freshness, unit, CLI, integration, and
  release-build gates. Test TraeX integration install/status/idempotent
  reinstall/uninstall against a temporary home. Do not touch the production
  binary or real TraeX home.

- [ ] **Step 3: Build immutable release artifacts**

  Record the Core binary SHA-256 and Swarm version/build ID/package checksum.
  Re-run candidate doctor against an isolated TraeX home and configuration.

- [ ] **Step 4: Capture the live read-only baseline**

  Record current service identity, MainPID, health/readiness, Prompt counts,
  exact turn-recovery debt, projection gaps, the 32 previously blocked outbox
  rows, Core capabilities, and TraeX integration status. Use only supported
  status/log commands and SQLite `mode=ro` queries.

- [ ] **Step 5: Stop at the production authorization gate**

  Report candidate identities, live safety blockers, and the exact Core
  handoff, integration install, Swarm install, and `swarm:restart -- --force`
  sequence. Obtain fresh explicit authorization before executing it.

### Task 10: Deploy and close the remaining live acceptance items

**Files:**

- Modify: `TODO.md` only after each production criterion is proven
- Do not modify live SQLite directly

**Interfaces:**

- Consumes: Task 9 approved artifacts and explicit production authorization.
- Produces: deployed Core/TraeX integration/Swarm identity and evidence closing
  the remaining three logical TODO items.

- [ ] **Step 1: Install Core and TraeX integration through supported paths**

  Preserve existing panes with the Core live-handoff procedure. Verify
  `historical_turn_index_recovery_v1`, native Goal support, and
  `traex: current (v1)` before changing Swarm.

- [ ] **Step 2: Install Swarm and perform the explicitly authorized restart**

  Run `./install.sh`, verify the staged immutable build, then use
  `npm run swarm:restart -- --force` only if the authorization explicitly
  covers the force gate and the captured running-Prompt state.

- [ ] **Step 3: Prove passive recovery before sending a new message**

  Verify startup/periodic recovery moves the baseline 32 lane-blocked effects
  to dismissed or delivered authoritative replacements, clears related
  quarantines with audit evidence, and introduces no new owner-scoped
  idempotency conflict. The user visually checks the cards but sends no wake-up
  message.

- [ ] **Step 4: Prove exact Herdr-origin recovery**

  First observe the existing recovery backlog converge or boundedly settle.
  Then have the user start one unique direct Herdr turn in a newly integrated
  TraeX session that emits Human Message, Agent output, tool, Goal, Task List,
  and terminal completion. Assert one exact Herdr Prompt, one execution, one
  Answer lifecycle, delivered outbox, and no text matching or replay.

- [ ] **Step 5: Prove the Binding boundary from Feishu**

  Have the user send A, then B while A is active, then a non-Swarm slash input
  C, and finally `/swarm status`. Assert A/B/C each have one inbound, Prompt,
  Core submission, exact owner, and Answer in order; the status query creates no
  Prompt or TraeX turn.

- [ ] **Step 6: Close TODO only from durable evidence**

  Require `multiple_running_turns=0`, scoped blocked lanes zero, scoped turn
  recovery zero, no replay/duplicate Answer/identity mismatch, and ready health
  or an explicitly unrelated degraded reason. Record exact evidence and check
  the final three logical TODO items. Commit: `docs: record unified flow live acceptance`.
