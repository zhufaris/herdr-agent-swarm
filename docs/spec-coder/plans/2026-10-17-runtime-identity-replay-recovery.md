# Runtime identity replay recovery plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

The native implement-spec executor will execute this graph only after explicit Gate 3 implementation authorization.

- Specification: `docs/spec-coder/specs/2026-10-17-runtime-identity-replay-recovery.md`
- Authoritative workspace: `<repo-root>/.worktrees/fix/runtime-identity-recovery`
- Branch: `fix/runtime-identity-recovery`
- Recorded wave base: `dc971d9869b1b077b21dfd1e2c8c8f4652585bfb`
- Workspace mode: isolated Git worktree; initial changes none
- Delivered candidate: T1-T5 and both delivery-review repair passes are committed locally; the final plan records their rewritten trailer-free identities
- Isolation requirement: retain this authoritative worktree; all five tickets are serial singletons because their persistence and retention seams overlap
- Permitted preparation: repository-local ignored cache and installed lockfile dependencies only
- Permitted integration: main-owned inspection, verification, staging, atomic ticket commits, and checkbox advancement only; no deployment, restart, push, PR, or production mutation
- Gate 2: approved interactively for the expanded Thin Inbox specification
- Gate 3: approved interactively on 2026-10-17; option A authorized the five serial tickets and their recorded order
- Reopened Gate 3: approved interactively on 2026-10-17; option A added `src/store/sqlite/runtime-stores.ts` to T3 mutation ownership only, with design, dependencies, and durable waves unchanged
- Reopened Gate 3 for T5: approved interactively on 2026-10-17; option A added `src/composition/create-outbound-runtime.ts`, `src/domain/ports/retention-compaction.ts`, `src/store/sqlite/retention-compaction-store.ts`, and `tests/retention-compaction-store.test.ts` to T5 mutation ownership only, with design, dependencies, and durable waves unchanged
- Durable execution: five ordered singleton waves; later waves depend on accepted commits from earlier waves

## Wave W1: `T1`

### - [x] T1: Settle diagnostic and canonical-enrichment replays atomically

| Field | Content |
| --- | --- |
| What to build | Let canonical Core ingestion durably retain `source_error` diagnostics while atomically ignoring their conversation projection and advancing the checkpoint; preserve verified human-message submission/choice enrichment when an otherwise identical historical replay omits it. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded and reversible persistence behavior at one existing SQLite store seam with deterministic in-memory tests and no credentials or external effects. |
| Delegation mode | main-local |
| Ownership and implementation path | `CoreEventInboxStore` owns replay identity merge, lane settlement, projection dispatch, and checkpoint mutation. Accept or repair the preserved candidate only after fresh focused Red/Green evidence, then update its architecture contract. |
| Mutation ownership | `src/store/sqlite/core-event-inbox-store.ts`, `tests/core-event-inbox-store.test.ts`, `docs/architecture.md` |
| Exclusions | Semantic skeletons, retention rollout/configuration, compaction, Herdr Core changes, event codecs, migrations, production rows, deployment, restart, push, and PR. |
| Isolation | One serial implementer in the authoritative isolated worktree at the recorded wave base. |
| Concurrency conflicts | T2, T3, T4, T5 |
| Verification seam | Store-level tests for `source_error + healthy neighbour`, canonical enriched human replay without enrichment, duplicate/stale replay atomicity, and preserved rejection of conflicting choice/actor/turn/text. |
| Host capacity | One direct-child slot if delegation is permitted; otherwise main-local. |
| Build cache | `<repo-root>/.cache/fix/runtime-identity-recovery/target` |
| Direct-child boundary | `delegation_allowed = false`; main owns candidate attribution, Red acceptance, integration, staging, commit, plan advancement, delivery review, and completion. |
| Acceptance criteria and verification | A source-error batch commits durable evidence, ignored lane state, and checkpoint without invoking conversation projection; its healthy neighbour remains processable. An unenriched replay preserves exact durable submission/choice evidence, creates no duplicate projection, settles the replay lane, and advances its checkpoint. Conflicting enrichment or immutable message identity still fails closed. Run `npx vitest run tests/core-event-inbox-store.test.ts tests/core-session-ingestion.test.ts`, `npm run typecheck`, `npm run build`, and `git diff --check`. |
| Verification commands | `npx vitest run tests/core-event-inbox-store.test.ts tests/core-session-ingestion.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm run docs:audit`; `npm test -- --maxWorkers=8`; `git diff --check` |
| Verification results | Snapshot-entry Red failed because `source_error` reached conversation projection; Green passed. Focused suites passed 154 tests. Delivery review then proved that a conflicting typed replay and compacted diagnostic replay bypassed the intended guards; the repair Reds failed for the exact outcomes and the integrated Green passed 146 affected tests. Architecture checked 550 source files; docs audit, typecheck, build, and diff check passed; the final full suite passed 313 files and 5,176 tests. |
| Commits | `a1ef0fe2`, `7f8590e8` |

## Wave W2: `T2`

### - [x] T2: Introduce one transport-independent Core semantic identity

| Field | Content |
| --- | --- |
| What to build | Extract one deterministic Core-event semantic identity/hash used by Inbox dedupe, compacted replay comparison, and authoritative snapshot compatibility; exclude transport source/cursor, normalize a missing legacy Turn to `null`, and exempt generated occurrence time only for `record_skipped`. |
| Spec references | SCN-3, SCN-6, INV-3, ARCH-1, ARCH-2, ARCH-6 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Pure deterministic identity logic plus bounded SQLite compatibility callers and focused table-driven tests. |
| Delegation mode | main-local |
| Ownership and implementation path | A small shared store-domain module owns semantic normalization and hashing. `CoreEventInboxStore` and `SqliteAuthoritativeTurnSnapshotStore` consume it rather than maintaining private JSON equality rules; unknown or malformed values remain fail-closed. |
| Mutation ownership | `src/store/sqlite/core-event-identity.ts`, `src/store/sqlite/core-event-inbox-store.ts`, `src/store/sqlite/authoritative-turn-snapshot-store.ts`, `tests/core-event-identity.test.ts`, `tests/core-event-inbox-store.test.ts`, `tests/authoritative-turn-snapshot-store.test.ts` |
| Exclusions | Retention eligibility, payload clearing, rollout configuration, Core protocol changes, production mutation, deployment, restart, push, and PR. |
| Isolation | One serial implementer based on accepted T1. |
| Concurrency conflicts | T1, T3, T4 |
| Verification seam | Table-driven semantic-hash tests cover transport changes, `record_skipped` time, business occurrence time, malformed payloads, typed human enrichment, compacted duplicate, and snapshot conflicts. |
| Host capacity | One direct-child slot if delegation is permitted; otherwise main-local. |
| Build cache | `<repo-root>/.cache/fix/runtime-identity-recovery/target` |
| Direct-child boundary | `delegation_allowed = false`; main owns Red acceptance, integration, staging, commit, and plan advancement. |
| Acceptance criteria and verification | Equivalent semantics produce one stable hash across source/cursor changes; immutable semantic differences reject. Inbox and authoritative snapshot compatibility call the shared implementation, and compacted rows compare incoming semantics without parsing JSON `null` as an event. Run identity, Inbox, and authoritative-snapshot suites plus `npm run typecheck`, `npm run build`, and `git diff --check`. |
| Verification commands | `npx vitest run tests/core-event-identity.test.ts tests/core-event-inbox-store.test.ts tests/authoritative-turn-snapshot-store.test.ts tests/retention-compaction-store.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `npm test -- --maxWorkers=8`; `git diff --check` |
| Verification results | Module-import Red proved the shared identity seam was absent. Green passed 119 focused tests. Delivery review added fail-closed Reds for unknown and malformed known payloads; the integrated Green passed 146 affected tests. Architecture checked 550 source files; docs audit, typecheck, build, and diff check passed; the final full suite passed 313 files and 5,176 tests. |
| Commits | `5fc7b65b`, `7f8590e8` |

## Wave W3: `T3`

### - [x] T3: Audit Thin Inbox eligibility without payload loss

| Field | Content |
| --- | --- |
| What to build | Add bounded Core-event audit pages that evaluate the 24-hour window and complete settlement/recovery barriers, create or confirm semantic skeleton evidence, and report eligible/refused counts and bytes without clearing `event_json`. |
| Spec references | SCN-4, SCN-7, INV-4, INV-5, INV-7, ARCH-3 |
| Dependencies | T2 |
| Blocked by | T2 |
| Delegation eligibility | Bounded transactional retention behavior with deterministic SQLite fixtures and no external effects. |
| Delegation mode | main-local |
| Ownership and implementation path | `SqliteRetentionAuditStore` owns all-lane settlement, terminal/reconstructible owner evidence, gap/quarantine/recovery barriers, human exclusion, and semantic skeleton links. `SqliteRetentionCompactionStore` or a narrow Core maintenance seam owns bounded page cursors in audit-only mode. |
| Mutation ownership | `src/domain/ports/retention-audit.ts`, `src/domain/ports/retention-compaction.ts`, `src/domain/retention-barrier.ts`, `src/store/sqlite/retention-audit-store.ts`, `src/store/sqlite/retention-compaction-store.ts`, `src/store/sqlite/runtime-stores.ts`, `tests/retention-audit-store.test.ts`, `tests/retention-compaction-store.test.ts` |
| Exclusions | Payload clearing, compact mode wiring, human-message compaction, VACUUM, physical schema contraction, deployment, restart, push, and PR. |
| Isolation | One serial implementer based on accepted T2. |
| Concurrency conflicts | T1, T2, T4, T5 |
| Verification seam | SQLite fixtures cover exact 24-hour boundary, every-lane settlement, human exclusion, pending/quarantined/open-gap/unresolved-recovery/nonterminal refusal, terminal reconstruction, ignored diagnostics, skeleton conflicts, bounded cursor restart, and audit-only payload preservation. |
| Host capacity | One direct-child slot if delegation is permitted; otherwise main-local. |
| Build cache | `<repo-root>/.cache/fix/runtime-identity-recovery/target` |
| Direct-child boundary | `delegation_allowed = false`; main owns Red acceptance, integration, staging, commit, and plan advancement. |
| Acceptance criteria and verification | Audit pages never modify `event_json` or `payload_compacted_at`; eligible rows get verified semantic skeletons and exact links, while every named recovery barrier yields a stable refusal. Human events always retain full payloads. Work remains page-, batch-, yield-, and time-budget bounded. Run retention audit/compaction suites plus `npm run typecheck`, `npm run architecture:check`, `npm run build`, and `git diff --check`. |
| Verification commands | `npx vitest run tests/retention-barrier.test.ts tests/retention-audit-store.test.ts tests/retention-compaction-store.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `npm test -- --maxWorkers=8`; `git diff --check`; plan artifact check |
| Verification results | Missing 24-hour audit API produced the initial Red. Green passed 47 focused tests. Delivery review exposed owner-terminal age, owner-gap, and exact-turn recovery omissions; focused Reds failed for each unsafe eligibility path, then the integrated Green passed 146 affected tests. Architecture checked 550 source files; docs audit, typecheck, build, diff and artifact checks passed; the final full suite passed 313 files and 5,176 tests. |
| Commits | `f43d95ec`, `07193bde`, `7f8590e8` |

## Wave W4: `T4`

### - [x] T4: Compact verified Core payloads and keep every reader replay-safe

| Field | Content |
| --- | --- |
| What to build | In compact mode, atomically revalidate the exact candidate and semantic skeleton before replacing eligible `event_json` with JSON `null`; make Inbox replay and every Core reader explicitly consume skeleton evidence, refuse with a typed recovery outcome, or select only uncompacted rows. |
| Spec references | SCN-5, SCN-6, SCN-7, INV-6, ARCH-4, ARCH-6 |
| Dependencies | T3 |
| Blocked by | T3 |
| Delegation eligibility | Persistence and reader hardening is deterministic and locally testable, but broad enough to require strict ownership and full affected verification. |
| Delegation mode | main-local |
| Ownership and implementation path | `SqliteRetentionCompactionStore` owns the single atomic skeleton-plus-payload transition. Inbox ingest validates compacted replays through T2 semantic identity. Authoritative snapshots, session activity, capability graph, prompt/conversation recovery, human-review discovery, and discriminator maintenance must not parse compacted JSON as live content. |
| Mutation ownership | `src/store/sqlite/retention-compaction-store.ts`, `src/store/sqlite/core-event-inbox-store.ts`, `src/store/sqlite/authoritative-turn-snapshot-store.ts`, `src/store/sqlite/session-activity-store.ts`, `src/store/sqlite/capability-graph.ts`, `src/store/sqlite/prompt-recovery-store.ts`, `src/store/sqlite/conversation-segment-store.ts`, `src/store/sqlite/human-review-candidate-store.ts`, `src/store/sqlite/prompt-dispatch-store.ts`, `src/store/sqlite/core-event-discriminators.ts`, `tests/retention-compaction-store.test.ts`, `tests/core-event-inbox-store.test.ts`, `tests/authoritative-turn-snapshot-store.test.ts`, `tests/session-activity-store.test.ts`, `tests/sqlite-capability-graph.test.ts`, `tests/conversation-segment-store.test.ts`, `tests/core-event-recovery.test.ts` |
| Exclusions | Human-message compaction, weakening recovery barriers, auto replay of uncertain effects, Core changes, VACUUM, deployment, restart, push, and PR. |
| Isolation | One serial implementer based on accepted T3; preflight must freeze the complete `event_json` reader inventory before Red. |
| Concurrency conflicts | T1, T2, T3, T5 |
| Verification seam | Compact transition tests prove atomic skeleton/state/payload CAS and rollback. Replay tests cover same-semantic duplicate, stale CAS, legitimate new-owner projection from incoming payload, and mismatch rejection. Reader suites cover compacted rows explicitly. |
| Host capacity | One direct-child slot if delegation is permitted; otherwise main-local. |
| Build cache | `<repo-root>/.cache/fix/runtime-identity-recovery/target` |
| Direct-child boundary | `delegation_allowed = false`; main owns reader-inventory acceptance, Red acceptance, integration, staging, commit, and plan advancement. |
| Acceptance criteria and verification | Skeleton verification and `event_json='null'` commit together or both roll back. A semantic duplicate remains safe, a new legitimate owner can project from the incoming payload, and mismatches fail closed. No reader treats JSON `null` as a Core envelope. Run Inbox, retention, snapshot, session-activity, capability, prompt/conversation recovery, migration, and integrity suites plus typecheck, architecture check, build, and diff check. |
| Verification commands | `npx vitest run tests/retention-audit-store.test.ts tests/retention-compaction-store.test.ts tests/core-event-inbox-store.test.ts tests/authoritative-turn-snapshot-store.test.ts tests/session-activity-store.test.ts tests/sqlite-capability-graph.test.ts tests/conversation-segment-store.test.ts tests/core-event-recovery.test.ts tests/detached-core-recovery.integration.test.ts tests/primary-prompt-dispatcher.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `env TMPDIR=<repo-root>/.cache/t npm test -- --maxWorkers=8`; `git diff --check` |
| Verification results | Focused suites passed 326 tests. Delivery review added compacted-diagnostic and compacted-nonterminal authoritative replay Reds; the repair preserved source-error settlement and generalized discriminator-plus-semantic-hash compatibility. The integrated Green passed 146 affected tests. Typecheck, architecture (550 files), docs audit, build, and diff check passed; the final full suite passed 313 files and 5,176 tests using the short actual cache TMPDIR required by the host's full `/tmp`. |
| Commits | `22a687f2`, `7f8590e8` |

## Wave W5: `T5`

### - [x] T5: Wire an independently stoppable Core retention rollout

| Field | Content |
| --- | --- |
| What to build | Add Core-event retention mode `off\|audit\|compact` with a 24-hour default window, independently schedule bounded audit/compact work, expose counts/bytes/refusals, and document audit-first rollout and logical-versus-physical compaction. Defaults keep Core work off. |
| Spec references | SCN-4, SCN-5, SCN-8, INV-7, INV-8, ARCH-5, ARCH-7 |
| Dependencies | T4 |
| Blocked by | T4 |
| Delegation eligibility | Configuration, maintainer orchestration, observability, and documentation have deterministic seams and no production activation. |
| Delegation mode | main-local |
| Ownership and implementation path | Configuration owns validated mode/window values; `OutboxRetentionMaintainer` applies a separate Core source policy while preserving the existing payload source behavior. Status/log projections report bounded aggregates only. Architecture and operator docs define audit-first activation and separate physical reclamation authority. |
| Mutation ownership | `src/config.ts`, `src/main.ts`, `src/composition/create-outbound-runtime.ts`, `src/runtime/outbox-retention-maintainer.ts`, `src/domain/ports/retention-compaction.ts`, `src/domain/types.ts`, `src/store/sqlite/operations-store.ts`, `src/store/sqlite/retention-compaction-store.ts`, `src/cards/operations-card.ts`, `.env.example`, `README.md`, `docs/architecture.md`, `tests/config.test.ts`, `tests/outbox-retention-maintainer.test.ts`, `tests/retention-compaction-store.test.ts`, `tests/health-snapshot-collector.test.ts`, `tests/operations-card.test.ts`, `tests/setup-config.test.ts` |
| Exclusions | Enabling audit/compact in production, deployment, restart, direct database writes, VACUUM, database replacement, dependency upgrades, push, and PR. |
| Isolation | One serial implementer based on accepted T4. |
| Concurrency conflicts | T1, T3, T4 |
| Verification seam | Configuration tests prove default `off`, accepted modes, invalid values, and independent 24-hour window. Maintainer tests prove `off` does nothing, `audit` never clears payloads, `compact` uses the same bounds, failures are isolated, and source rotation/time budget remain bounded. |
| Host capacity | One direct-child slot if delegation is permitted; otherwise main-local. |
| Build cache | `<repo-root>/.cache/fix/runtime-identity-recovery/target` |
| Direct-child boundary | `delegation_allowed = false`; main owns Red acceptance, integration, staging, commit, and plan advancement. |
| Acceptance criteria and verification | Core mode is independently stoppable and defaults off; audit and compact retain existing SQLite authority, checkpoints, no-replay, and outbox semantics. Logs/status expose counts, bytes, and refusal categories without payloads. Docs state that JSON clearing only makes pages reusable and does not reclaim filesystem space. Run config, maintainer, retention, status/card, setup/config, docs audit, architecture check, typecheck, build, full tests with bounded workers, and `git diff --check`. |
| Verification commands | `env TMPDIR=<repo-root>/.cache/t npx vitest run tests/health-server.test.ts tests/config.test.ts tests/outbox-retention-maintainer.test.ts tests/retention-compaction-store.test.ts tests/health-snapshot-collector.test.ts tests/operations-card.test.ts tests/setup-config.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run docs:audit`; `npm run build`; `env TMPDIR=<repo-root>/.cache/t npm test -- --maxWorkers=8`; `git diff --check` |
| Verification results | Configuration/maintainer/status Green passed 150 focused tests after Red proved mode/window and independent scheduling were absent. Delivery review corrected retained-byte reporting so compacted skeleton metadata no longer counts as retained payload. The integrated repair Green passed 146 affected tests. Typecheck, architecture (550 files), docs audit, build, and diff check passed; the final full suite passed 313 files and 5,176 tests using the short actual cache TMPDIR required by the host's full `/tmp`. |
| Commits | `e0f201ee`, `7f8590e8` |

## Final delivery checks

Main performs findings-first Standards and Spec reviews, freshly runs every affected focused suite, `npm run typecheck`, `npm run architecture:check`, `npm run docs:audit`, `npm run build`, `git diff --check`, and `npm test -- --maxWorkers=8`. It runs the delivery artifact checker, confirms one atomic commit per completed ticket and no unrelated/user-owned changes, and reports deployment as excluded unless separately authorized.
