# Per-pane identity, shared tabs, and Delivery Rings plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-13-per-pane-delivery-rings.md`.

Gate 1 selected the per-physical-pane design. Gate 2 approved the specification
interactively by user choice `A` at `2026-10-13T13:35:24Z`.

Implementation workspace: `/tmp/herdr-agent-swarm-delivery-95ab57b0`, branch
`feat/per-pane-delivery-rings`, starting revision
`95ab57b09fe455e363ea1aa800802ccb852d9e6d`. This existing isolated worktree is
required because the original `main` worktree contains five user-staged files,
including an overlapping Prepared Delivery implementation. Those files remain
outside this branch.

Fresh planning baseline records are `bf5a762e82c841a9b6bec99f5ed073ce`
(180 focused tests), `34f4513fb28f491782ed4f319980cba9` (typecheck),
`cdd6638dd6b840ea97f7a7d9b1dbdfaa` (build), and
`394ee64fae324d8ab90dcf80efd7804e` (architecture). The request-wide
no-subagent instruction selects `main-local` execution for every ticket;
therefore every durable wave is a singleton and no worker dispatch is allowed.

## Wave W1: `T1`

### - [x] T1: Canonicalize new pane identities and shared-tab placement

| Field | Content |
| --- | --- |
| What to build | Deliver canonical Group Token and Pane Identity behavior for newly created managed Primary and Worker panes: Primary/default labels derive from the authoritative pane token, Worker labels derive from the parent Group Token, the tab label is the Group Token, and a new Worker splits the exact parent pane in the same tab instead of creating a dedicated tab. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded domain plus Herdr adapter/application behavior with fake command-runner and PaneHost seams; request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | Primary Session and Worker Runtime consume a pure Pane Identity module. Provisioning and Instance Control choose the role and exact parent; PaneHost carries an exact anchor and desired labels; the Herdr adapter performs split/rename/tab-label translation and returns normalized observations. Runtime IDs remain authoritative. |
| Mutation ownership | src/domain/pane-title.ts, src/domain/runtime-observation.ts, src/domain/ports/pane-host.ts, src/domain/ports/external.ts, src/adapters/herdr-adapter.ts, src/coordinator/binding-provisioning-workflow.ts, src/coordinator/binding-provisioning/managed-binding-lifecycle.ts, src/coordinator/instance-control-workflow.ts, src/coordinator/session-administration-workflow.ts, tests/pane-title.test.ts, tests/herdr-adapter.test.ts, tests/instance-control.integration.test.ts, tests/provisioning-recovery.test.ts, tests/herdr-discovery-integration.test.ts, tests/pane-thread-lifecycle-integration.test.ts |
| Exclusions | Existing live-pane movement, topology persistence, Delivery Scope changes, Outbox schema, Feishu cards and deployment. |
| Isolation | Main-local mutation in the selected isolated worktree at wave base `95ab57b09fe455e363ea1aa800802ccb852d9e6d`. |
| Concurrency conflicts | T2, T3 |
| Verification seam | Pure identity tables; fake Herdr CLI arguments/receipts; Instance Control integration proving exact parent split and same-tab identity; architecture import check. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | Managed Primary renders `<token>-main`; direct-pane policy renders `<token>-default-main`; Worker renders `<primary-token>-<name>` and is allocated by splitting the exact parent pane in its tab. Invalid/missing tokens and stale parents fail closed. `/swarm rename` may change the Lark-facing title but cannot mutate canonical runtime pane/tab identity. Run pane-title, Herdr adapter, Instance Control, Session Administration and provisioning tests, typecheck, build, architecture check and diff check. |
| Verification commands | `npx vitest run tests/pane-title.test.ts tests/herdr-adapter.test.ts tests/instance-control.integration.test.ts tests/herdr-discovery-integration.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/provisioning-recovery.test.ts --maxWorkers=1`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed 180/180 affected tests pass, typecheck exit 0, build exit 0, architecture check valid for 536 source files, and diff check exit 0. RED evidence covered missing identity functions, old dedicated Worker tabs, non-exact split anchoring, absent canonical pane/tab labels, and runtime-label mutation through `/swarm rename`. |
| Commits | 581d8255eef5ff2f59b4e762485594843381b1d7 |
| Blocked by | None |

## Wave W2: `T2`

### - [x] T2: Persist identity-fenced Pane Topology Intents

| Field | Content |
| --- | --- |
| What to build | Add the durable Pane Topology Intent lifecycle and normalized Herdr move/rename receipt seam so one expected runtime can be converged without replaying an uncertain layout effect. |
| Spec references | SCN-4, SCN-7, INV-3, ARCH-2, ARCH-4 |
| Dependencies | T1 |
| Delegation eligibility | Crosses a new SQLite lifecycle and external Herdr effect; bounded by real temporary-database and fake command-runner tests, but request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | Worker Runtime owns intent eligibility; SQLite owns frozen expected/desired topology, CAS claim and settlement; PaneHost owns a narrow converge/move interface; the adapter owns pane move/rename/tab rename and normalized changed-pane receipts. Existing close/control operations remain separate. |
| Mutation ownership | src/domain/pane-topology-intent.ts, src/domain/ports/pane-topology.ts, src/domain/ports/pane-host.ts, src/domain/ports/external.ts, src/adapters/herdr-adapter.ts, src/runtime/herdr/pane-host.ts, src/store/sqlite/pane-topology-store.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/capability-graph.ts, src/store/sqlite-store-bundle.ts, tests/pane-topology-store.test.ts, tests/herdr-adapter.test.ts, tests/pane-host.test.ts, tests/sqlite-migrations.test.ts |
| Exclusions | Topology scheduling/reconciliation, Worker runtime-reference adoption, Delivery Scope changes, live Herdr mutation and deployment. |
| Isolation | Main-local mutation in the same isolated worktree after T1. |
| Concurrency conflicts | T1, T3, T4 |
| Verification seam | Real SQLite intent reserve/claim/reopen/settle CAS tests and fake Herdr move responses including changed Pane ID, transport error plus exact observation, and ambiguous response rejection. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | Intent is durable before effect; duplicate reservation converges; one claimant wins; exact receipt/observation settles; proven old topology permits bounded retry; ambiguous evidence remains uncertain; no close/control record is reused. Run topology store, migration and Herdr adapter tests, typecheck, build, architecture check and diff check. |
| Verification commands | `npx vitest run tests/pane-topology-store.test.ts tests/herdr-adapter.test.ts tests/pane-host.test.ts tests/sqlite-migrations.test.ts --maxWorkers=1 -t "Pane Topology\|pane lifecycle\|moves one pane\|ordered registry\|pane-topology"`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Pane Topology reserve/duplicate/claim/uncertain/rearm/success/reopen and competing-handle tests pass; adapter and PaneHost move receipt tests pass; ordered migration registry test passes; typecheck and build exited 0; architecture imports were valid for 539 source files; diff check exited 0. RED evidence covered missing durable modules, unclassified schema policy, wrong-tab settlement, uncertain target adoption, missing move normalization and missing PaneHost seam. |
| Commits | a94c2ba9dd1961b6c5ac44b6c8501fe0855f58c6 |
| Blocked by | T1 |

## Wave W3: `T3`

### - [x] T3: Converge existing and directly created panes safely

| Field | Content |
| --- | --- |
| What to build | Integrate Pane Topology reconciliation for existing managed Primary/Worker panes and Herdr-created default Primary panes, including idle-only Worker move, exact terminal/session relocation, and adoption before ordinary missing-pane termination. |
| Spec references | SCN-1, SCN-3, SCN-4, SCN-7, INV-1, INV-2, INV-3, ARCH-2, ARCH-5 |
| Dependencies | T1, T2 |
| Delegation eligibility | Stateful cross-context recovery with real SQLite and fake Herdr snapshots; independently testable but request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | A Pane Topology reconciler runs before Instance Runtime missing-pane handling. It reserves/claims intents, defers active or uncertain Workers, locates a moved runtime only by a unique exact terminal plus Agent-session match, adopts the receipt Pane ID via instance generation CAS, then lets ordinary runtime reconciliation resume. Direct-pane adoption uses its own token and `default-main` role. |
| Mutation ownership | src/coordinator/pane-topology-reconciler.ts, src/coordinator/instance-runtime-reconciler.ts, src/coordinator/binding-runtime-converger.ts, src/coordinator/binding-reconciliation-pass.ts, src/store/sqlite/instance-store.ts, src/domain/ports/instance.ts, src/composition/create-bridge-runtime.ts, src/composition/managed-bridge-runtime.ts, tests/pane-topology-reconciler.test.ts, tests/instance-runtime-reconciler.test.ts, tests/binding-reconciliation-pass.test.ts, tests/managed-bridge-runtime.test.ts |
| Exclusions | Delivery routing, Outbox schema, moving an active/uncertain Worker, terminal input, process replacement and production pane movement. |
| Isolation | Main-local mutation in the same isolated worktree after T2. |
| Concurrency conflicts | T1, T2, T4 |
| Verification seam | Real SQLite plus fake full-workspace snapshots proving intent-before-effect, idle gating, restart recovery, new Pane ID adoption, duplicate/ambiguous match refusal and topology-before-termination ordering. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | Current managed/direct identities converge; active/uncertain Workers remain untouched; exact move evidence updates runtime reference without generation/session loss; ambiguous or missing evidence preserves an uncertain intent and Worker; ordinary reconciliation never terminalizes before topology recovery. Run topology, instance-runtime, binding-reconciliation and managed-runtime tests, typecheck, build, architecture check and diff check. |
| Verification commands | `npx vitest run tests/pane-topology-store.test.ts tests/pane-topology-reconciler.test.ts tests/instance-runtime-reconciler.test.ts tests/binding-reconciliation-pass.test.ts tests/managed-bridge-runtime.test.ts tests/herdr-adapter.test.ts tests/pane-host.test.ts --maxWorkers=1`; `npx vitest run tests/sqlite-migrations.test.ts --maxWorkers=1`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; plan artifact checker; `git diff --check` |
| Verification results | Main first observed 149/149 affected tests pass, then delivery review added a real effect-boundary RED: an uncertain Worker that became active replayed `movePane` twice instead of once. Green adds current owner/parent/runtime fences, unique frozen-source topology equality and idle/active-turn gating; the final matrix passed 7 files / 152 tests, including pending-source drift, partial effect, ambiguity, changed Pane ID adoption and topology-before-termination. The full migration suite passed 80/80 tests; typecheck exited 0; build generated `sha256:49ae7a4b217954307dd38cc32cb43193448035a5cebffed9f68fe071e2691d69`; 540 source files passed architecture check; plan and diff checks exited 0. |
| Commits | 7e790e4fcc64f5712cecdc8c78053bbc630c5c71 |
| Blocked by | T1, T2 |

## Wave W4: `T4`

### - [x] T4: Freeze Worker scope and parent-pane fences separately

| Field | Content |
| --- | --- |
| What to build | Expand Outbox identity with immutable `delivery_parent_pane_id`, backfill historical Worker rows without changing their scope, and route every new Worker effect to its exact current runtime pane while retaining the parent Binding pane fence. |
| Spec references | SCN-5, SCN-6, SCN-7, INV-4, INV-5, INV-6, ARCH-3, ARCH-4 |
| Dependencies | T2 |
| Delegation eligibility | Crosses domain routing and SQLite migration/reservation with deterministic tests; request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | Delivery and Operations owns the route value and immutable Outbox columns. Route construction receives Worker workspace/pane separately from parent Binding pane. Migration backfills the parent field from legacy Worker scope. New reservation fails closed without an exact runtime and never emits the legacy shape. |
| Mutation ownership | src/domain/delivery-scope.ts, src/domain/delivery.ts, src/domain/types.ts, src/domain/ports/outbox.ts, src/store/sqlite/outbox-queue-store.ts, src/store/sqlite-records.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations/card-outbox-migrations.ts, tests/delivery-scope.test.ts, tests/prepared-delivery-reservation.test.ts, tests/sqlite-migrations.test.ts, tests/sqlite-store.test.ts |
| Exclusions | Prepared Delivery claim/target predicates, Ring concurrency assertions, topology movement, legacy scope contraction and deployment. |
| Isolation | Main-local mutation in the same isolated worktree after T3; migration ordering builds on T2. |
| Concurrency conflicts | T2, T3, T5 |
| Verification seam | Domain route tables and real migration/reservation round trips inspecting immutable scope, parent pane, owner fence, prepared plan and effect evidence before/after reopen. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | Historical Worker rows retain original scope/order/plan/checkpoints and gain the exact parent pane; new rows use Worker runtime pane plus parent pane; Primary/Global rows keep null parent pane; missing/stale runtime fails closed; immutable-claim trigger covers the new field. Run delivery-scope, reservation and migration tests, typecheck, build, architecture check and diff check. |
| Verification commands | `npx vitest run tests/delivery-scope.test.ts tests/prepared-delivery-reservation.test.ts tests/sqlite-migrations.test.ts --maxWorkers=1`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; plan artifact checker; `git diff --check` |
| Verification results | Main observed the intended RED across route, reservation and migration seams: Worker scope was the Primary Pane, the parent Pane had no independent Outbox column, and marker 134 was absent. Green passed 3 files / 127 tests. Marker 134 preserves historical scope key, scope pane, state, attempt count, effect certainty and frozen plan hash while backfilling `delivery_parent_pane_id`; new Worker reservations use their exact runtime Pane, Primary/Global keep null parent, missing runtime fails closed, and claim immutability rejects parent-Pane mutation. Typecheck passed; build generated `sha256:6c08e8c35bbf0723b00326cf77f3778d2c6fbb316419e0b52c1f5eef32cc1516`; 541 source files passed architecture check; plan and diff checks exited 0. A diagnostic full `sqlite-store.test.ts` run remained red at the intentionally excluded T5 claim/target predicates that still equate Worker scope with parent Pane, together with pre-existing bounded-retry expectation drift; W5 owns that integration convergence before final full-suite delivery. |
| Commits | 555aa7c0de7701a1e4be2811c7fb01952f995f10 |
| Blocked by | T2 |

## Wave W5: `T5`

### - [x] T5: Execute mixed legacy and per-pane Worker Rings

| Field | Content |
| --- | --- |
| What to build | Update Prepared Delivery claim, target, recovery and checkpoint predicates so new Worker effects execute in independent physical-pane Rings while legacy parent-scoped Worker effects remain safely claimable and settle unchanged. |
| Spec references | SCN-5, SCN-6, SCN-7, INV-4, INV-5, INV-6, INV-7, ARCH-3, ARCH-4 |
| Dependencies | T4 |
| Delegation eligibility | High-risk SQLite claim/ACK/recovery behavior with real-store interleaving tests; request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | Prepared Delivery validates Worker runtime pane against scope and parent Binding against the separate frozen parent pane. Shared helper predicates replace assumptions that scope is parent. Legacy rows are recognized only by the backfilled equal scope/parent shape. Existing prerequisites/conflict/recovery rules remain the only cross-Ring order. |
| Mutation ownership | src/store/sqlite/prepared-delivery-store.ts, src/store/sqlite/outbox-recovery/, src/events/ring-delivery-engine.ts, src/domain/ports/prepared-delivery.ts, tests/prepared-delivery-store.test.ts, tests/ring-delivery-hot-path.test.ts, tests/ring-delivery-recovery.test.ts, tests/t8-worker-main-thread-ring.test.ts, tests/t8-worker-task-stream-ring.test.ts |
| Exclusions | New retry policy, global permit/cooldown changes, replay/rescope of historical effects, topology mutation and deployment. |
| Isolation | Main-local mutation in the same isolated worktree after T4. |
| Concurrency conflicts | T4, T6 |
| Verification seam | Real temporary SQLite interleavings plus fake Gateway: Primary and two Workers form three Rings; same-pane effects serialize; four global permits remain; prerequisites cross Rings; legacy rows claim/ACK/recover; stale owner/scope/parent fences lose atomically. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | Worker activity cannot block Primary merely by sharing a parent; each physical pane remains serial; legacy rows preserve no-replay behavior; possible-effect/checkpoint evidence is never bypassed; missing or changed Worker/parent identities fail closed. Run Prepared Delivery, Ring recovery/hot-path and T8 Worker suites, typecheck, build, architecture check and diff check. |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts tests/t8-worker-main-thread-ring.test.ts tests/t8-worker-task-stream-ring.test.ts --maxWorkers=1`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; plan artifact checker; `git diff --check` |
| Verification results | Main observed the cross-ticket RED in Worker owner, target and Conversation Page claims that still equated `scope_pane_id` with the parent Pane. Green passed 5 files / 202 tests. Primary plus two Workers discover three Rings; new Worker claims require exact runtime workspace/Pane plus a separate exact parent Pane; same-Pane effects remain serial under the unchanged four global permits; prerequisites and conflict isolation remain authoritative. A marker-134 historical equal-scope Worker row is hydrated, claimed and ACKed without rescope. Worker Main, Task, Human Review, Completion Review, recovery and reopen paths use the Worker Pane while retaining the parent fence. Uncertain effects dead-letter immediately without replay; confirmed invalid targets use existing semantic recovery, while ordinary rejected/not-started failures retain bounded retry. Typecheck passed; build generated `sha256:a9ccd096515997716bceb6272d52f35936f7158b105442c1c635e28bd65b03e6`; 541 source files passed architecture check; plan and diff checks exited 0. |
| Commits | c36ab9d45c9bd4d8ce212a9a91b2a5491f8326a6 |
| Blocked by | T4 |

## Wave W6: `T6`

### - [x] T6: Expose topology and per-pane Ring convergence evidence

| Field | Content |
| --- | --- |
| What to build | Add bounded operational evidence and authoritative docs for Pane Identity, topology-intent state, legacy Worker scope debt and per-pane Ring behavior, then provide deterministic smoke assertions used before live mutation/deployment. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, ARCH-5 |
| Dependencies | T3, T5 |
| Delegation eligibility | Read-model/docs integration with bounded status fixtures; request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | Operations query owns bounded counts only; health/status assembly exposes no payload or actor data; domain context docs replace the obsolete parent-Pane Worker Ring language; smoke evidence compares exact Primary/Worker scope keys and topology intent state without moving panes. |
| Mutation ownership | src/store/sqlite/operations-store.ts, src/domain/types.ts, src/health/health-snapshot-collector.ts, docs/architecture.md, docs/domain/primary-session/CONTEXT.md, docs/domain/worker-runtime/CONTEXT.md, docs/domain/delivery-operations/CONTEXT.md, docs/feishu-group-usage.md, tests/health-snapshot-collector.test.ts, tests/documentation-audit.test.ts, tests/real-user-smoke.test.ts |
| Exclusions | Production move, installation, restart, force restart, push, cleanup of historical debt and unrelated latency optimizations. |
| Isolation | Main-local mutation in the same isolated worktree after T3 and T5. |
| Concurrency conflicts | T5 |
| Verification seam | Status fixture assertions, documentation audit and non-mutating smoke output proving per-pane counts, legacy debt, topology states and exact scope identities without sensitive payloads. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | Status reports bounded topology pending/uncertain and legacy parent-scope debt; docs use Group Token, Pane Identity, Pane Topology Intent and per-pane Delivery Scope consistently; smoke detects wrong shared scope before deployment. Run health/status, docs audit and smoke tests, then typecheck, build, architecture check and diff check. |
| Verification commands | `npx vitest run tests/health-snapshot-collector.test.ts tests/health-server.test.ts tests/real-user-smoke.test.ts tests/documentation-audit.test.ts --maxWorkers=1`; `npm run docs:audit`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; plan artifact checker; `git diff --check` |
| Verification results | Main observed the RED as absent Pane Topology, Worker Pane-scope and legacy debt fields plus implementation docs that still said every Worker used the parent Ring. Green passed 4 files / 82 tests and documentation audit. `/status` exposes only bounded pending/executing/uncertain/recoverable topology counts, Primary/Worker Pane-scope counts and nonterminal legacy Worker scope debt; uncertain topology degrades status without changing readiness. The read-only smoke snapshot includes those counters and no payload or actor data. Delivery review then found the smoke did not perform ARCH-5's exact scope comparison; its focused RED failed because `inspectDeliveryScopeEvidence` was absent, and Green now opens the configured SQLite database read-only with a 5-second busy timeout, compares complete Primary/Worker runtime and parent fences, and emits only aggregate valid/legacy/invalid counts. Architecture, Primary Session, Worker Runtime, Delivery Operations and Feishu usage docs define Group Token, Pane Identity, Pane Topology Intent, idle-only convergence and per-actual-Pane Delivery Scope consistently. Typecheck passed; build generated `sha256:cbda379e3874e5dbab66c158107f01d8bbee3ecb9a4b9558ceb735153ae57451`; 541 source files passed architecture check; plan and diff checks exited 0. No live smoke, installation, restart or Pane movement was performed. |
| Commits | 8fdb8ef0d29254b9917f61dee72a4e2f7868b2d5, 8a49d86b4e822c09eab4016b559607e3b6a1465b |
| Blocked by | T3, T5 |

## Wave W7: `T7`

### - [x] T7: Preserve a coalesced prior Turn Card with an explicit merged state

| Field | Content |
| --- | --- |
| What to build | Keep active-Turn steer/coalescing unchanged while terminally updating an already delivered prior Turn Card when a later Human Message closes its Segment before any final assistant event. Render a grey `已并入后续输入` state, preserve visible commentary/Tool activity, and explain that no independent final was produced. |
| Spec references | SCN-8, INV-8, ARCH-6 |
| Dependencies | T5 |
| Delegation eligibility | Bounded presentation plus SQLite claim-fence repair with one real-store end-to-end seam; request-wide no-subagent instruction selects local execution. |
| Delegation mode | main-local; explicit request-wide no-subagent opt-out |
| Ownership and implementation path | Turn Card presentation owns the closed-state label/notice/summary. Prepared Delivery admits a closed page only when the pending effect is the exact deterministic finish update for the exact page revision; all ordinary stale snapshots retain existing dismissal behavior. Conversation Segment closure and Agent Input submission are unchanged. |
| Mutation ownership | src/cards/turn-card.ts, src/coordinator/turn-card-workflow.ts, src/store/sqlite/prepared-delivery-store.ts, tests/human-turn-card.integration.test.ts, tests/ring-delivery-hot-path.test.ts, docs/spec-coder/specs/2026-10-13-per-pane-delivery-rings.md, docs/spec-coder/plans/2026-10-13-per-pane-delivery-rings.md |
| Exclusions | Creating a synthetic final, changing active-Turn steering/coalescing, replaying possible effects, loosening owner/page/revision/message fences, deployment, restart and live SQLite mutation. |
| Isolation | Main-local mutation in the existing isolated worktree after T6; the overlapping original staged worktree remains untouched. |
| Concurrency conflicts | None |
| Verification seam | Real SQLite and real Turn Card rendering: first Human -> delivered card -> visible commentary -> second Human before final -> exact terminal update claim; counterexample proves a normal closed-page snapshot is dismissed. |
| Host capacity | No child slot is used; main executes and verifies locally. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect worker dispatch. |
| Acceptance criteria and verification | The prior card visibly says `已并入后续输入`, contains the no-independent-final notice and retains prior activity. Its exact finish effect claims under existing owner/scope/revision/message fences. A normal snapshot on the same closed Segment is dismissed. Run focused Human Turn Card, Turn Card renderer, Conversation Segment and Ring hot-path tests, typecheck, build, architecture, artifact and diff checks. |
| Verification commands | `npx vitest run tests/human-turn-card.integration.test.ts --maxWorkers=1 -t "delivers an explicit merged state"`; `npx vitest run tests/ring-delivery-hot-path.test.ts --maxWorkers=1 -t "ordinary snapshot update after a later Human Message"`; `npx vitest run tests/turn-card.test.ts --maxWorkers=1`; `npx vitest run tests/conversation-segment-store.test.ts --maxWorkers=1 -t "newer turn arrives before the final card"`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; spec and plan artifact checks; `git diff --check` |
| Verification results | RED observed the prior card render as green `Completed`; after presentation Green, the same end-to-end test remained RED because Prepared Delivery returned null for the exact closed-page finish update. The minimum claim repair passed the end-to-end scenario, and the ordinary snapshot counterexample remained dismissible. The focused Human Turn Card, Conversation Segment, Ring and renderer commands passed 31 tests; with a 20-second host timeout, the full Human Turn Card file passed 44/44 and full Ring file passed 52/52. Typecheck, build (`sha256:82f63e11419cb99a0e47492d7d2f870560f954c8641c50f32b9683733be80018`), architecture (541 source files), docs audit, spec/plan artifact checks and diff check passed. A diagnostic broader four-file run passed 204/205; its only failure is the pre-existing Worker `completion-review:*` claim blocker outside this ticket's `turn-card:*` target path. |
| Commits | 8017506a |
| Blocked by | T5 |

## Final delivery checks

Main performs independent Standards and Specification review locally because of
the request-wide no-subagent instruction. After any TDD repairs, main freshly
runs all affected suites, the full SQLite-safe test suite, typecheck, build,
architecture and docs audits, and delivery artifact validation. Production
installation and any live pane move remain separately authorized effects after
Gate 3 implementation and delivery review; no force restart is implied.
