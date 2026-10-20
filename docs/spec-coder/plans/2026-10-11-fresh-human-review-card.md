# Fresh Authoritative Human Review Card Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-11-fresh-human-review-card.md`

Workspace mode: reuse the existing isolated worktree in place. Branch:
`worktree-unified-delivery-ingress`. Starting revision:
`6d40781be80f389e5734580e8ae0cb4e871cb4b2`. Initial changes before planning:
none. Planning artifacts are the only current changes.

Fresh baseline records for request
`fresh-human-review-card-20261011-active`:

- `cde8aa0c7b9d45f6a270cef408752156`: `npm test`, exit 0, 300 files /
  4,597 tests;
- `a2a8d4a12651433c8340a5bc7e060373`: `npm run typecheck`, exit 0;
- `a16f64529f054968b8196479bb72fedc`: `npm run build`, exit 0, build
  `sha256:f11ef015060d0aa398b23178ad9d399c0aa48a66c87c2c34e8afb6980ba10b3e`.

Gate 0 proved that a newly created Feishu card with the native requester
mention triggers a mention notification. Design selection and Gate 1, Gate 2
and Gate 3 are auto-selected under explicit autonomous authority. The selected
design is the deterministic fresh-card Completion Review lifecycle; detached
CardKit surface identity and urgent-notification side effects are rejected.

All waves are serial. The Action Set schema, shared Completion Review module,
ACK settlement and interaction router overlap semantically and physically, so
parallel mutation would not be safe even with isolated worktrees.

## Wave W1: `T1`

### - [x] T1: Establish the durable Completion Review lifecycle and legacy compatibility

| Field | Content |
| --- | --- |
| What to build | Add deterministic fresh-card Action Set identity, explicit provisional/presenting/active lifecycle, minimal callback command shape, and an expand-phase ordered migration that preserves every existing inline Action Set as actionable legacy evidence. Legacy `available` remains `available` until all owner stores cut over; runtime behavior remains legacy-inline after this ticket. |
| Spec references | SCN-5, SCN-6, SCN-7, SCN-11, INV-1, INV-2, INV-3, INV-6, INV-11, ARCH-1, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | Eligible: schema, deterministic domain rules, compatibility parser and migration fixtures are bounded and independently inspectable; no production credentials or external effects are required. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Completion Interaction owns Action Set identity/lifecycle and callback command meaning. SQLite mapping owns controlled reconstitution and legacy-inline backfill. Callback parsing accepts the new minimal shape and tolerates legacy extra fields, while application behavior stays on the legacy path until later tickets. |
| Mutation ownership | src/domain/completion-action-set.ts, src/domain/completion-choice.ts, src/coordinator/card-action-command.ts, src/store/sqlite/schema.ts, src/store/sqlite/migrations.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/migrations/, tests/card-action-command.test.ts, tests/sqlite-migrations.test.ts, tests/sqlite-store.test.ts |
| Exclusions | Fresh card reservation, Gateway delivery, ACK activation, owner workflow cutover, installation, production state and remote Feishu actions. |
| Isolation | Serial worker in the current isolated worktree; main verifies the recorded base before dispatch. |
| Concurrency conflicts | T2, T3, T4, T5 |
| Verification seam | Domain identity/lifecycle tests plus migration round-trip, current-schema fingerprint, legacy Action Set callback compatibility and fast reopen. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; the child does not spawn, stage, commit, install, restart, deploy or access production. |
| Acceptance criteria and verification | New identities are deterministic and strictly validated; invalid transitions fail; migration preserves available/consumed/superseded/unavailable rows and provider identity without converting legacy `available`; legacy buttons remain actionable; fresh-card states are representable but unused; focused domain/migration/current-owner tests, typecheck and build pass. |
| Verification commands | `npx vitest run tests/completion-action-set.test.ts tests/card-action-command.test.ts tests/sqlite-migrations.test.ts tests/sqlite-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; plan artifact checker; `git diff --check`. |
| Verification results | 4 files / 689 tests passed; typecheck passed; build `sha256:e9d0a82a00673ec9d771ed4d8b4e482e84ed181c98caa2a30c76859ccfb5ca8d`; 534 source files passed architecture check; artifact plan and diff checks passed. Independent review found and verified repairs for migration replay, namespace downgrade, runtime identity validation, retention FK behavior, shared legacy links and marker-skew crash recovery; final Spec and Code verdicts passed. |
| Commits | `30d2ce2b` |
| Blocked by | None |

## Wave W2: `T2`

### - [x] T2: Deliver Primary Segment choices on one fresh authoritative review card

| Field | Content |
| --- | --- |
| What to build | For a valid Primary Segment Human Review choice, atomically persist a provisional deterministic Action Set and one fresh-card Delivery Intent whose initial view contains sanitized final context, native mention, question, business buttons and Ignore. ACK binds provider identity and activates the set; callback consumption creates one Submission Intent. The old Turn Card contains no new choice controls. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, SCN-8, SCN-9, SCN-10, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10, ARCH-1, ARCH-2, ARCH-3, ARCH-4 |
| Dependencies | T1 |
| Delegation eligibility | Eligible after T1: owner facts, lifecycle, exact ACK seam and focused in-memory Gateway/SQLite tests are available; live Feishu validation remains main-owned final delivery work. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | A deep SQLite Completion Review module owns reserve/activate/decide/supersede/recover. Conversation Projection supplies a frozen sanitized review snapshot. Delivery and Operations executes one immutable card reply in the Primary Pane scope and invokes ACK activation inside settlement. Primary Segment decision and resulting Submission Intent remain atomic. |
| Mutation ownership | src/domain/ports/conversation-segment.ts, src/domain/ports/presentation.ts, src/cards/completion-actions.ts, src/cards/turn-card.ts, src/cards/cardkit-application-presentation.ts, src/gateways/feishu/presentation.ts, src/store/sqlite/completion-review-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/outbox-delivery-store.ts, src/store/sqlite/capability-graph.ts, src/coordinator/card-interaction-workflow.ts, tests/conversation-segment-store.test.ts, tests/card-interaction-integration.test.ts, tests/prepared-delivery-store.test.ts, tests/turn-card.test.ts, tests/gateway-view.test.ts |
| Exclusions | Primary Prompt and Worker Turn cutover, urgent API, detached CardKit surface identity, historical card deletion, production install or live Feishu mutation. |
| Isolation | Serialized after accepted T1 commit because schema and shared settlement interfaces are prerequisites. |
| Concurrency conflicts | T1, T3, T4, T5 |
| Verification seam | In-memory Primary Segment projection through prepared delivery ACK and authenticated callback, with exact outbox/action/submission rows inspectable after every transition. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; the child does not spawn, stage, commit, install, restart, deploy or access production. |
| Acceptance criteria and verification | Initial fresh card contains mention and controls; no inline buttons or standalone text reminder remain; pre-ACK callback is non-mutating; ACK activates exact message identity; correct option/Ignore succeeds once; wrong actor/message/option/generation fails; restart and uncertain-create rules hold; focused tests, T1 regression, typecheck and build pass. |
| Verification commands | 12-file T2/T1 Vitest matrix; focused immutable replay/ACK/adoption/post-close duplicate/supersession/Gateway semantic mention tests; projection-gap failure-transition regression; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`. |
| Verification results | Full matrix passed 12 files / 970 tests. Final affected regression passed 5 files / 274 tests. Typecheck passed; build `sha256:1d58dc5ba4bcf819d6993b6db61a6d1bcccb82aa9d8f8a4142bd70da75f6212e`; 535 source files passed architecture check; diff check passed. Independent review found and verified immutable replay, ACK/adoption, post-close duplicate, semantic mention, supersession and durable projection-gap repairs; final Spec and Code verdicts passed. |
| Commits | `95ec1bcd` |
| Blocked by | T1 |

## Wave W3: `T3`

### - [x] T3: Extend fresh review cards to Primary Prompt ownership

| Field | Content |
| --- | --- |
| What to build | Route retained Primary Prompt Human Review choices through the shared fresh-card lifecycle, preserving Prompt generation, pane/session and actor fences and one deterministic resulting Agent Input. Remove new inline choice controls and standalone choice reminders from this owner path. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-7, SCN-8, SCN-9, SCN-10, SCN-12, SCN-13, INV-5, INV-6, INV-7, INV-8, INV-9, ARCH-1, ARCH-3 |
| Dependencies | T2 |
| Delegation eligibility | Eligible after T2: the shared lifecycle and ACK interface are committed; Primary Prompt fixtures provide an inspectable result without external credentials. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Primary Prompt contributes current owner/route facts and retains its atomic resulting Input transition. Completion Review owns presentation lifecycle; Delivery and Operations owns effects. Existing legacy-inline rows remain accepted through compatibility translation. |
| Mutation ownership | src/composition/create-outbound-runtime.ts, src/coordinator/answer-page-workflow.ts, src/coordinator/card-interaction-workflow.ts, src/domain/ports/projection.ts, src/domain/ports/workflow.ts, src/store/sqlite/completion-review-store.ts, src/store/sqlite/control-capability-store.ts, src/store/sqlite/projection-store.ts, src/store/sqlite/prompt-acceptance-store.ts, tests/answer-page-workflow.test.ts, tests/card-interaction-integration.test.ts, tests/sqlite-store.test.ts |
| Exclusions | Worker Turn cutover, Primary Segment redesign, Gateway contract changes, installation, production state and remote Feishu actions. |
| Isolation | Serialized after T2; shared Completion Review behavior is consumed but not redesigned. |
| Concurrency conflicts | T1, T2, T4, T5 |
| Verification seam | Primary Prompt completion fixture through fresh-card reservation, ACK, callback and exact Submission Intent, including detached recovery and duplicate callback. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; the child does not spawn, stage, commit, install, restart, deploy or access production. |
| Acceptance criteria and verification | Fresh initial card mention/controls, active-after-ACK, one Input, local Ignore, stale route rejection, restart adoption, uncertain no-replacement, zero standalone choice text and legacy callback preservation all pass focused tests plus typecheck/build. |
| Verification commands | `npx vitest run tests/sqlite-store.test.ts tests/answer-page-workflow.test.ts tests/card-interaction-integration.test.ts tests/detached-core-recovery.integration.test.ts tests/completion-choice-eligibility-gateway.integration.test.ts tests/conversation-segment-store.test.ts tests/prepared-delivery-store.test.ts tests/outbound-runtime-composition.test.ts tests/turn-card.test.ts tests/gateway-view.test.ts tests/card-action-command.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`. |
| Verification results | Final matrix passed 11 files / 904 tests. Typecheck passed; build `sha256:4be1f95644138f743bfd9c991d0cc4201b99f11048538fed176c82a1671a7a60`; 535 source files passed architecture check; diff check passed. Independent Standards and Spec review found and verified repairs for successor supersession, session/pane/agent fencing, durable owner routing, post-decision resume failures and agent-kind reservation rejection. |
| Commits | `05fe4689` |
| Blocked by | T2 |

## Wave W4: `T4`

### - [x] T4: Extend fresh review cards to Worker Turn ownership

| Field | Content |
| --- | --- |
| What to build | Route Worker Turn Human Review choices through the shared fresh-card lifecycle in the Worker's independent canonical Feishu thread, while retaining the parent Primary Pane Ring for ordering and recovery. Preserve Worker identity/name, Worker generation, Worker-session generation, parent Binding fences and one deterministic follow-up Turn. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-7, SCN-8, SCN-9, SCN-10, SCN-12, SCN-13, INV-5, INV-6, INV-7, INV-8, INV-9, ARCH-1, ARCH-3 |
| Dependencies | T3 |
| Delegation eligibility | Eligible after T3: shared lifecycle is stable and Worker fixtures expose parent-scope and resulting-turn evidence without external access. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Worker Runtime owns Worker/parent fences and resulting follow-up. Completion Review owns the same presentation and decision lifecycle used by Primary. The visible card targets `WorkerTurnCardView.rootMessageId`; Delivery uses the parent Primary Pane Ring and retains Worker and parent ownership metadata in the Prepared Delivery. |
| Mutation ownership | src/composition/create-command-control-runtime.ts, src/coordinator/card-interaction-workflow.ts, src/coordinator/instance-messaging-workflow.ts, src/coordinator/worker-turn-card-workflow.ts, src/domain/ports/instance-workflows.ts, src/domain/ports/instance.ts, src/domain/ports/workflow.ts, src/store/sqlite/completion-review-store.ts, src/store/sqlite/instance-capability-store.ts, src/store/sqlite/prepared-delivery-store.ts, src/store/sqlite/projection-store.ts, src/store/sqlite/worker-turn-store.ts, src/store/sqlite/worker-turn/acceptance.ts, tests/card-interaction-integration.test.ts, tests/sqlite-store.test.ts, tests/t8-worker-task-stream-ring.test.ts, tests/worker-turn-card-workflow.test.ts |
| Exclusions | Primary owner changes, Worker Main blocked-episode Human Review, Worker removal/retargeting, installation, production state and remote Feishu actions. |
| Isolation | Serialized after T3 because shared callback routing and Action Set queries overlap. |
| Concurrency conflicts | T1, T2, T3, T5 |
| Verification seam | Worker completion fixture through independent Worker-thread card reservation and parent-Pane Ring claim, ACK, exact callback and one follow-up Turn, including parent/session drift and runtime-generation replacement. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; the child does not spawn, stage, commit, install, restart, deploy or access production. |
| Acceptance criteria and verification | The visible card is created in the canonical Worker thread and shows Worker name; parent-Pane Ring delivery is ordered; mention/controls are in the initial fresh card; exact Ring claim and ACK activate it; correct option/Ignore is one-shot; wrong Worker/session/parent/message/actor fails; runtime replacement supersedes stale review while preserving possible-effect evidence; uncertain create is not replaced; no standalone reminder exists; focused and shared regressions, typecheck/build pass. |
| Verification commands | `npx vitest run tests/sqlite-store.test.ts tests/worker-turn-card-workflow.test.ts tests/worker-turn-observer.test.ts tests/instance-turn-supervisor.test.ts tests/card-interaction-integration.test.ts tests/t8-worker-task-stream-ring.test.ts tests/conversation-segment-store.test.ts tests/answer-page-workflow.test.ts tests/prepared-delivery-store.test.ts tests/outbound-runtime-composition.test.ts tests/turn-card.test.ts tests/gateway-view.test.ts tests/card-action-command.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`. |
| Verification results | Final matrix passed 13 files / 954 tests. Typecheck passed; build `sha256:e89c5a2da72a11ff193b091efb4dfc9fb83c018a318017a4d186caf19023ec16`; 535 source files passed architecture check; diff check passed. Independent Standards and Spec review found and verified repairs for the real Worker Ring claim allowlist and cross-generation stale-review supersession. |
| Commits | `ced6402c` |
| Blocked by | T3 |

## Wave W5: `T5`

### - [x] T5: Complete recovery, retention and documentation

| Field | Content |
| --- | --- |
| What to build | Close shared startup reconciliation, retention and operational diagnostics for provisional/presenting/active review cards; remove new-flow inline-choice and standalone Worker-acknowledgement surfaces; make canonical Worker-owned Conversation Segments use the same Completion Review lifecycle as Primary; update architecture/domain/user docs and independently review all owner paths. |
| Spec references | SCN-8, SCN-9, SCN-10, SCN-11, SCN-12, SCN-13, INV-8, INV-9, INV-10, INV-11, ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-5 |
| Dependencies | T4 |
| Delegation eligibility | Eligible: repository recovery, retention, bounded status and docs work have deterministic SQLite and documentation seams and require no production credentials. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Completion Review startup reconciliation adopts only linked SQLite evidence. Retention preserves live presentation links. Delivery status exposes bounded counts without payloads. Canonical Worker Agent Input projects a Worker-owned Segment/Turn Card and uses the shared review lifecycle in its own Worker Thread with parent Ring fences. Architecture docs record the authoritative interaction surface and correct obsolete standalone-mention and accepted-card prose. |
| Mutation ownership | docs/architecture.md, docs/domain/conversation-projection/CONTEXT.md, docs/domain/delivery-operations/CONTEXT.md, docs/feishu-group-usage.md, src/cards/completion-actions.ts, src/cards/cardkit-application-presentation.ts, src/cards/instance-control-card.ts, src/coordinator/startup-view-converger.ts, src/coordinator/turn-card-workflow.ts, src/coordinator/worker-session-thread-workflow.ts, src/coordinator/instance-interaction-workflow.ts, src/domain/completion-action-set.ts, src/domain/ports/presentation.ts, src/domain/ports/workflow.ts, src/domain/types.ts, src/store/sqlite/capability-graph.ts, src/store/sqlite/completion-notification-store.ts, src/store/sqlite/completion-review-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/operations-store.ts, src/store/sqlite/outbox-delivery-store.ts, src/store/sqlite/outbox-retention-store.ts, src/store/sqlite/prepared-delivery-store.ts, src/store/sqlite/projection-gap-store.ts, src/store/sqlite/projection-store.ts, src/store/sqlite/recovery-capability-store.ts, src/store/sqlite/retention-audit-store.ts, src/store/sqlite/worker-turn-store.ts, src/store/sqlite/worker-turn/projection.ts, tests/conversation-segment-store.test.ts, tests/projection-delivery-recovery-watchdog.test.ts, tests/retention-compaction-store.test.ts, tests/sqlite-store.test.ts, tests/startup-view-converger.test.ts, tests/t8-worker-task-stream-ring.test.ts, tests/worker-session-thread-workflow.test.ts |
| Exclusions | Push/PR, urgent/phone/SMS effects, remote deletion of old cards, unrelated Delivery Ring or latency redesign. |
| Isolation | Singleton serial wave; repository mutation precedes main-owned operational delivery. |
| Concurrency conflicts | T1, T2, T3, T4 |
| Verification seam | Startup/reopen adoption, uncertain preservation, retention references, bounded status, docs audit, artifact delivery checker and full repository suite. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; the child does not spawn, stage, commit, install, restart, deploy or access production. |
| Acceptance criteria and verification | Restart converges without duplicate card; retention never drops live evidence; terminal rows compact safely; docs match implementation; every scenario/invariant maps to committed tests; architecture/docs/public audits and full tests/typecheck/build pass. |
| Verification commands | 18-file T1-T5 Vitest integration matrix covering canonical Worker Segment review, startup, retention, status, Worker thread, prepared delivery, legacy compatibility and shared owner paths; `npm run docs:audit`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`; plan artifact checker. |
| Verification results | Final matrix passed 18 files / 1,103 tests. Documentation audit and typecheck passed; build `sha256:e51f975aa367fa0c744815ea8ff95e8cbff5dada68b49465146e278fe4996949`; 535 source files passed architecture check; diff check passed. Independent Standards and Spec review found and verified repairs for sole-surface legacy migration, canonical Worker Segment symmetry, Worker parent-Ring claim fencing, Worker stop race, minimal callback documentation and recovery contract tests. |
| Commits | `4e251f18` |
| Blocked by | T4 |

## Wave W6: `T6`

### - [x] T6: Install and prove the fresh-card interaction in Feishu

| Field | Content |
| --- | --- |
| What to build | Main performs final delivery review, immutable installation, forced restart under the existing user authorization, readiness/log verification and one configured Feishu fresh-card mention/button/callback E2E. No repository source mutation belongs to this ticket. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-7, SCN-8, SCN-9, INV-4, INV-5, INV-7, INV-8, INV-9, ARCH-3, ARCH-4 |
| Dependencies | T5 |
| Delegation eligibility | Ineligible: installation, user-systemd control, production observation and live Feishu mutation are main-only external authorities. |
| Delegation mode | main-local |
| Ownership and implementation path | Main consumes the reviewed repository artifact. Delivery and Operations evidence proves installed identity and readiness; configured Feishu evidence proves only the requested fresh-card interaction. |
| Mutation ownership | install.sh, scripts/swarm-service.sh |
| Exclusions | Source edits, SQLite repair, push, PR, unrelated production cleanup and latency redesign. |
| Isolation | Main-local singleton operational wave after the worktree is clean and delivery review passes. |
| Concurrency conflicts | T1, T2, T3, T4, T5 |
| Verification seam | Installed build identity, systemd MainPID/listener ownership, direct health/ready, structured logs and one exact owner/action/outbox/callback SQLite trace. |
| Host capacity | Main-local; no child slot required. |
| Direct-child boundary | delegation_allowed = false; no child is dispatched for operational authority. |
| Acceptance criteria and verification | Installed identity matches HEAD; readiness is green; fresh card creates one native mention notification with visible buttons; callback consumes once and creates one result; no standalone text reminder or replacement after uncertain effect exists. |
| Blocked by | T5 |
| Verification commands | `./install.sh`; `npm run swarm:restart -- --force`; `systemctl --user show herdr-agent-swarm.service`; direct configured `/health` and `/ready`; `npm run swarm:logs`; exact Action Set, Outbox and Submission Intent inspection for the configured live E2E. |
| Verification results | Immutable release build `sha256:38b12fd8c22f2fd4782fdd079311f492ab84c4a7cc756763a34f42d9a288b70d` at `56d30a65a30b` installed; systemd MainPID `3745005` owns `127.0.0.1:8788`; `/health=ok`, `/ready=ready`, Lark/Herdr/Core/lease are healthy. Live Action Set `completion-review:v3:e1a2897ea466616346b5b21663a08a555463c3113b6ab00a44ae726cc5a2f35c` delivered one native mention/button card, consumed option `number-1`, and created exactly one observed Submission Intent `completion-choice:v2:49a8df2fbcc52dd638689fef697e729f17671ae256880f6f603bcb90a40c2125`; no standalone reminder was emitted. |
| Commits | `56d30a65a30b25d7572aac944754b96222584935` |

## Final delivery checks

- [x] Every SCN, INV and ARCH reference is covered by at least one committed ticket test.
- [x] Every ticket has focused tests, typecheck, build, independent review and an attributable atomic commit.
- [x] Full `npm test`, architecture check and docs audit pass; artifact delivery checks pass after this evidence reconciliation; public audit reports only historical spec-coder path/trailer findings outside the final task-owned commits.
- [x] Worktree is clean before and after implementation commits; final task-owned commit messages contain no injected TRAE CLI trailer.
- [x] Installation and live Feishu mutation occurred only after repository delivery review and explicit user authorization.
- [x] Installed build identity, user-systemd ownership, `/health`, `/ready`, Lark and Herdr connections are verified.
- [x] Live E2E proves native mention notification, visible buttons, minimal callback, one durable resulting input and no standalone text reminder.
- [x] Push, PR and external publication remain separately unauthorized.
