# Prepared Delivery Three-Attempt Terminal Skip Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Selected specification:
`docs/spec-coder/specs/2026-10-17-prepared-delivery-three-attempt-skip.md`.

The native implement-spec executor owns post-Gate-3 execution. It will hand the
singleton ticket to one `tdd-coder` lifecycle and, after main accepts the
ticket, hand the completed plan to `delivery-coder`.

Authoritative workspace:
`<repo-root>/.trae/worktrees/final-trace-envelope`.

Workspace mode: existing isolated Git worktree. The main checkout's user-owned
changes remain untouched.

Branch: `worktree-final-trace-envelope`.

Recorded wave base: `07dce9a2187ff48082c03da608eeda6f6d1ec9fc`.
Its tree is identical to the Gate-2-observed `main` tree.

Starting state: no product-code changes. The approved specification is the only
new file before this plan.

Baseline: the specification records fresh successful `npm test`,
`npm run typecheck`, and `npm run build` evidence under request
`hri5-delivery-skip-20261017-a`; all three records were reusable at Gate 2.

Isolation requirement: one serial mutating direct worker in the authoritative
isolated worktree. Main must not mutate ticket-owned files while that worker is
active. No additional per-worker worktree is required for this singleton wave;
parallel mutation is not permitted.

Permitted preparation: main may revalidate the authoritative workspace, wave
base, dependencies, evidence, live Host capacity, and the canonical ignored
build-cache reservation before dispatch. Creating another worktree, regrouping
the wave, changing ownership, or changing the recorded base requires renewed
Gate 3 approval.

Blocking edges: none.

Durable execution order: Wave W1 only. One active wave and one direct
implementer maximum.

Gate status: Gates 2 and 3 approved. W1/T1 implementation and integrated
verification are complete; final delivery review remains.
No push, installation, restart, deployment, production-data mutation, or
external publication is authorized.

## Wave W1: `T1`

### - [x] T1: Retry prepared delivery three times, then terminally skip

| Field | Content |
| --- | --- |
| What to build | Make every prepared conversation-page delivery, including uncertain failures, follow the existing three-attempt retry budget; after the third failed attempt, atomically persist an audited `dismissed` terminal state, dismiss linked recovery, release the exact page pending link, advance the pane-scope checkpoint, notify the Ring, and leave later page snapshots plus same-conflict and different-conflict deliveries eligible. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, ARCH-1, ARCH-2 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded and reversible change with complete approved inputs, no credentials or external mutation, exact file ownership, a real SQLite integration seam, and independently inspectable Red/Green and full-suite verification. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | In the Delivery persistence context, first extend the existing Ring hot-path SQLite tests to prove attempts one and two remain pending, attempt three becomes audited `dismissed`, fencing rejects stale callers, the original delivery cannot be reclaimed, the exact page link is released, and later page plus scope work is claimable. Then update `failConversationPageDeliveryMutation` to use `planDeliveryRetry` for uncertain and certain failures alike while keeping terminalization, page-link release, recovery dismissal, checkpoint advancement, and notification in the existing transaction. Preserve the current adapter boundary and compatibility return type. Delivery review additionally synchronizes the two authoritative behavior documents with the approved bounded uncertain-replay tradeoff. |
| Mutation ownership | src/store/sqlite/prepared-delivery-store.ts, tests/ring-delivery-hot-path.test.ts, docs/architecture.md, docs/feishu-group-usage.md |
| Exclusions | No edits to `src/domain/delivery-retry-policy.ts`, `src/domain/delivery-conflict.ts`, schemas, migrations, global `nonterminalReplySql`, quarantine/conflict-isolation behavior, other recovery paths, installation scripts, runtime configuration, or production data. No push, install, restart, deployment, or publication. |
| Isolation | Serial direct worker in the authoritative isolated worktree at recorded wave base `07dce9a2187ff48082c03da608eeda6f6d1ec9fc`; main performs no concurrent mutation and rechecks HEAD/status before accepting results. |
| Concurrency conflicts | None |
| Verification seam | Red/Green through `npx vitest run tests/ring-delivery-hot-path.test.ts -t "fences stale settlements while advancing past uncertain failures without blocking the Ring"` or a renamed behavior-focused replacement; then `python3 <trae-home>/plugins/cache/local/spec-coder/0.8.0/scripts/validate-affected.py --repo <repo-root>/.trae/worktrees/final-trace-envelope --path src/store/sqlite/prepared-delivery-store.ts --path tests/ring-delivery-hot-path.test.ts`, the complete affected test file, typecheck, build, and full suite. Main inspects the persisted row, checkpoint, claimability, no-quarantine evidence, and stale-fence outcomes rather than accepting field-copy assertions alone. |
| Host capacity | One direct-child slot required; main rechecks live capacity before dispatch and waits rather than changing wave membership when no slot is available. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; main supplies the approved spec, ticket, workspace/base, ownership, exclusions, Red/Green requirement, progress heartbeat, and verification commands. The worker must not delegate, stage, commit, install, restart, push, or touch files outside ownership. |
| Acceptance criteria and verification | Attempt one and two failures return the existing retry disposition, persist `pending` with attempt counts 1 and 2, and retain the same reply, gateway plan, snapshot, and idempotency identity. The third failure returns the compatibility no-more-retry disposition and commits `dismissed` with attempt count 3 plus complete failure metadata; linked recovery is dismissed, the exact page link and pending cursor are cleared, no quarantine exists, and the scope checkpoint advances in the same fenced transaction. An exhausted initial create becomes a finished local page; an exhausted existing-card update reconciles ready and permits a newer snapshot reservation. Later same-conflict and different-conflict deliveries are claimable without grace delay; the dismissed delivery cannot hydrate or execute again; stale failure/checkpoint/acknowledgement calls mutate nothing. Focused Red must fail for the intended behavior before product code changes, then focused Green, affected validation, complete `tests/ring-delivery-hot-path.test.ts`, `npm run typecheck`, `npm run build`, and `npm test` must pass. |
| Red evidence | Main first observed the behavior Red because uncertain attempt one returned `dead_letter` instead of `retry`. Delivery review then established a second Red: both an exhausted initial create and an exhausted existing-card update retained their dismissed reply in `pending_reply_id`, causing the two focused assertions to fail. |
| Delivery evidence | After the delivery-review repair, fresh affected verification passed `tests/ring-delivery-hot-path.test.ts`, `tests/prepared-delivery-store.test.ts`, `tests/conversation-segment-store.test.ts`, and `tests/turn-card-workflow.test.ts` (4 files / 273 tests). `npm run typecheck`, `npm run build` with identity `sha256:48d614c9eb076e1a33c70829746af2ee3f8046a5009427f55901d02c4d97884d`, `npm run architecture:check` (548 source files), `git diff --check`, and `npm test` all passed. The full suite remains 309 files / 5102 tests. The generic spec-coder affected mapper rejected this repository path as unmapped, so repository-native affected files and the full suite provide the recorded affected evidence. |
| Review evidence | Independent task review passed Spec and Task Quality with no Critical or Important findings. Fix round 1 aligned a stale one-attempt uncertain-update test; fix round 2 narrowed non-hydration to the durable `dismiss_attempt_budget` recovery marker. Final Standards review found stale authoritative documentation and a stranded Conversation Page link; the repair synchronizes both documents, releases the exact link transactionally, and adds Red/Green coverage for create retirement plus a newer real page reservation. Final post-repair dual-axis review remains required. One non-blocking Minor remains: the expanded fake-timer tests close their SQLite lifecycle on the success path rather than with local `try/finally`; global `afterEach` restores timers. |
| Verification commands | Focused behavior Red/Green; focused page-link Red/Green; `npx vitest run tests/ring-delivery-hot-path.test.ts tests/prepared-delivery-store.test.ts tests/conversation-segment-store.test.ts tests/turn-card-workflow.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check`; `npm test`. |
| Verification results | Both Reds failed for the intended reasons. The page-link focused Green passed 2/2 and the complete Ring file passed 53/53; final affected verification passed 4 files / 273 tests; typecheck, build, architecture, and diff checks exited 0; final full suite passed 309 files / 5102 tests. |
| Commits | Recorded in post-commit delivery evidence because the containing commit cannot embed its own immutable SHA. |
| Commit evidence | This plan is recorded in the same single atomic T1 commit as the implementation and tests. Its immutable SHA is created by Git after this content is fixed and is reported in the final handoff; embedding a commit's own SHA in its contents would change that SHA. |

## Final delivery checks

Main verifies that the accepted diff is limited to the ticket's mutation
ownership and maps every specification scenario and invariant to concrete test
evidence. Main runs the affected test file, affected-path validation,
`npm run typecheck`, `npm run build`, and the full `npm test` suite
freshly on the integrated state.

After successful review and verification, main creates one atomic local commit,
updates T1's checkbox and delivery-evidence rows with the actual commands,
results, and commit, then runs the spec-coder delivery checker. Delivery review
does not install, restart, deploy, push, mutate production data, or publish an
external issue/PR.
