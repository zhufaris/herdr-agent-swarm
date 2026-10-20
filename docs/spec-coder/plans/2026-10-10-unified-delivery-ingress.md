# Unified Delivery Ingress and Consumer-Time Presentation Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-10-unified-delivery-ingress.md`

Status: Gate 1 design, Gate 2 specification, and Gate 3 ticket/implementation authorization approved.

Workspace: `<workspace>`

Branch and base: `worktree-unified-delivery-ingress` at `1261027cfe06919d39383f6a31947b221bfb6fc5`.

Baseline: Node `v24.14.1`; `npm ci`; `npm run build`; 298 test files / 4451 tests passed; `npm run typecheck` passed. Documentation and architecture checks subsequently passed 88 focused tests.

Workspace policy: isolated execution because the original checkout contains overlapping user-owned changes in prepared-delivery source/tests and unrelated tracked/untracked work. Preserve those changes. Stage explicit ticket-owned paths only; do not push, deploy, restart, clean legacy data, or modify the original checkout.

## Wave W1: `T1`, `T2`

### - [x] T1: Make completion-choice submission bounded and truthful

| Field | Content |
| --- | --- |
| What to build | Replace recursively composed Primary Segment choice submission/source identities with deterministic fixed-length identities; classify `invalid_submission_identity` as a definite pre-effect rejection; make card-action feedback reflect the returned Agent Input state; preserve one-shot choice semantics and no-resubmit uncertainty. |
| Spec references | SCN-1, INV-12, INV-14 |
| Dependencies | None |
| Delegation eligibility | Eligible: bounded/reversible behavior fix with a live reproduced failure and focused store/workflow/adapter tests; no production credentials or main-only decision. |
| Delegation mode | Default direct worker; standard tier. |
| Ownership and implementation path | Agent Input and Conversation Projection jointly own durable choice admission; the Herdr adapter owns Core error classification; Card Interaction owns truthful toast selection. Preserve current actor/chat/generation/card fences. |
| Mutation ownership | src/domain/completion-choice.ts, src/store/sqlite/conversation-segment-store.ts, src/coordinator/card-interaction-workflow.ts, src/adapters/herdr-agent-input-adapter.ts, tests/conversation-segment-store.test.ts, tests/herdr-agent-input-adapter.test.ts, tests/card-interaction-integration.test.ts |
| Exclusions | Worker choice redesign, automatic retry of current uncertain intents, Feishu card layout, delivery Ring architecture. |
| Isolation | Can run as an isolated parallel worker from the Gate 3 wave base; must not share a mutating checkout with T2. |
| Concurrency conflicts | None |
| Verification seam | Red tests for many consecutive choices, maximum identity length, exact deterministic dedupe, Core rejection classification, and success/uncertain/cancelled toast mapping. |
| Host capacity | Requires one direct-child slot; live capacity is rechecked before the wave. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | At least 20 chained choices keep IDs within Core bounds; duplicates reuse one intent; `invalid_submission_identity` is cancelled/rejected, not uncertain; an uncertain result is never reported as success or resubmitted; focused choice, adapter, and workflow suites pass. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts tests/herdr-agent-input-adapter.test.ts tests/card-interaction-integration.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 3 focused files and 84 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:48335af243806c5fd2fa078f61f5c17ec74e0d3771dcae9b3771fa4c05d15fb9`. |
| Commits | `f1072c79` |

### - [x] T2: Expand the Outbox contract for semantic snapshots without rewriting legacy work

| Field | Content |
| --- | --- |
| What to build | Add nullable typed subject, semantic snapshot, snapshot hash, policy/profile version, and preparation-phase persistence; define validated codecs and dual-shape mapping so new semantic and historical prepared entries coexist while immutable historical rows remain byte-stable. |
| Spec references | SCN-2, SCN-3, SCN-13, INV-1, INV-3, INV-6 |
| Dependencies | None |
| Delegation eligibility | Eligible: additive schema/domain slice with real SQLite round-trip and old-schema fixtures; independently inspectable migration diff. |
| Delegation mode | Default direct worker; strong tier because it changes shared durable identity and migration semantics. |
| Ownership and implementation path | Delivery and Operations owns the Outbox Entry aggregate and codecs; SQLite migration/mapper preserves legacy prepared rows and rejects malformed semantic rows. New columns remain nullable during expansion. |
| Mutation ownership | src/domain/delivery.ts, src/domain/delivery-intent.ts, src/domain/ports/prepared-delivery.ts, src/store/sqlite/schema.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migrations/card-outbox-migrations.ts, src/store/sqlite/prepared-delivery-store.ts, src/store/sqlite/schema-manifest.ts, tests/sqlite-migrations.test.ts, tests/prepared-delivery-store.test.ts, tests/sqlite-store.test.ts |
| Exclusions | Ring enqueue, rendering, Gateway execution, Page settlement, backfill of historical rows, immutability-trigger weakening. |
| Isolation | Can run in parallel with T1 only in a real isolated worktree from the same wave base. |
| Concurrency conflicts | T3, T4, T5, T6, T7, T8, T9 |
| Verification seam | Old-schema reopen plus semantic-entry round-trip tests; malformed snapshot/subject refusal; source diff proving immutable legacy triggers remain enforced. |
| Host capacity | Requires one direct-child slot; parallel Wave 1 requires a second isolated slot for T1. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Legacy prepared/claimed/uncertain/compacted fixtures load unchanged; a semantic row round-trips typed subject, versions, hash, and snapshot; invalid mixed states fail closed; migration is idempotent; focused migration/store and architecture checks pass. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/sqlite-migrations.test.ts tests/prepared-delivery-store.test.ts tests/sqlite-store.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 3 affected files and 634 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:0cb7ac31ee5a74e161875325f805f32348fc4ddf631bc5bfe87b7c8139280404`. |
| Commits | `c83ab62c` |

## Wave W2: `T3`

### - [x] T3: Plan and render a provider-neutral Turn Card with a proved budget

| Field | Content |
| --- | --- |
| What to build | Introduce the versioned Conversation Page Presentation Policy that plans canonical boundaries, freezes the Turn Card Presentation Snapshot, measures a deterministic encoded-size upper bound, and renders strict Gateway View equivalent to the current Feishu Turn Card. Persist policy/budget identity for new pages while retaining the legacy path for existing active/frozen pages. |
| Spec references | SCN-10, SCN-11, INV-8 |
| Dependencies | T2 |
| Delegation eligibility | Eligible: deterministic pure presentation slice with focused golden/equivalence tests and architecture import checks. |
| Delegation mode | Default direct worker; strong tier because canonical pagination and provider-neutral presentation interact. |
| Ownership and implementation path | Conversation Projection owns Page Plan and canonical anchors; the provider-neutral policy owns `plan/measure/render`; Feishu adapter owns Gateway View materialization. No raw CardKit crosses the semantic interface. |
| Mutation ownership | src/domain/conversation-segment.ts, src/domain/ports/presentation.ts, src/cards/turn-card.ts, src/gateways/contract/view.ts, src/gateways/feishu/presentation.ts, tests/turn-card.test.ts, tests/gateway-view.test.ts, tests/architecture-boundaries.test.ts |
| Exclusions | Outbox reservation, Ring execution, ACK settlement, legacy page conversion, unrelated card families. |
| Isolation | Serialized after T2; shared authoritative worktree or one direct isolated worker from the accepted T2 base. |
| Concurrency conflicts | T4 |
| Verification seam | Pure policy tests for canonical boundaries and measure upper bounds; Feishu materialization equivalence; restart fixture with legacy/new policy versions; import-boundary test. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Frozen/legacy pages retain boundaries across policy changes; new pages use versioned canonical anchors; actual CardKit serialization stays within committed measure; semantic durable values contain no CardKit/opaque provider node; current visible Turn Card behavior remains equivalent except approved wake-up text. |
| Blocked by | T2 |
| Verification commands | `npx vitest run tests/turn-card.test.ts tests/gateway-view.test.ts tests/architecture-boundaries.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 3 focused files and 116 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:b86cd93e75cf02fca0f5cab8bf823e9a12ca95dec9e97f9e8d212a18a1d19f0a`. |
| Commits | `78fc2808`, `05f79301`, `96e43bf7` |

## Wave W3: `T4`

### - [x] T4: Reserve semantic Turn Card work before Ring admission and recover missed enqueue

| Field | Content |
| --- | --- |
| What to build | Make new-cohort Turn Card reservation atomically persist Page transition plus semantic Outbox Entry, return complete work only after commit, enqueue it into the existing per-scope Ring, and hydrate reserved work through bounded checkpoint/refill after missed wake, overflow, or restart. Preserve prepared-effect compatibility for all other producers. |
| Spec references | SCN-2, SCN-3, SCN-9, SCN-13, INV-1, INV-2, INV-3, INV-6, INV-10 |
| Dependencies | T2, T3 |
| Delegation eligibility | Eligible: bounded end-to-end reservation/recovery slice with transaction and reopen tests; no live Gateway credential needed. |
| Delegation mode | Default direct worker; strong tier due transactional reservation and Ring recovery. |
| Ownership and implementation path | Conversation Projection creates immutable semantic intent; Delivery and Operations owns commit-to-Ring handoff and scope order; checkpoint remains derived/rebasable. Post-commit receipt is the only hot enqueue signal. |
| Mutation ownership | src/composition/create-outbound-runtime.ts, src/coordinator/turn-card-workflow.ts, src/domain/delivery.ts, src/domain/ports/outbox.ts, src/domain/ports/prepared-delivery.ts, src/events/outbound-intent-writer.ts, src/events/prepared-delivery-ring.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/outbox-capability-store.ts, src/store/sqlite/outbox-queue-store.ts, src/store/sqlite/outbox-store.ts, src/store/sqlite/prepared-delivery-store.ts, tests/helpers/sqlite-binding-store.ts, tests/turn-card-workflow.test.ts, tests/conversation-segment-store.test.ts, tests/prepared-delivery-ring.test.ts, tests/prepared-delivery-store.test.ts |
| Exclusions | Consumer rendering/plan freeze, Feishu execution, ACK/page settlement, semantic cutover enablement. |
| Isolation | Serialized after T3; one direct isolated worker or authoritative shared checkout. |
| Concurrency conflicts | T3, T5, T6 |
| Verification seam | Transaction rollback/post-commit tests; database reopen after commit-before-enqueue; Ring spill/refill; mixed legacy/semantic scope-order tests. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Rollback creates no Ring work; hot commit avoids reconstruction; missed enqueue/refill returns exact snapshot once; semantic and legacy entries preserve same-scope order; checkpoint does not skip uncertain/reopened work; unrelated scopes remain concurrent. |
| Blocked by | T2, T3 |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/prepared-delivery-ring.test.ts tests/turn-card-workflow.test.ts tests/conversation-segment-store.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 4 affected files and 139 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:272a313681889be0a49196b5d55b49e167ef8a6931a1d7ef3509bbf6b9dadff8`. |
| Commits | `8c568e69`, `8d5a6771` |

## Wave W4: `T5`

### - [x] T5: Freeze consumer-prepared effects before any Gateway call

| Field | Content |
| --- | --- |
| What to build | Extend the unified consumer to render semantic snapshots, verify their committed measurement, prepare the Gateway plan, and CAS-freeze plan/hash before execution. Preserve existing prepared-effect execution and uncertain-effect recovery; reject stale snapshot/profile/renderer claims and durably isolate deterministic preparation failures. |
| Spec references | SCN-4, SCN-5, SCN-6, INV-4, INV-5, INV-7 |
| Dependencies | T2, T3, T4 |
| Delegation eligibility | Eligible: well-specified concurrency/recovery slice with injected fake Gateway and crash seams; independently inspectable CAS tests. |
| Delegation mode | Default direct worker; strong tier. |
| Ownership and implementation path | Delivery consumer coordinates pure render/prepare; SQLite adapter owns CAS and durable effect state; Gateway port executes only a frozen plan. Claims retain lease/fence/expiry/effect-certainty semantics. |
| Mutation ownership | src/events/ring-delivery-engine.ts, src/events/outbound-gateway-intent.ts, src/domain/ports/prepared-delivery.ts, src/store/sqlite/prepared-delivery-store.ts, src/gateways/contract/plugin.ts, tests/ring-delivery-hot-path.test.ts, tests/ring-delivery-recovery.test.ts, tests/prepared-delivery-store.test.ts |
| Exclusions | Page ACK settlement, completion prerequisites, rollout cohort toggles, other presentation migrations. |
| Isolation | Serialized after T4. |
| Concurrency conflicts | T4, T6 |
| Verification seam | Crash injection around render/freeze/execute; stale CAS tests; exact plan/hash reuse; expired-claim uncertainty; deterministic preparation failure quarantine. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | No external call before durable plan freeze; retries never rerender a frozen plan; stale Ring work cannot execute; expired unknown-effect claims become uncertain; provider-backed safe retry remains supported; legacy prepared effects remain behaviorally unchanged. |
| Blocked by | T2, T3, T4 |
| Verification commands | `npx vitest run tests/architecture-boundaries.test.ts tests/prepared-delivery-store.test.ts tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 4 affected files and 182 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:038f01deb997e4361105562b4e1a3c307c17bb815a9c4d2d4ec3b3029e2b2ece`. Worker full-suite attempt was inconclusive under load and is not claimed as evidence; isolated reported failures passed, and final delivery will run the full suite freshly. |
| Commits | `3dd3a922`, `05f79301` |

## Wave W5: `T6`

### - [x] T6: Settle Turn Card ACK, subject state, and Ring checkpoint in one local transaction

| Field | Content |
| --- | --- |
| What to build | Replace process-local Turn Card checkpoint correctness with typed subject settlement inside the Outbox ACK transaction, including durable target identities, delivered Page revision/state, recovery completion, and derived checkpoint recomputation. Record conclusive remote success plus local subject mismatch as a non-replayable settlement gap. |
| Spec references | SCN-7, SCN-8, SCN-9, INV-5, INV-6, INV-9, INV-10 |
| Dependencies | T4, T5 |
| Delegation eligibility | Eligible: complex but bounded transactional slice with real SQLite fault/reopen tests and fake receipts. |
| Delegation mode | Default direct worker; strong tier. |
| Ownership and implementation path | Delivery and Operations owns terminal effect; Conversation Projection owns Page target/revision; the SQLite adapter enforces the cross-context local transaction. Checkpoint bus becomes wake-only. |
| Mutation ownership | src/store/sqlite/outbox-delivery-store.ts, src/store/sqlite/prepared-delivery-store.ts, src/store/sqlite/conversation-segment-store.ts, src/events/delivery-checkpoint-bus.ts, src/composition/create-outbound-runtime.ts, tests/prepared-delivery-store.test.ts, tests/conversation-segment-store.test.ts, tests/turn-card-runtime-wiring.test.ts |
| Exclusions | Cross-system exactly-once claims, automatic uncertain replay, Worker/Answer semantic settlement migration. |
| Isolation | Serialized after T5. |
| Concurrency conflicts | T4, T5, T7 |
| Verification seam | Inject rollback at each receipt-dependent write; exit after commit-before-bus; duplicate ACK; subject mismatch; earliest-nonterminal checkpoint and backward-rebase tests. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Outbox, receipt, Page, recovery and checkpoint changes commit or roll back together; ordinary success needs no Page adoption repair; subject mismatch never resends remote effect; same-subject successors block while unrelated work continues; checkpoint remains derived and rebasable. |
| Blocked by | T4, T5 |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/conversation-segment-store.test.ts tests/turn-card-runtime-wiring.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 3 affected files and 134 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:2fc312e161396adc71479b5c655309561089bbdd8ba259e8aa0f1eff58221ac2`. Worker additionally reported a full-suite pass, reserved for fresh delivery verification rather than ticket evidence. |
| Commits | `b6c785fc`, `8d5a6771` |

## Wave W6: `T7`

### - [x] T7: Make choice presentation and completion wake-up prerequisites retention-safe

| Field | Content |
| --- | --- |
| What to build | Represent page/card creation -> choice-bearing update -> concise completion mention as exact durable prerequisite edges, transfer them atomically during safe replacement, protect them from retention, and release the ACK-gated mention once with text `需要你的选择`. |
| Spec references | SCN-12, INV-11, INV-13 |
| Dependencies | T1, T6 |
| Delegation eligibility | Eligible: bounded successor/retention capability with focused ACK, replacement, restart, and retention tests. |
| Delegation mode | Default direct worker; standard tier. |
| Ownership and implementation path | Delivery prerequisites own execution ordering; Completion Notification owns one durable obligation; retention honors dependent lifecycle. `presentation_reply_id` is query-only convenience. |
| Mutation ownership | src/store/sqlite/completion-notification-store.ts, src/store/sqlite/outbox-retention-store.ts, src/store/sqlite/delivery-prerequisites.ts, src/store/sqlite/conversation-segment-store.ts, src/cards/turn-card.ts, tests/conversation-segment-store.test.ts, tests/turn-card.test.ts, tests/retention-compaction-store.test.ts |
| Exclusions | General prerequisite redesign, new Human Review episode model, non-choice notification copy changes. |
| Isolation | Serialized after T6; cannot overlap T8 retention work. |
| Concurrency conflicts | T6, T8 |
| Verification seam | Delayed ACK, duplicate ACK, process reopen, safe replacement edge transfer, retention cutoff, and exactly-one mention tests. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Mention never precedes exact choice-bearing delivery; prerequisites survive restart/replacement/retention; terminal dependent releases retention; duplicate ACK creates no duplicate mention; approved concise wording is used. |
| Blocked by | T1, T6 |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts tests/retention-compaction-store.test.ts tests/turn-card.test.ts tests/prepared-delivery-store.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 4 affected files and 167 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:92f5d17d39c655b9562d28ccc45d77e6a42e57e0cc1faea5a34d62d4607485ae`. |
| Commits | `64ea3126`, `3e84df79`, `8d5a6771` |

## Wave W7: `T8`

### - [x] T8: Preserve semantic delivery evidence through retention and compaction

| Field | Content |
| --- | --- |
| What to build | Make snapshot/plan/prerequisite/recovery/settlement evidence participate in explicit retention barriers; compact semantic snapshots only after plan freeze and discharge of every dependent obligation; keep recovery and retention scans bounded and indexed across mixed legacy/semantic histories. |
| Spec references | SCN-12, SCN-13, INV-10, INV-11, INV-13 |
| Dependencies | T2, T5, T6, T7 |
| Delegation eligibility | Eligible: bounded retention capability with lifecycle matrix, reopen fixtures, query-plan evidence, and no external mutation. |
| Delegation mode | Default direct worker; strong tier. |
| Ownership and implementation path | Delivery Operations owns retention eligibility over the Outbox aggregate and its prerequisite/recovery relations; compaction retains identity hashes/versions and never destroys active recovery input. |
| Mutation ownership | src/store/sqlite/outbox-retention-store.ts, src/store/sqlite/retention-compaction-store.ts, src/store/sqlite/migrations/card-outbox-migrations.ts, src/store/sqlite/operations-store.ts, tests/retention-compaction-store.test.ts, tests/outbox-retention-maintainer.test.ts, tests/prepared-delivery-store.test.ts, tests/operations-integration.test.ts |
| Exclusions | Cohort enablement, shadow rendering, actual contraction/deletion, deployment, semantic migration of other card families. |
| Isolation | Serialized after T7. |
| Concurrency conflicts | T2, T5, T6, T7, T9 |
| Verification seam | Lifecycle matrix for snapshot/plan retention; delayed prerequisite/recovery reopen; old/mixed-schema fixtures; `EXPLAIN QUERY PLAN`; skewed backlog timing. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Reserved/preparing/preparation-failed snapshots cannot compact; plan-frozen work retains executable plan and immutable hashes; prerequisites/recoveries/gaps block deletion until terminal; mixed legacy/semantic scans remain bounded and indexed under production-shaped skew. |
| Blocked by | T2, T5, T6, T7 |
| Verification commands | `npx vitest run tests/retention-compaction-store.test.ts tests/outbox-retention-maintainer.test.ts tests/prepared-delivery-store.test.ts tests/sqlite-migrations.test.ts tests/operations-integration.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 5 affected files and 151 tests pass; typecheck exit 0; build exit 0 with build identity `sha256:31e0fcce5379b2b11f901aa8f017f16fcd054304c79afdfbc61d45059b8fc396`. Worker full-suite report is reserved for fresh delivery verification. |
| Commits | `7663c650`, `3e84df79`, `25d07750` |

## Wave W8: `T9`

### - [x] T9: Guard semantic Turn Card rollout with shadow parity and operational evidence

| Field | Content |
| --- | --- |
| What to build | Add durable expand/shadow/cohort/contraction guards, semantic-versus-legacy Turn Card parity checks, status/readiness/cutover refusal evidence, version support diagnostics, and backup/restore rehearsal. Enable semantic execution only for newly created cohort pages after parity; retain legacy execution for historical and active legacy pages. |
| Spec references | SCN-13, SCN-14, INV-3, INV-8, INV-11 |
| Dependencies | T3, T4, T5, T6, T7, T8 |
| Delegation eligibility | Eligible: bounded rollout/operations slice with exact refusal conditions and shadow fixtures; no live deployment authority. |
| Delegation mode | Default direct worker; strong tier. |
| Ownership and implementation path | Delivery Operations owns cutover evidence and execution authority; Conversation Projection owns immutable page cohort/policy marker; lifecycle/status modules expose refusal but never deploy. Shadow derives both representations without double execution. |
| Mutation ownership | docs/architecture.md, src/cards/cardkit-application-presentation.ts, src/cards/operations-card.ts, src/composition/create-ingress-recovery-runtime.ts, src/composition/create-outbound-runtime.ts, src/coordinator/startup-view-converger.ts, src/coordinator/turn-card-workflow.ts, src/domain/conversation-segment.ts, src/domain/ports/conversation-segment.ts, src/domain/ports/outbox.ts, src/domain/ports/presentation.ts, src/domain/types.ts, src/gateways/feishu/presentation.ts, src/gateways/feishu/turn-card-presentation-policy.ts, src/health/health-snapshot-collector.ts, src/store/sqlite-store-bundle.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migrations/card-outbox-migrations.ts, src/store/sqlite/operations-store.ts, src/store/sqlite/outbox-capability-store.ts, src/store/sqlite/outbox-queue-store.ts, src/store/sqlite/outbox-store.ts, src/store/sqlite/prepared-delivery-store.ts, src/store/sqlite/schema-manifest.ts, tests/architecture-boundaries.test.ts, tests/conversation-segment-store.test.ts, tests/gateway-view.test.ts, tests/health-snapshot-collector.test.ts, tests/operations-card.test.ts, tests/prepared-delivery-store.test.ts, tests/sqlite-migrations.test.ts, tests/startup-view-converger.test.ts, tests/turn-card-workflow.test.ts, tests/turn-card.test.ts |
| Exclusions | Actual install/restart/deployment, automatic contraction, deletion of legacy history, semantic migration of other card families. |
| Isolation | Serialized final implementation ticket after T8. |
| Concurrency conflicts | T2, T3, T4, T5, T6, T7, T8 |
| Verification seam | Shadow equivalence and mismatch fixtures; unsupported-version readiness; ambiguous-row/gap refusal; new-page-only cohort tests; backup/restore rehearsal; architecture/docs checks. |
| Host capacity | Requires one direct-child slot, rechecked at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn directly/indirectly, stage, or commit. |
| Acceptance criteria and verification | Expansion remains old-reader safe before semantic rows; semantic cohort includes only new pages; mismatch, ambiguous actionable rows, unsupported versions, unresolved gaps or retention blockers prevent cutover/contraction; backup/restore rehearsal passes; no external deployment occurs. |
| Blocked by | T3, T4, T5, T6, T7, T8 |
| Verification commands | `npx vitest run tests/health-snapshot-collector.test.ts tests/startup-view-converger.test.ts tests/operations-card.test.ts tests/turn-card-workflow.test.ts tests/sqlite-migrations.test.ts tests/retention-compaction-store.test.ts tests/outbox-retention-maintainer.test.ts tests/prepared-delivery-store.test.ts tests/operations-integration.test.ts tests/architecture-boundaries.test.ts tests/human-turn-card.integration.test.ts`; `npm test`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed rollout, migration, lifecycle, committed-measurement, provider-boundary, and route-preview Red-Green evidence; final independent Standards and Spec reviews have no blocking findings. Fresh full suite passed 299 files and 4538 tests; typecheck exit 0; build exit 0 with build identity `sha256:33e42362d19788659cfa18e52fc4abf34d721c34cde218175044334d6534b2d2`; architecture check covered 532 source files; documentation audit passed. No rollout transition, contraction, deployment, install, restart, push, or PR occurred. |
| Commits | `9ccf98bd`, `25d07750`, `05f79301`, `8d5a6771`, `55a9839c`, `96e43bf7`, `11a607b2` |

## Planned wave rationale

```text
Wave 1 (parallel only with real isolation): T1 + T2
                                         |
                                         v
Wave 2: T3
  -> Wave 3: T4
  -> Wave 4: T5
  -> Wave 5: T6
  -> Wave 6: T7
  -> Wave 7: T8
  -> Wave 8: T9
```

T1 and T2 are independently meaningful and mutation-disjoint enough for a parallel delegated wave only when each receives a real isolated worktree at the same accepted base. If two isolated worker slots are not available, delegate them serially; do not mutate one shared checkout in parallel. Every later ticket is serialized because it consumes or overlaps the evolving durable interfaces.

The active main agent owns result attribution, integration into this authoritative worktree, fresh verification, explicit staging, plan checkbox updates, atomic Conventional Commits, gate interpretation, and completion claims.

## Final Delivery Checks

- [x] All ticket-owned diffs reviewed against the approved specification and domain language.
- [x] Every scenario SCN-1 through SCN-14 and invariant INV-1 through INV-14 mapped to passing evidence.
- [x] Standards and Spec review passes completed independently; findings repaired through the responsible ticket path.
- [x] Focused affected suites pass.
- [x] `npm run typecheck` passes.
- [x] `npm run build` passes.
- [x] Full `npm test` passes sequentially after build.
- [x] Architecture/documentation checks pass and no new provider dependency leaks inward.
- [x] Git status contains only approved task artifacts; original-checkout user changes remain untouched.
- [x] No deploy, restart, push, PR, external ticket, legacy contraction, or destructive cleanup performed without separate authority.
