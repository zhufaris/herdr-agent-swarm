# Core Session Ring Epoch-Transition Recovery Plan

Specification:
`docs/spec-coder/specs/2026-10-07-core-session-epoch-rebase.md`

Workspace preparation:

- Isolated worktree: `/tmp/herdr-agent-swarm-core-epoch-rebase`.
- Branch: `fix/core-epoch-rebase`.
- Wave base: `b14550f3510acc50d837b81d588462dc43a2eb60`.
- Initial changes: none before specification writing.
- Dependencies: installed from the existing lockfile with `npm ci`; no package
  or lockfile changes.
- Fresh baseline: reader/inbox tests 59/59; architecture check passed for 504
  source files; typecheck and build passed with build identity
  `sha256:b28eae2990a1bff3e486f82d8579d4ee3adcf8e80c987093a5634f8d12b3dc2b`.
- Gate 1 design approval: approved 2026-10-07.
- Gate 2 specification approval: approved 2026-10-07.
- Gate 3 implementation authorization: approved in conversation on
  2026-10-07.
- Production database edits, installation, restart, deployment, and push remain
  excluded from this plan and require a separate rollout authorization.

## Tickets

- [x] **R1: Recover identity-stable Core session lanes across ring epoch transitions**

  | Field | Plan |
  | --- | --- |
  | What to build | Add the complete durable recovery slice: detect an identity-stable live/durable epoch mismatch before read, atomically record `cursor_epoch_changed` gap evidence and reset the checkpoint to the live epoch `start`, then ingest the replacement epoch. Permit one subsequent typed same-epoch expiry rebase and retain all no-replay, ordering, retry, and identity fences. |
  | Spec references | SCN-1 through SCN-6; INV-1 through INV-8; Reader decision, Store transition, Behavior & Failure Modes, and Compatibility & Migration. |
  | Dependencies | None. |
  | Delegation eligibility | Eligible for one strong direct worker after main establishes behavior Red. The scope is bounded and reversible, production credentials are unnecessary, and public reader/store seams provide independent verification. Main retains incident interpretation, Red acceptance, diff acceptance, commits, and rollout authority. |
  | Delegation mode | Default direct worker. Use the strong tier or inherit main if a compatible override is unavailable. |
  | Ownership and implementation path | Extend the domain-owned Core inbox interface with a named epoch-transition input/result; implement its exact-fenced transaction in SQLite; invoke it from `HerdrEventsReader.ingestCurrentSession` before the first v2 read; retain the existing same-epoch typed expiry path and supervisor retry/catch-up behavior. Do not reinterpret arbitrary adapter errors. |
  | Mutation ownership | `src/domain/core-event-inbox.ts`, `src/store/sqlite/core-event-inbox-store.ts`, `src/runtime/herdr-events-reader.ts`, `tests/core-event-inbox-store.test.ts`, `tests/core-session-ingestion.test.ts`, and `tests/core-session-ingestion.test.ts` supervisor cases only as needed. Main alone updates this plan checkbox. |
  | Exclusions | No Herdr Core code, adapter protocol change, SQLite schema migration, Agent Input submission change, direct production DB mutation, Completion Choice, cards, callbacks, outbox, installation, restart, deployment, or push. |
  | Isolation | Use the current isolated worktree at exact wave base. One mutating worker only; no parallel mutation is required. |
  | Concurrency conflicts | Owns all reader/store interface changes and cannot overlap R2 documentation because docs must reflect the accepted behavior. |
  | Verification seam | Red-Green through `HerdrEventsReader.ingestCurrentSession` with the production-shaped `epoch-3:164 -> epoch-2:0` fixture, and through `CoreEventInboxStore` for atomic gap/checkpoint semantics, race, rollback, and restart idempotency. Architecture check separately verifies dependency direction. |
  | Host capacity | Requires one direct-child slot; recheck live capacity immediately before Wave 1. |
  | Direct-child boundary | `delegation_allowed = false`; worker must not spawn directly or indirectly, stage, commit, touch production state, install, restart, deploy, or push. |
  | Acceptance criteria and verification | Empty and non-empty replacement epochs catch up; overflowed replacement epoch performs one additional typed expiry rebase; exact identity mismatches fail closed; competing handles have one winner; injected failure rolls back gap and checkpoint; restart does not duplicate gaps/events/projections/Input; independent healthy lanes progress; focused reader/inbox/supervisor tests, architecture check, typecheck, and build pass. |
  | Blocked by | None. |

- [x] **R2: Document epoch-transition recovery and operator evidence**

  | Field | Plan |
  | --- | --- |
  | What to build | Update current architecture and operator-facing documentation to distinguish same-epoch expiry from identity-stable epoch transition, describe durable gap/checkpoint ordering, and explain the readiness/log evidence used to verify recovery. |
  | Spec references | SCN-1 through SCN-6; INV-1 through INV-8; Architecture, Behavior & Failure Modes, Compatibility & Migration, and Out of Scope. |
  | Dependencies | R1. |
  | Delegation eligibility | Eligible for one standard direct worker after R1 is accepted and committed; claims are inspectable against committed source and tests. |
  | Delegation mode | Default serialized direct worker. Main retains claim verification and commit authority. |
  | Ownership and implementation path | Update only the existing Continuous session ingestion section in `docs/architecture.md` and the supported operator diagnosis/recovery guidance in `docs/feishu-group-usage.md` if that document contains the relevant current behavior. Avoid historical spec/plan rewrites. |
  | Mutation ownership | `docs/architecture.md`; `docs/feishu-group-usage.md` only when a current operator-facing section is applicable. Main alone updates this plan checkbox. |
  | Exclusions | No source, tests, historical specs/plans, generated files, live operations, database edits, installation, restart, deployment, or push. |
  | Isolation | Reuse the current isolated worktree after the R1 atomic commit. |
  | Concurrency conflicts | Must follow R1; no parallel wave. |
  | Verification seam | Source-to-doc review plus `npm run docs:audit`, documentation tests, and `git diff --check`. |
  | Host capacity | Requires one direct-child slot after Wave 1; recheck before Wave 2. |
  | Direct-child boundary | `delegation_allowed = false`; worker must not spawn directly or indirectly, stage, commit, operate production, install, restart, deploy, or push. |
  | Acceptance criteria and verification | Docs distinguish epoch transition from ordinary expiry, state the exact identity fence and atomic gap/checkpoint effect, retain no-replay authority, and give read-only evidence for confirming catch-up/readiness after a later authorized rollout. Documentation checks pass. |
  | Blocked by | R1. |

## Proposed Execution Waves

1. **Wave 1:** R1 as one isolated direct-worker TDD task after main observes
   the production-shaped Red.
2. **Wave 2:** R2 as one serialized direct-worker documentation task after R1
   is accepted, checked off, and committed.
3. **Delivery:** independent Standards and Spec reviews, any TDD repair commits,
   then fresh architecture, docs, typecheck, build, and full test verification.
4. **Rollout:** not authorized by Gate 3. After delivery, present the exact
   release/install/restart and live verification target for separate approval.

The Markdown checkboxes and atomic commits are the durable execution state.
Wave handles and capacity remain conversational and are recomputed at dispatch.
