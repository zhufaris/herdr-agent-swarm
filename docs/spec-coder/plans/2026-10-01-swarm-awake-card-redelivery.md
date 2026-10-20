# `/swarm awake` Card Redelivery Plan

Approved specification: [`/swarm awake` Card Redelivery](../specs/2026-10-01-swarm-awake-card-redelivery.md)

## Planning Record

- Workspace: isolated worktree at
  `/workspace/herdr-agent-swarm/.trae/worktrees/fix/swarm-awake-card-redelivery`
  on branch `worktree-fix/swarm-awake-card-redelivery`.
- Starting revision: `06de52dd0d647b4967d84a58c4f63e4466a3e704`.
- Rationale: the primary checkout contains concurrent, overlapping card,
  command, and projection work associated with the live `ri13` session. The
  isolated worktree starts from its committed HEAD and contains none of those
  uncommitted changes.
- Environment: Node `v24.14.1`, npm `11.11.0`; locked dependencies installed
  with `npm ci`.
- Green baseline after the required build prerequisite: `npm run build`
  passed and generated build identity
  `sha256:324a7a170879363b285e674f5d33aa1c08e4af56ecdf8ba67afdff5d40814c18`;
  `npm run typecheck` passed; `npm test` passed 235 files and 3,270 tests.
- The first test invocation ran before `dist/build-info.json` existed and
  therefore failed 11 `standalone-install` cases. Building first resolved the
  fixture prerequisite; the unchanged full suite then passed.
- Gate 1 design: approved by the user on 2026-10-01.
- Gate 2 specification: approved by the user on 2026-10-01.
- Gate 3 ticket set and implementation authorization: approved by the user on
  2026-10-01.

## Tickets

- [x] T1: Persist an atomic Primary card-redelivery operation

  **What to build:** Add the domain/store contracts and SQLite implementation
  for one durable, Command-Intent-keyed redelivery operation. The operation
  must select and fence the current Topic projection plus at most one eligible
  Answer page, reserve fresh Main and Answer snapshots in one transaction, and
  return a small outcome describing which surfaces were scheduled.

  **Spec references:** SCN-2, SCN-4, SCN-5, SCN-6, SCN-7, and SCN-8; INV-3
  through INV-8; ARCH-2, ARCH-3, and ARCH-5; Compatibility and Migration.

  **Ownership and implementation path:** Delivery Operations owns a new
  domain-facing redelivery store contract and durable operation record. Add an
  additive SQLite migration and a focused store module under `src/store/sqlite/`,
  then expose it through the capability graph and store bundle. The read phase
  returns a renderable snapshot with binding generation, Topic version,
  selected Run version, and Answer page identity. The reservation transaction
  revalidates all those fences, allocates canonical Main/Answer card sequences,
  advances stable redelivery snapshot revisions, records the Command Intent,
  and enqueues both effects atomically. Same-Intent retries return the stored
  result. A later Intent can reserve a higher revision for identical payload.
  Only `active` or `finished` pages with a visible message target are eligible;
  `creating` and `frozen` pages remain untouched.

  **Expected files:** a new domain port/type near
  `src/domain/ports/card-convergence.ts`, a focused SQLite redelivery store,
  schema/capability graph/store-bundle wiring, test-store helpers, and
  `tests/sqlite-store.test.ts` or a focused redelivery-store test file.

  **Acceptance criteria and verification:** Tests first prove active-Prompt
  selection, newest historical selection when no Prompt is active, Main-only
  behavior, latest-page-only behavior, frozen/creating exclusion, inactive and
  generation-stale rejection, atomic rollback, same-Intent idempotency across
  reopen, and higher revision for a later Intent. Prompt lifecycle, detached
  recovery, and queue rows remain unchanged. Run the focused SQLite tests,
  `npm run typecheck`, and `npm run build` before the atomic commit.

  **Blocked by:** None.

  **Implemented and verified:** Added migration 74, the dedicated
  `PrimaryCardRedeliveryStore` capability, fenced current/historical Answer
  selection, Command-Intent idempotency, canonical Main/Answer lane
  reservations, and atomic rollback coverage. Verified with
  `npx vitest run tests/primary-card-redelivery-store.test.ts
  tests/sqlite-lease-bootstrap.test.ts`, `npm run typecheck`, and
  `npm run build`.

- [x] T2: Implement and compose the presentation-aware redelivery workflow

  **What to build:** Add a `PrimaryCardRedelivery` application port and workflow
  that obtains the fenced persisted snapshot, renders the current Main Card and
  selected Answer page through `PrimaryPresentation`, and delegates one atomic
  reservation to T1. Construct it in outbound runtime composition and inject
  only the consumer port into command-control composition.

  **Spec references:** SCN-2, SCN-4, SCN-5, SCN-6, and SCN-8; INV-1, INV-2,
  INV-3, INV-4, and INV-7; ARCH-2, ARCH-4, ARCH-5, and ARCH-6.

  **Ownership and implementation path:** Conversation Projection supplies the
  persisted Topic/Run/Answer view and the existing Primary presentation owns
  card rendering. Delivery Operations owns the orchestration and durable
  reservation. Reuse the established Main Card gap warning and Answer page
  rendering rules without calling `converge(..., force)` and without teaching
  SQLite about Lark SDK types. The workflow may retry only a stale render/read
  race within a small bound; it cannot call Prompt dispatch, Agent drivers,
  terminal input, steering, stop, or pane control.

  **Expected files:** a focused coordinator workflow such as
  `src/coordinator/primary-card-redelivery.ts`, the new consumer port,
  `src/composition/create-outbound-runtime.ts`, outbound/command runtime result
  types, architecture-boundary coverage, and a focused workflow test.

  **Acceptance criteria and verification:** Workflow tests prove exact rendered
  payloads and page numbers, Main-only outcome, same-operation idempotency,
  stale/inactive failure, no mutation of frozen history, and zero calls to any
  Agent or pane-control capability. Architecture tests prove dependency
  direction and that normal Main/Answer convergence interfaces did not gain a
  force parameter. Run the focused workflow and architecture suites,
  `npm run typecheck`, and `npm run build` before the atomic commit.

  **Blocked by:** T1.

  **Implemented and verified:** Added `PrimaryCardRedeliveryWorkflow`, rendered
  selected Main/Answer snapshots with page-aware content and projection-gap
  warnings, bounded stale-read retry, outbound wake-up only for new scheduling,
  and outbound-runtime composition. Verified with the focused redelivery store
  and workflow suites, architecture-boundary suite, `npm run typecheck`, and
  `npm run build`.

- [x] T3: Route `/swarm awake` recovery fallback to durable redelivery

  **What to build:** Preserve the existing detached-transcript recovery as the
  first action, then invoke T2 only for `no_detached_prompt` and
  `no_complete_later_turn`. Pass the durable Command Intent ID and frozen
  binding generation. Update command status rendering so it reports scheduled
  Main-plus-Answer, scheduled Main-only, duplicate scheduling, detached-with-
  redelivery, or fenced failure without claiming Lark delivery.

  **Spec references:** SCN-1, SCN-2, SCN-3, SCN-7, SCN-8, and SCN-9; INV-1
  through INV-6; ARCH-1 and ARCH-6; Behavior and Selection Rules; Failure Modes
  and Recovery.

  **Ownership and implementation path:** `CommandIntentDispatcher` remains the
  recovery-first orchestrator. Change `/swarm awake` from `active-turn` to
  `primary-session` scope while retaining creator authorization and
  reconcilable replay policy. The dispatcher must not fall back after
  successful transcript recovery, `busy`, `binding_not_active`,
  `recovery_unavailable`, or any unrecognized unsafe outcome. Existing command
  intent recovery supplies same-ID re-execution after process interruption;
  the durable redelivery operation makes that safe.

  **Expected files:** `src/coordinator/command-intent-dispatcher.ts`,
  `src/domain/swarm-command.ts`, command-control composition, presentation text,
  `tests/command-intent-dispatcher.test.ts`,
  `tests/swarm-command-gateway.test.ts`, and
  `tests/pane-thread-lifecycle-integration.test.ts`.

  **Acceptance criteria and verification:** Tests first prove that a successful
  transcript recovery suppresses redelivery; both approved fallback reasons
  schedule it; other outcomes do not; no-active-Prompt command admission works;
  stale Primary context fails before effects; same Command Intent does not
  duplicate effects; and no Prompt submission occurs in fallback cases. Run
  the focused dispatcher, gateway, pane-thread, redelivery, SQLite, and outbox
  suites, then `npm run typecheck` and `npm run build` before the atomic commit.

  **Blocked by:** T2.

  **Implemented and verified:** Changed `awake` admission to Primary-session
  scope, preserved detached transcript recovery as the first action, and routed
  only `no_detached_prompt` and `no_complete_later_turn` to durable redelivery.
  Added distinct scheduled, Main-only, duplicate, detached, and fenced outcome
  reporting without claiming delivery. Verified with dispatcher, command
  gateway, context-resolver, pane-lifecycle, redelivery, architecture,
  typecheck, and build checks.

- [x] T4: Document and verify the complete recovery-first operator contract

  **What to build:** Update user and architecture documentation to state that
  `/swarm awake` first attempts safe transcript recovery and otherwise schedules
  persisted Primary card redelivery. Document Main/Answer selection, Main-only
  behavior, asynchronous delivery wording, detached-blocker preservation,
  page-freezing rules, and the existing outbox recovery boundary.

  **Spec references:** all scenarios and invariants; Compatibility and
  Migration; Out of Scope.

  **Ownership and implementation path:** Update
  `docs/feishu-group-usage.md`, `docs/architecture.md`, and any command/help
  snapshots enforced by repository tests. Documentation must describe SQLite
  and Herdr as authoritative and must not imply that Lark card state controls
  execution. Review the final diff for accidental edits to live-service,
  install, or unrelated inline-action work.

  **Acceptance criteria and verification:** Documentation and command-definition
  tests agree with the implemented behavior. Run all affected suites, then the
  required final `npm run typecheck`, `npm run build`, and `npm test`. Confirm
  the full diff contains only this feature and its specification/plan. Do not
  install, restart, or deploy the service; those operations require a separate
  explicit user request and live-work safety check.

  **Blocked by:** T3.

  **Implemented and verified:** Updated the operator guide and architecture to
  describe recovery-first routing, the two exact redelivery fallback outcomes,
  current Main/latest-eligible-Answer selection, Main-only scheduling,
  asynchronous outbox delivery, Command-Intent idempotency, detached-blocker
  preservation, immutable page rules, and expired-target recovery. The first
  full-suite run exposed that migration 74's `primary_card_redeliveries` table
  was missing from the instance-lease trigger registry; fixed separately in
  commit `3eba4246` and reverified its focused lease/store suites. Final
  verification passed the affected 8 files and 306 tests, `npm run typecheck`,
  `npm run build` with build identity
  `sha256:661f9a12f02a5d62cc86dab1c7ed54054b2f89aa9cc11e9dec2cbcbb7f3daac5`,
  and `npm test` with 237 files and 3,293 tests.

## Delivery Order

```text
T1 durable SQLite operation
  -> T2 presentation-aware workflow and composition
     -> T3 recovery-first command integration
        -> T4 docs and full verification
```

Each ticket is implemented test-first and committed atomically after its
affected verification passes. No push, pull request, installation, service
restart, or deployment is part of this plan.
