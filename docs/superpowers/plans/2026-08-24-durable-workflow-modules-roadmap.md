# Durable Workflow Modules Roadmap

## Vision

Move the bridge from one broad coordinator and store interface to deep workflow
modules with capability-focused persistence, while keeping SQLite durability,
Herdr runtime authority, Lark delivery behavior, and prompt safety unchanged.

## Slices

- [x] **S01: Separate event roles and establish target prompt names** `risk:medium` `depends:[]`
  > After this: inbound work, lifecycle events, and prompt scheduling use distinct interfaces, while existing prompt and steering tests behave unchanged.
- [x] **S02: Persist outbox lanes and expose safe lane health** `risk:high` `depends:[]`
  > After this: an upgraded database retains each delivery lane explicitly and `/status` reports blocked-lane health without exposing payloads.
- [x] **S03: Make lifecycle projections crash-reconstructible** `risk:high` `depends:[S01]`
  > After this: restarting after a lifecycle state commit but before projection delivery reconstructs the correct run-card/topic state and outbox intent without replaying TraeX.
- [x] **S04: Extract binding provisioning workflow** `risk:high` `depends:[S01]`
  > After this: new, selected-project, attach, replace, reset, discovery, and provisioning recovery paths run through one independently tested workflow.
- [x] **S05: Extract operations workflow** `risk:medium` `depends:[S01]`
  > After this: close, resume, rename, model, listing, failure, and dead-letter actions run without coordinator-owned Herdr or rendering logic.
- [x] **S06: Deepen runtime reconciliation** `risk:medium` `depends:[S01,S03]`
  > After this: plugin and periodic observations converge through `HerdrRuntimeReconciler`, which can only persist runtime transitions, publish lifecycle outcomes, and wake durable prompt work.
- [x] **S07: Isolate projection and outbox delivery ports** `risk:medium` `depends:[S02,S03]`
  > After this: projection callers can only record outbound intent and the Lark dispatcher alone controls lane claims, retries, checkpoints, and dead letters.
- [ ] **S08: Replace SyncCoordinator with InboundRouter** `risk:high` `depends:[S04,S05,S06,S07]`
  > After this: normalized Lark ingress delegates commands through `InboundRouter`; no monolithic coordinator or broad `BindingStorePort` consumer remains.
- [ ] **S09: Integrated recovery and operator verification** `risk:medium` `depends:[S08]`
  > After this: full tests, build, migration tests, shutdown/restart scenarios, and a non-mutating real-user smoke prove the assembled architecture.

## Success criteria

- Each application module depends only on its capability ports.
- Duplicate, reordered, or missing prompt wake-ups cannot duplicate execution.
- A prompt that may have reached TraeX is observed, never automatically replayed.
- All user-visible lifecycle state is transactional or reconstructible.
- Outbox order remains strict within a persisted lane and concurrent across lanes.
- Existing databases migrate in place and remain fenced by the instance lease.
- Existing Lark commands and cards retain their behavior and content.

## Key risks

- Splitting interfaces could accidentally split an atomic SQLite transition.
- Projection repair could enqueue duplicate or stale CardKit operations.
- Moving provisioning could change interrupted-pane recovery semantics.
- A rename-only compatibility layer could leave two architectural vocabularies.
- Lane migration could compute a key different from the current query expression.

## Proof strategy

- Use temporary SQLite databases to test migrations, fencing, projection repair,
  outbox idempotency, and restart recovery.
- Reuse integration tests around provisioning, steering, concurrency, operations,
  and reconciliation as behavioral contracts during extraction.
- Add constructor/type tests that prevent new modules from accepting the broad
  store interface.
- Run full Vitest, typecheck, and build after every slice that crosses workflows.
- Use the configured real-user smoke only at the final integration boundary; it
  observes and does not send Lark work.

## Boundary map

- S01 produces `InboundWorkNotifier`, `LifecycleEventPublisher`,
  `PromptWorkScheduler`, `PromptRunWorkflow`, and `PromptRunStore`; S03-S08
  consume these names and contracts.
- S02 produces persisted `lane_key`, `OutboxHealth`, and lane migration behavior;
  S07 consumes them in `LarkOutboxDispatcher`.
- S03 produces projection convergence/checkpoint operations; S06 emits the
  runtime transitions they repair and S07 owns their outbound delivery seam.
- S04 produces `BindingProvisioningWorkflow` and `BindingProvisioningStore`; S08
  delegates provisioning commands to them.
- S05 produces `OperationsWorkflow` and `OperationsStore`; S08 delegates operator
  commands and card actions to them.
- S06 produces `HerdrRuntimeReconciler` and `RuntimeReconciliationStore`; S08 and
  S09 consume its stable start, reconcile, and stop lifecycle.
- S07 produces `ConversationViewProjector`, `OutboundIntentPort`, `OutboxStore`,
  and `LarkOutboxDispatcher`; S08 composes rather than controls them.
- S08 produces the final `InboundRouter` and removes `SyncCoordinator` and the
  remaining broad-store consumers; S09 verifies the complete runtime graph.

## Requirement coverage

| Requirement | Slices |
| --- | --- |
| Separate event roles and durable-before-wake | S01, S03 |
| Capability-focused workflow ports | S01, S04, S05, S06, S07, S08 |
| Crash-safe visible lifecycle state | S03, S06, S07, S09 |
| Persisted lane ordering and diagnostics | S02, S07, S09 |
| Preserve provisioning and operations behavior | S04, S05, S08, S09 |
| Remove monolithic coordinator and broad port | S08 |
| Preserve uncertain-dispatch and local-approval safety | S01, S04, S06, S09 |

## Definition of done

- All nine slices meet their demo line and focused acceptance tests.
- No compatibility wrapper remains for superseded module names.
- `BindingStorePort` and `SyncCoordinator` have no production consumers.
- Architecture, spec, and implementation names agree.
- `git diff --check`, focused tests, full tests, typecheck, and build pass.
- A prompt-to-artifact audit maps every spec acceptance criterion to code and
  current verification evidence.
