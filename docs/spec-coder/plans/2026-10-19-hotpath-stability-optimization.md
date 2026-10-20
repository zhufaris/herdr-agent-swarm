# Hotpath Stability and Code-Elegance Optimization Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

The native implement-spec executor owns post-Gate-3 waves. The approved
specification is
`docs/spec-coder/specs/2026-10-19-hotpath-stability-optimization.md`.
The authoritative workspace is
`<repo-root>/.trae/worktrees/fix-ring-delivery-recovery`.
It is an existing isolated linked worktree on branch `fix/ring-delivery-recovery`.
The recorded wave base is
`3e2cb0f7ca6ce3b807ed0b485913022db0a815a4`; initial changes are none. The
main worktree remains dirty and is not touched.

Gate 1 selected the local deep-optimization design and Gate 2 approved the
specification. Gate 3 implementation authorization is pending. The plan is
serial: the read-only query-plan guard is the first wave, followed by one
implementation ticket per code surface. No installation, restart, deployment,
push, or production SQLite mutation is authorized by this plan.

The prepared baseline is recorded in the specification and all four records
were reusable during Gate 2 planning:

- Vitest: 316 files / 5277 tests, record `8ec2e0f379f14c01946bdb94a810b2d5`.
- Typecheck: record `01e03a8a99534474b5e119a2f4bdd193`.
- Build: record `a864152d3ea54546a88de7f0160f7fa9`, build
  `sha256:c779f08e05adf5cad2dd950669a4509be7eb1c3c99999e1636f2d57de28117df`.
- Architecture: record `98dba2b0e8cc4c1e8f3f8a8357ac2daf`, 553 source files.

## Wave W1: `T4`

### - [ ] T4: Verify production-shaped bounded page query plans

| Field | Content |
| --- | --- |
| What to build | Run read-only `EXPLAIN QUERY PLAN` evidence for the W4/W5 bounded Worker Turn, conversation segment, and startup recovery page predicates using representative row counts, upper bounds, cursor predicates, ordering, and existing indexes. |
| Spec references | SCN-6, INV-6, ARCH-4 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Read-only SQLite verification with a bounded fixture seam; no production database access or mutation. |
| Delegation mode | main-local; query-plan output controls whether later implementation proceeds without widening scope. |
| Ownership and implementation path | Main records the query plans and compares them with the bounded page contract; no runtime module owns new behavior. |
| Mutation ownership | None |
| Exclusions | No index, migration, SQL rewrite, runtime change, deployment, or live SQLite mutation. A material full scan returns to design before any related change. |
| Isolation | Serial read-only check in the authoritative isolated worktree at the recorded wave base. |
| Concurrency conflicts | None |
| Verification seam | Existing SQLite page-store fixtures plus representative `EXPLAIN QUERY PLAN` output for `conversation-segment-store.ts`, `worker-turn-store.ts`, and startup recovery page SQL. |
| Host capacity | Main-local; no child dispatch. |
| Build cache | None |
| Direct-child boundary | `delegation_allowed = false`; no staging, commit, installation, restart, deployment, or live database mutation. |
| Acceptance criteria and verification | Record plans for every selected page query. If all plans remain bounded/index-compatible, mark T4 complete and unblock T1/T2/T3. If a material scan, temp sort, or repeated correlated lookup appears, stop the affected mutation frontier and return the query decision to design. Run the focused SQLite/page tests and `git diff --check`; no source change is expected. |

## Wave W2: `T1`

### - [ ] T1: Batch historical delivery-debt evidence reads

| Field | Content |
| --- | --- |
| What to build | Refactor `SqliteOutboxRetentionStore.classifyHistoricalDeliveryDebt()` to prefetch bounded recovery, replacement, quarantine, projection-gap, and classification evidence per maintenance page, deduplicate shared replacement confirmations, and preserve the existing transaction and proof predicates. |
| Spec references | SCN-1, SCN-2, INV-1, INV-2, INV-3, ARCH-1 |
| Dependencies | T4 |
| Blocked by | T4 |
| Delegation eligibility | Bounded SQLite performance refactor with an existing public store seam, focused fixtures, and no new external effect. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteOutboxRetentionStore` owns the batched evidence snapshot and set-oriented transitions; existing `confirmDeliveryRecoveries`, `confirmAnswerRecoveries`, quarantine, gap, and classification rules remain the policy boundaries. |
| Mutation ownership | src/store/sqlite/outbox-retention-store.ts, tests/retention-compaction-store.test.ts, tests/retention-audit-store.test.ts |
| Exclusions | No schema migration, index change, recovery-policy change, retention-window change, cursor redesign, delivery-ring change, or production database mutation. |
| Isolation | Serial worker in the authoritative isolated worktree; main validates the recorded base and T4 result before dispatch. |
| Concurrency conflicts | None |
| Verification seam | `SqliteOutboxRetentionStore.classifyHistoricalDeliveryDebt()` with shared replacement IDs, multiple projection gaps, unresolved/settled recoveries, active quarantine, uncertain effect, missing evidence, and transaction-failure fixtures. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | `delegation_allowed = false`; main supplies the common brief; no indirect delegation, staging, commit, installation, restart, deployment, or live SQLite mutation. |
| Acceptance criteria and verification | Candidate pages produce the same counts, state transitions, cursor, quarantine releases, gap settlements, and historical classifications as before; partial evidence or transaction failure leaves no unsafe mutation. Run retention-focused Vitest suites, typecheck, build, architecture check, and diff check. |

## Wave W3: `T2`

### - [ ] T2: Make CardKit payload budgeting deterministic and linear in control work

| Field | Content |
| --- | --- |
| What to build | Extract a pure payload-budget measurement seam and remove avoidable repeated serialization/sorting from Turn Card truncation and Answer Timeline page planning while preserving exact rendered output, tool-group indivisibility, page cursors, projected IDs, and frozen-page behavior. |
| Spec references | SCN-3, SCN-4, INV-4, ARCH-2 |
| Dependencies | T4 |
| Blocked by | T4 |
| Delegation eligibility | Pure presentation-layer refactor with deterministic public render/planning seams and no persistence or provider effect. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `turn-card.ts` owns final payload overflow handling; `answer-timeline-page.ts` owns page planning. A shared cards-layer helper may measure serialized structures but cannot own cursors or durable state. |
| Mutation ownership | src/cards/turn-card.ts, src/cards/answer-timeline-page.ts, tests/turn-card.test.ts, tests/answer-timeline-page.test.ts |
| Exclusions | No CardKit schema change, visible copy change, choice-list change, page-index change, timeline ordering change, SQLite read, or delivery behavior change. |
| Isolation | Serial worker after T4 in the authoritative isolated worktree; main validates T4 and the prior accepted state before dispatch. |
| Concurrency conflicts | None |
| Verification seam | `boundCardPayload()` and `planAnswerTimelinePage()` with under-limit, shrinkable overflow, fixed/action-only overflow, human boundaries, markdown offsets, tool groups, prefix items, projected IDs, and continuation cursors. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, installation, restart, deployment, or live SQLite mutation. |
| Acceptance criteria and verification | Before/after semantic CardKit payloads and timeline page results are equal for existing fixtures; repeated measurement and candidate ordering are bounded without weakening the final overflow guard. Run focused card suites, typecheck, build, architecture check, and diff check. |

## Wave W4: `T3`

### - [ ] T3: Bound controller MCP socket responses and deadlines

| Field | Content |
| --- | --- |
| What to build | Harden `controller-tools-mcp.ts` socket calls with explicit maximum response bytes, request deadline, newline-framed response handling, and cleanup on success, early close, parse failure, oversize, socket error, and timeout. |
| Spec references | SCN-5, INV-5, ARCH-3 |
| Dependencies | T4 |
| Blocked by | T4 |
| Delegation eligibility | Small adapter-boundary reliability change with a temporary Unix-socket test seam and no change to controller authorization. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | The CLI `call()` adapter owns transport limits and conversion errors; `handleControllerMcpRequest()` and the private controller gateway retain existing JSON-RPC, capability, scope, and confirmation behavior. |
| Mutation ownership | src/cli/controller-tools-mcp.ts, tests/controller-tool-gateway.test.ts |
| Exclusions | No controller tool additions, capability changes, retry policy, server gateway rewrite, socket pooling, remote network support, or external side effect. |
| Isolation | Serial worker after T2 in the authoritative isolated worktree; main validates the recorded base and preceding accepted tickets before dispatch. |
| Concurrency conflicts | None |
| Verification seam | Exported controller MCP request handler plus temporary Unix socket fixtures for valid, fragmented, oversized, timed-out, early-close, malformed, and cleanup cases. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | `delegation_allowed = false`; no indirect delegation, staging, commit, installation, restart, deployment, or live SQLite mutation. |
| Acceptance criteria and verification | Valid responses remain identical; every bounded transport failure rejects promptly, never retries a controller action, and leaves no timer/socket resource behind. Run focused controller MCP tests, typecheck, build, architecture check, and diff check. |

## Final delivery checks

Main reviews each accepted ticket against the specification, performs fresh
affected verification after each integration, and commits one atomic
Conventional Commit per completed ticket. Before completion, run the full
Vitest suite, typecheck, build, architecture check, specification/plan artifact
checks, and diff check freshly. Delivery review must report findings first.
No merge, install, restart, deployment, push, or production SQLite mutation is
authorized by this plan.
