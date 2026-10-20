# Immutable Core event projection plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-18-immutable-core-event-projection.md`, approved at reopened Gate 2. The native implement-spec executor will run each approved ticket through one `tdd-coder` Red-Green lifecycle and then hand the accepted range to `delivery-coder`.

The authoritative Swarm workspace is `<repo-root>/.trae/worktrees/final-trace-envelope`, branch `worktree-final-trace-envelope`, at recorded base `c057118c2a2f087b5137caa76e01ab4934da3b85`. Initial task-owned state is the untracked approved specification and this plan; the preserved `<repo-root>/.worktrees/fix/core-session-ingestion-replay` worktree and its seven provisional files are excluded. Fresh planning baseline on the recorded base passed `npm run typecheck`, `npm run build`, and the full 313-file/5,176-test Vitest suite.

The Swarm waves are serial and begin only after Core T1-T4 are accepted, atomically committed, and pass fresh Core delivery review in `<herdr-core-repo>/.worktrees/fix/immutable-event-projection`. The exact accepted Core head is recorded in the T5 worker brief as an external prerequisite; no Core replay API, event outbox, second cursor, or replay sidecar is consumed. Swarm W5-T5 then establishes immutable thin-inbox settlement, and W6-T6 adds event-scoped projection failure isolation and recovery. Main integrates and commits one ticket at a time. No installation, restart, deployment, push, pull request, live Feishu E2E, or production SQLite mutation is authorized.

The canonical build cache for all Swarm tickets is `<repo-root>/.cache/worktree-final-trace-envelope/target`. One default direct worker may use the authoritative isolated worktree at a time when capacity permits. `delegation_allowed = false`; only main may accept, stage, commit, update checkboxes, or declare completion.

Reopened Gate 3 was approved on 2026-10-18 after a public-seam Red proved that a rolled-back SQLite projection could leave the lane-scoped in-memory canonical projector advanced, causing pending recovery to settle an event without rebuilding its durable timeline item. The renewed approval adds `src/runtime/herdr-events-reader.ts` and `src/store/sqlite/capability-graph.ts` to T6 mutation ownership so the existing projector snapshot can be restored with the event savepoint. The ticket, wave, base, serial delegation mode, commit boundary, and excluded external effects are unchanged.

Reopened Gate 3 was approved again on 2026-10-18 after the fresh full suite exposed two legacy fixtures that still required a first-card reservation or Session Activity render failure to throw and roll back the entire Core batch and cursor. The renewed approval adds `tests/conversation-segment-store.test.ts` and `tests/session-activity-store.test.ts` to T6 mutation ownership only to replace those two whole-batch rollback expectations with event-scoped isolation assertions: immutable inbox and pending lane evidence remain, the single cursor advances, and partial Segment, Session Activity, Topic, and `outbound_replies` effects remain rolled back. Production ownership, ticket identity, wave, base, serial delegation mode, commit boundary, and excluded external effects are unchanged.

The separately authorized main-branch deployment exposed a T5 delivery defect: migration 140 had been added without advancing the current schema epoch, so an installed `2026-10-15.1` database with markers through 139 failed current-fast validation before the ordered migration could run. Delivery repair added `src/store/sqlite/schema-manifest.ts` to T5 mutation ownership, advanced the epoch to `2026-10-18.1`, routed the prior epoch through the existing lease-fenced ordered migration path, and added a Red-Green startup regression. No production marker was edited manually.

## Wave W5: `T5`

### - [x] T5: Settle immutable thin-inbox duplicates and conflicts

| Field | Content |
| --- | --- |
| What to build | Replace enrichment-aware Core event merging with immutable semantic equality. First admission stores the Core projection once; exact duplicates are idempotent; changed `submission_id`, typed `choice`, source-derived payload, or other projected content becomes a settled ignored conflict with bounded lane-item diagnostics. Continue valid events and advance the existing ring cursor without rewriting the settled event or canonical submission binding. Preserve compacted rows through immutable hash evidence only. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, INV-4, INV-8, INV-9, ARCH-1, ARCH-2, ARCH-6 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded deterministic identity, migration, and inbox settlement behavior is reversible, credential-free, and inspectable through temporary SQLite stores and exact batch outcomes. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `SqliteCoreEventInboxStore` owns consumer receipt and conflict settlement; `core-event-identity` owns immutable projection equality; the additive SQLite migration owns bounded conflict count/hash/reason/time fields on `core_event_lane_items`. Remove canonical alias replacement, choice preservation, generic merge, and historical `event_json` update paths. |
| Mutation ownership | src/store/sqlite/core-event-identity.ts, src/store/sqlite/core-event-inbox-store.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema.ts, src/store/sqlite/schema-manifest.ts, src/store/sqlite/migration-registry.ts, tests/core-event-identity.test.ts, tests/core-event-inbox-store.test.ts, tests/sqlite-migrations.test.ts, tests/retention-compaction-store.test.ts, tests/external-turn-observer.test.ts |
| Exclusions | Projection retry/savepoint behavior beyond deterministic conflicts, reader/subscriber protocol changes, any Core API, event outbox, replay cursor, Feishu network delivery, provisional worktree files, installation and deployment. |
| Isolation | Serial direct worker in the authoritative Swarm worktree at the exact main-accepted base; no concurrent Swarm mutation. |
| Concurrency conflicts | T6 |
| Verification seam | Identity unit tables plus temporary SQLite batch tests observe stored bytes/hashes, lane states and diagnostics, canonical submission binding, cursor high-water, compacted-row behavior, and valid events on both sides of a conflicting duplicate. |
| Host capacity | One direct-child slot; recheck immediately before dispatch and use main-local execution only if default delegation is unavailable. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common brief and Swarm implementation role with no indirect delegation, staging, commit, plan mutation, external effects, installation, deployment, or production access. |
| Proposed commit | `fix(core-ingestion): keep core event projections immutable` |
| Acceptance criteria and verification | Red proves a changed choice/submission or payload can currently rewrite or abort the batch. Green proves write-once event bytes, exact duplicate idempotency despite transport cursor/source metadata, conflict settlement with bounded evidence, unchanged canonical submission binding, later-message progress, final cursor high-water, compacted-hash compatibility, and no second cursor/outbox. Run focused identity, inbox, migration and retention tests, `npm run typecheck`, `npm run build`, and `git diff --check`. |
| Verification commands | `npx vitest run tests/core-event-identity.test.ts tests/core-event-inbox-store.test.ts tests/sqlite-migrations.test.ts tests/retention-compaction-store.test.ts tests/external-turn-observer.test.ts`; `npm run typecheck`; `npm run build`; `npm test`; `git diff --check` |
| Verification results | Main observed 5 focused files and 236 tests pass with zero owned skips; full suite passed 313 files and 5,171 tests; typecheck, build, artifact checker, and diff check exited 0. Deployment repair then observed the prior-epoch startup test fail on marker drift before implementation and pass after the epoch route; the complete migration suite passed 88/88, typecheck and build exited 0, and the fresh full suite passed 313 files and 5,177 tests. Two independent repair reviewers found no confirmed Standards or Spec defect. |
| Commits | `a4f012f968f5caa32e2c216df425abcf0fbbec5b`, `149ab9ba67c7406fc81ff43bbbe8f3cd45b954b6` |

## Wave W6: `T6`

### - [x] T6: Isolate projection failures and recover through the existing outbox

| Field | Content |
| --- | --- |
| What to build | Wrap each event's reducer/outbox work in an event-scoped SQLite savepoint inside the outer ingest transaction. A projector failure rolls back only that event's partial projection and outbox writes, retains its immutable inbox payload and pending lane item, lets later independent events project, and permits the outer cursor commit. Reuse bounded pending projection recovery so success atomically commits projection plus the existing `outbound_replies` intent at the original lane sequence, while exhaustion quarantines without cursor rewind. |
| Spec references | SCN-4, SCN-5, SCN-6, SCN-7, SCN-8, INV-3, INV-5, INV-6, INV-7, INV-8, INV-9, ARCH-3, ARCH-4, ARCH-5, ARCH-6 |
| Dependencies | T5 |
| Blocked by | T5 |
| Delegation eligibility | Failure injection at the SQLite/projector seam plus existing pending-recovery and delivery fakes provides a bounded, reversible, credential-free Red-Green seam. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | The SQLite context/store transaction seam owns event savepoints; `SqliteCoreEventInboxStore` owns pending payload and original lane order; the lane-scoped `CanonicalEventProjector` and capability graph restore their existing in-memory snapshot when the corresponding durable projection rolls back; existing reducers own atomic `outbound_replies` reservation; existing recovery/quarantine and prepared-delivery policies remain the only retry mechanisms. |
| Mutation ownership | src/store/sqlite/context.ts, src/store/sqlite/core-event-inbox-store.ts, src/runtime/herdr-events-reader.ts, src/store/sqlite/capability-graph.ts, tests/core-event-inbox-store.test.ts, tests/core-session-event-multiplex.integration.test.ts, tests/prepared-delivery-store.test.ts, tests/conversation-segment-store.test.ts, tests/session-activity-store.test.ts |
| Exclusions | New event or delivery outboxes, Core replay calls, cursor rewind, duplicate TraeX prompt submission, altered three-attempt Feishu policy, live Feishu E2E, installation and deployment. |
| Isolation | Serial direct worker after main accepts and commits T5; W6 base is that exact accepted Swarm head recorded in the worker brief. |
| Concurrency conflicts | T5 |
| Verification seam | Inject a projector failure between two valid events and inspect inbox/lane/projection/outbox/cursor state before and after pending recovery; revise the two legacy first-card/render failure fixtures to assert retained pending evidence plus cursor progress with no partial projection or outbox effects; preserve ring-v2/v3 single-cursor and prepared-delivery three-attempt tests. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; worker cannot delegate, stage, commit, update the plan, publish, install, restart, deploy, or access production state. |
| Proposed commit | `fix(core-ingestion): isolate projection failures per event` |
| Acceptance criteria and verification | Red proves one projector exception currently rolls back the full batch/cursor. Green proves prior and later valid events settle, the poison item remains pending with original payload/sequence, the single Core cursor reaches batch high-water, retry success creates projection plus one `outbound_replies` intent atomically, retry exhaustion quarantines without blocking, and prepared delivery still dead-letters after the third failed attempt. Run focused inbox, multiplex, projection, outbox and prepared-delivery tests, then fresh `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check`. |
| Verification commands | Focused rollback-boundary Vitest cases; `npx vitest run tests/core-event-inbox-store.test.ts tests/core-session-event-multiplex.integration.test.ts tests/prepared-delivery-store.test.ts tests/conversation-segment-store.test.ts tests/session-activity-store.test.ts`; `npm run typecheck`; `npm run build`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed all 3 rollback-boundary Green cases pass. After delivery repair, the two explicit immutable-choice/outbox atomicity cases passed, both reopened legacy event-isolation fixtures passed, and the fresh 5-file affected suite passed 325 tests. Fresh typecheck, build, plan artifact checker, and diff check exited 0. The controlled-concurrency full suite passed 313 files and 5,176 tests. Savepoint-management failures propagate, projected traces are emitted only after durable success, stateful projector snapshots restore after both savepoint and outer-commit rollback, and pending recovery preserves the original lane sequence while reserving exactly one additional `outbound_replies` intent. |
| Commits | `7740e3f839a4bb0042aa8bf138e15f0ec2648e26`, `9434226dc7a5e1934b66bb44f74aff19d620a5fc` |

## Final delivery checks

Main completed two independent findings-first review axes over Core `8494f2f1..38388ebd` and Swarm `c057118c..9434226d`; neither Standards nor Spec review found a confirmed defect. The review verified that no event outbox, second cursor, canonical mirror, replay sidecar, or mutable late-enrichment path was introduced. Fresh Core `just ci` passed 4,133 nextest cases plus maintenance, UI architecture, and integration-asset suites after removing the Host-injected `HERDR_AGENT` marker from the test environment. Fresh Swarm `npm run typecheck`, `npm run build`, the 5-file/325-test affected suite, and `npm test -- --reporter=dot --maxWorkers=4` with 313 files and 5,176 tests all passed. `git diff --check` and the spec-coder delivery artifact check exited 0. Installation, restart, deployment, push, pull request and production mutation remain separately unauthorized.

After deployment authorization, the migration-140 startup repair received a separate Red-Green cycle and two independent findings-first review axes. The complete 88-test migration file, typecheck, build, and fresh 313-file/5,177-test suite passed. The repair commit has no injected co-author trailer. Deployment remains separately authorized by the user's current main-branch install request; push and pull request remain unauthorized.
