# Answer Card Token and Choice Fallback plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

The native implement-spec executor owns the post-Gate-3 ticket waves. The
approved specification is
`docs/spec-coder/specs/2026-10-19-answer-card-token-and-choice-fallback.md`.
The authoritative workspace is
`<repo-root>/.trae/worktrees/fix-ring-delivery-recovery`;
execution is serial in the existing recovery worktree. The prepared baseline
was 660 focused tests, typecheck, build, and architecture check across 553
source files. Gate 2 and Gate 3 implementation authorization were explicitly
approved.

## Wave W1: `T1`

### - [x] T1: Generation-fenced Answer Card pane-token fallback

| Field | Content |
| --- | --- |
| What to build | Recreate `run_cards_view` so serialized Run Card views use the stored token first and same-generation Binding token as a read-time fallback; detect the compatibility view shape and rebuild it without a data backfill. |
| Spec references | SCN-1, SCN-3, INV-1, ARCH-1, ARCH-2 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded SQLite projection compatibility change with a direct test seam; no external effect. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `card-outbox-migrations.ts` owns view creation/rebuild detection; existing Projection Store consumes the view; SQLite tests own same-generation and generation-mismatch behavior. |
| Mutation ownership | src/store/sqlite/migrations/card-outbox-migrations.ts, tests/sqlite-store.test.ts |
| Exclusions | No run_cards bulk update, no Binding authority change, no CardKit SDK change, no deployment or restart. |
| Isolation | Serial worker in the authoritative workspace; main validates and commits the ticket. |
| Concurrency conflicts | None |
| Verification seam | Real SQLite view fixture with null Run Card token, same-generation Binding token, and mismatched-generation Binding token; assert loaded RunCardView and rendered Answer header. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | delegation_allowed = false; worker cannot delegate, stage, commit, install, restart, deploy, or mutate live SQLite. |
| Acceptance criteria and verification | Legacy fallback shows the current token; a mismatched generation remains null; existing view/migration tests remain green; focused tests, typecheck, build, architecture check, and diff check pass before the atomic commit. |
| Verification commands | `npx vitest run --configLoader runner tests/answer-card-header.test.ts tests/sqlite-store.test.ts`; `npx vitest run --configLoader runner tests/herdr-runtime-reconciler.test.ts tests/answer-card-header.test.ts tests/sqlite-store.test.ts -t 'pane token'`; `npm run typecheck`; `npm run build`; `npm run architecture:check`. |
| Verification results | Red reproduced null token for a same-generation Binding. Green passed 557 focused tests, then the active-runtime enrichment regression and legacy fallback checks passed after narrowing fallback to terminal Answer phases. Full Vitest passed 316 files and 5,262 tests; typecheck, build, architecture check (553 source files), and diff checks passed. |
| Commits | `0df8b5ff2942df18d64d062671ba553e6fd34f65`, `47eb95b1c7f310bea32db2c790a89e89b3fba3ae`, `c78021b8` |

## Wave W2: `T2`

### - [x] T2: Persist and render default Continue choice fallback

| Field | Content |
| --- | --- |
| What to build | Normalize valid terminal `herdr-choice-list` no-choice decisions into one durable Continue ChoicePrompt so the existing completion action set and choice-card renderer emit a Continue button; preserve explicit choices and ordinary answers. |
| Spec references | SCN-2, SCN-3, INV-2, ARCH-1 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded choice normalization/persistence change with protocol and durable-card seams; no external effect. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `completion-choice-store.ts` owns protocol-scoped fallback normalization and durable specification persistence; existing completion action/card renderers remain unchanged unless the seam proves a minimal compatibility adjustment is needed. |
| Mutation ownership | src/domain/completion-choice.ts, src/runtime/herdr-events/event-projector.ts, src/store/sqlite/completion-choice-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/prompt-dispatch-store.ts, src/store/sqlite/prompt-recovery-store.ts, tests/detached-core-recovery.integration.test.ts, tests/external-turn-observer.test.ts, tests/herdr-event-projector.test.ts, tests/sqlite-store.test.ts |
| Exclusions | No fallback for malformed or ordinary answers, no explicit-choice ordering change, no new schema, no Lark SDK change, no live SQLite mutation, no deployment or restart. |
| Isolation | Serial after W1 in the authoritative workspace; main validates and commits the ticket. |
| Concurrency conflicts | None |
| Verification seam | Protocol normalization fixture for `intent=none`/no actionable choice; durable completion-choice persistence and rendered callback button; explicit-choice and ordinary-answer negative cases; idempotent repeat. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | delegation_allowed = false; worker cannot delegate, stage, commit, install, restart, deploy, or mutate live SQLite. |
| Acceptance criteria and verification | A durable Continue action/card is generated for the valid no-choice protocol; explicit choices remain unchanged; ordinary answers still have no choice card; focused tests, typecheck, build, architecture check, and diff check pass before the atomic commit. |
| Verification commands | `npx vitest run --configLoader runner tests/sqlite-store.test.ts tests/completion-choice-protocol.test.ts tests/completion-choice-hook.test.ts tests/final-trace-envelope.test.ts tests/card-interaction-integration.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`. |
| Verification results | Initial Red returned `choice: null` and no durable specification. Green passed the durable Continue persistence/card callback/idempotency cases; the combined focused suite passed 685 tests. Delivery review then reproduced a P1 where attached projection and Core recovery dropped a valid no-choice signal after removing the fence. Repair Red covered projector, Core-lane recovery, active token boundaries, and canonical Conversation folds; repair Green passed the affected suites, fresh full Vitest passed 316 files and 5,262 tests, typecheck, build, architecture check (553 source files), and diff checks. |
| Commits | `8a88ef55156946061a57540d044df7b360ab0a52`, `5fd978e0`, `1441c540` |

## Final delivery checks

Main reviews both ticket diffs and the repair, runs fresh affected checks and full Vitest,
validates the delivery artifact, and records both atomic commit IDs before any
later merge, installation, or restart request.
