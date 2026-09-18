# Production Critical Path Optimization Audit

This audit implements the evidence gate from the production critical-path
optimization design. It records the baseline, confirmed changes, audit-only
findings, and the evidence used to avoid speculative refactoring.

## Baseline

| Item | Evidence | Result |
| --- | --- | --- |
| Source revision | `git rev-parse HEAD` before implementation | `d1e03c3fba17487605cdf61d4da446bc69e6dcc1` |
| Runtime | `node --version`; `npm --version` | Node `v24.14.1`; npm `11.11.0` |
| Architecture | `npm run architecture:check` | 320 source files valid |
| Type safety | `npm run typecheck` | passed |
| Test suite | `npm test` | 174 files, 2307 tests passed |
| Build | `npm run build` | passed; baseline build `sha256:72130855cf13d79b9ccac437ebbd53de0b59b81996176e01b016b5d86a7c443d` |
| Live readiness | `npm run swarm:status` | Bridge ready; database, projects, four Herdr workspaces, Gateway, Lark, lease, and instance runtime healthy |
| SQLite integrity | `/status` snapshot | `quickCheck=ok`, no issues |
| Live data scale | read-only SQLite counts | 80,708 outbound rows, 991 inbound rows, 2,068 Prompts, 149 Worker turns |

The running service initially remained on commit `4f44826`; source-only audit and
implementation commits were not installed during intermediate slices.

## Candidate Decisions

| ID | Path | Priority | Evidence | Decision | Verification |
| --- | --- | --- | --- | --- | --- |
| O-1 | Card delivery / SQLite | P2 | The work-class lane-head query chose `outbound_replies_work_class_delivery`, scanned historical outbound rows, and built a temporary ordering B-tree. On the live read-only database, 20 empty-head queries had a median elapsed time of 1816.152 ms. | Force the query to start from the bounded `outbox_lane_heads_delivery_order` index. Keep lane, claim, due-time, and work-class predicates unchanged. | Query-plan regression; 411 focused tests; same live read-only benchmark fell to 0.038 ms median for 20 queries. |
| O-2 | Outbox recovery | Audit only | 22 pending replies were all behind two active quarantines. One lane records an uncertain prior-owner effect; the other records a delivery timeout. Both have no lane head by design. | Preserve fail-closed quarantine. Automatic release could repeat an uncertain external effect. | Read-only join of pending replies to `outbox_lane_quarantines`; SQLite integrity reports no missing-head contradiction. |
| O-3 | CardKit streaming | Audit only | Historical dead letters include Feishu `300309 streaming mode is closed`; current recovery classifies these as permanent and uses Answer rebuild/quarantine paths. | Do not retry stream content blindly and do not weaken frozen-page behavior. No causal evidence of a new defect was found. | Existing outbox dispatcher, Answer recovery, and SQLite recovery tests; live dispatcher had no ready or in-flight work. |
| O-4 | Service lifecycle status | External operational risk | `systemctl --user` returned `Failed to connect to bus: No data available` even though the HTTP Bridge was ready. The runtime directory and bus socket existed, but this shell could not query the user manager. | Keep ownership checks fail closed. HTTP identity/readiness cannot prove that the listener belongs to the canonical unit. | Existing lifecycle tests reject unavailable, foreign, and mismatched listener ownership. |
| O-5 | Large modules | P3 audit only | The largest files are migration history, transaction-owning stores, lifecycle control, and card renderers. Line count alone did not prove duplicate semantics. | Do not mechanically split them. Refactor only beside a confirmed behavior or performance change. | Architecture guide and import-boundary tests preserve the deep-module and single-context boundaries. |
| O-6 | Restart safety | P1 | Live status had 22 pending replies, all intentionally waiting behind two quarantined lanes, while lifecycle blocked on aggregate `pendingOutbox`. Those rows cannot drain automatically. | Gate restart on actionable `outboxWork` and active deliveries; permit quarantine-only history; fail closed on missing metrics. | Lifecycle regressions cover ready, in-flight, retry-wait, cooldown-wait, incomplete, and quarantine-only states. |
| O-7 | Local diagnostics | P3 | Pino already emitted structured JSON and systemd owned a private local file, but only one rotated generation and an unfilterable tail were available. `tslog` or a memory queue would duplicate ownership and add flush/loss modes. | Keep Pino and the single writer. Retain three stopped-state generations and add bounded structured `swarm:logs` filters. | Lifecycle tests cover defaults, bounds, history, malformed records, validation, link defenses, and rotation rollback. |
| O-8 | External-turn convergence | P1 | Production Prompt `791f5224-26c4-4772-8b19-baa3b5e174b8` remained `running/attached` after Pane `w5:p56` became idle. Its exact transcript contained `task_started` and `:q`, but no matching `task_complete` or `turn_aborted`; this permanently blocked the FIFO and the normal restart gate. | After two distinct post-start durable idle/done observations with no intervening exact-turn transcript activity, atomically fail the exact Prompt closed with an unknown outcome, publish `TurnFailed`, and wake the FIFO. Never infer success or replay. | Red-capable observer regression; transcript-resumption reset regression; SQLite full-fence and exactly-once regression; 293 focused tests. |
| O-9 | Immutable release retention | P1 | Installing a second candidate before a safety-gated restart changed `current` twice. Pruning retained only the candidate and previous `current`, deleted the still-running unit's older `WorkingDirectory`, and caused live SQLite integrity checks to report `uv_cwd` / `ENOENT`. | Parse the prior installed unit before replacement and retain its valid direct release `WorkingDirectory` during post-activation pruning. Ignore absent, external, symlinked, or malformed paths. | Red-capable repeated-install lifecycle regression; all 104 lifecycle tests; typecheck. |

## Startup, Recovery, and Shutdown

The audit traced `ManagedBridgeRuntime`, `RuntimeLifecycleLedger`,
`BridgeRuntimeShutdown`, reconciliation runners, external-turn observation, and
Worker dispatch shutdown. The current implementation:

- registers cleanup only after a component may have started;
- stops ingress and observers before workers, projections, and health;
- uses one shared bounded shutdown context;
- retains the write fence, lease, and database when a writer fails or remains
  unsettled; and
- detaches potentially dispatched Primary and Worker turns without replay.

Focused lifecycle tests cover component failures, timeouts, unsettled writers,
observer detachment, startup interruption, stale build rejection, listener
ownership, and readiness. No new P0 or P1 failure was reproduced. The systemd
status discrepancy is O-4, not an application fallback opportunity.

O-6 was subsequently confirmed from the live quarantine state and corrected.
The gate now distinguishes actionable delivery work from rows deliberately parked
behind a quarantined lane.

## Local Logging and Agent Diagnostics

O-7 keeps the existing low-overhead Pino hot path. No in-memory queue or second
file transport was added. The lifecycle owns a three-generation rotation chain,
and the operator command performs bounded structured filtering across that chain.
This is a maintainability and diagnosis improvement, not a throughput claim.

## Inbound Messages and Prompt FIFO

The audit traced durable inbound claiming, per-scope retry, Prompt acceptance,
priority versus ordinary FIFO, pre-dispatch runtime checks, exact transcript
ownership, steering, detached recovery, and shutdown. Existing tests demonstrate:

- failed durable acceptance is retried without a second inbound message;
- one ordinary Prompt runs per binding;
- priority control work does not reorder the ordinary FIFO;
- stale claims are requeued only when no dispatch evidence exists;
- dispatched or exact-owned work becomes detached or uncertain; and
- attached output and detached cursors retain exact transcript identity.

No new P0/P1 defect or measured P2 bottleneck was established, so this slice does
not change production code.

## Worker Scheduling and Runtime Reconciliation

The audit traced instance-key dispatch, generation claims, Agent drivers, structured
observation, Herdr hints, scoped reconciliation, snapshot caching, shutdown, and
uncertain dispatch. Existing tests cover duplicate wake-ups, serialized scoped
reconciliation, stale generations, missing or mismatched panes, interrupted
observers, and no-replay recovery.

The initial live snapshot showed no queued, active, or uncertain Worker turn and no
reconciliation failure. Snapshot cache failures were bounded and the Herdr circuit
breaker was closed. A later restart-safety inspection exposed O-8 on the Primary
external-turn observation path: the authoritative Pane was idle, while the exact
durable Prompt remained `running/attached` because TraeX had emitted no terminal
transcript record.

The regression reproduces that exact stall and is red-capable: increasing the idle
confirmation threshold kept the Prompt running. The correction accepts only two
strictly increasing durable `lastObservedAt` values after the exact turn start and
no intervening transcript observation. Transcript activity, non-idle runtime,
missing durable ownership, or changed observer identity resets confirmation. The
transaction rejects stale generation, Pane, Agent session, observation timestamp,
turn identity/start, attachment, runtime, or Run Card generation and succeeds only
once. Its visible outcome is failure with unknown execution result, never a
fabricated success or a replay.

## SQLite Transactions, Queries, and Migrations

The store continues to use one primary `SqliteContext`; tests inject transaction
failures and verify rollback across workflow state, projections, and outbox intent.
Migration tests cover empty databases, legacy schemas, optional-column ordering,
repeat opens, and foreign-key integrity. No schema change was required.

O-1 was the sole measured query defect. Its query-plan regression binds the actual
SQL generator used by `listOutboundLaneHeads`, so the test verifies the production
query rather than a copied example. The helper also removes dynamic SQL assembly
from the Store method while keeping a single named responsibility.

## Card Delivery and Recovery

The audit traced projection reservation, lane heads, prepared Gateway plans, claims,
delivery checkpoints, retry scheduling, quarantine, dead-letter recovery, and card
convergence. Existing tests cover ordered lanes, concurrency limits, cooldowns,
stale acknowledgements, uncertain effects, immutable claims, frozen Answer pages,
and replacement evidence.

O-1 affects every dispatcher scan that asks for live or history work. O-2 and O-3
are intentionally retained safety states. Live diagnostics at baseline showed the
dispatcher idle, no active deliveries, no ready lane heads, and card convergence at
zero pending work.

## Performance Evidence

The benchmark used the same live database in read-only mode, the same Node runtime,
the same predicates, 20 executions per sample, and multiple samples. The live state
had 80,708 historical `outbound_replies` and zero `outbox_lane_heads`, which
represents the common idle scan case.

| Query | Plan driver | Median for 20 executions |
| --- | --- | ---: |
| Before | `outbound_replies_work_class_delivery` plus temporary sort | 1816.152 ms |
| After | `outbox_lane_heads_delivery_order`, then primary-key lookup | 0.038 ms |

The result is not used to claim a universal throughput percentage. It proves that
idle work-class scans are bounded by the lane-head table instead of retained outbox
history. Semantics remain covered by the existing lane ordering, backoff, work-class,
claim, quarantine, and dispatcher tests.

## Simplification Result

The accepted cleanup is deliberately narrow: lane-head SQL construction is now a
named pure function shared by production execution and query-plan verification. It
removes duplicated test SQL and makes the planner invariant directly testable. No
generic utility module, transaction split, or reliability-loop unification was
introduced.

No other large-file or interface cleanup met the evidence gate. Those candidates
remain unchanged rather than increasing regression risk for a cosmetic line-count
goal.

## Implementation and Verification

| Change | Commit | Direct evidence |
| --- | --- | --- |
| Approved optimization design and phased plan | `7d0e6e4`, `d1e03c3` | Design and plan documents define the five production paths, risk gates, invariants, and release procedure. |
| Pino local logging design amendment | `c80446b` | Defines the single-writer model, bounded diagnostics, private rotation, and explicit rejection of `tslog` and an in-memory queue. |
| Restart safety O-6 | `59a4077` | Actionable outbox categories block restart; quarantine-only backlog is permitted; missing categories fail closed. |
| Lane-head scan O-1 | `c7a71ef` | Production SQL uses the lane-head delivery index; query-plan test rejects a temporary order B-tree; live median improved from 1816.152 ms to 0.038 ms per 20-query sample. |
| Local diagnostics O-7 | `b82496d` | Pino/systemd remains the single writer; three generations, bounded filtering, JSONL output, malformed-line handling, and rollback are covered by lifecycle tests. |
| External-turn convergence O-8 | `5a17aba` | Two independent durable idle/done observations plus an empty exact-turn delta trigger a full-fence, exactly-once fail-closed transition and FIFO wake without replay. |
| Release retention O-9 | `71040b2` | Repeated candidate installation preserves the release referenced by the prior unit while pruning unrelated inactive releases. |

Source verification before the O-8 release on 2026-09-18 passed `git diff --check`,
174 Vitest files with 2321 tests, TypeScript checking, the 320-file architecture import
check, the Superpowers documentation audit, and the production build. The final
build identity before installation was
`sha256:b2834601b90744448c3f453c931b1f49062f39d12d20d54a79448bbcd7e86db6`.

`./install.sh` staged and activated immutable release
`b2834601b90744448c3f453c931b1f49062f39d12d20d54a79448bbcd7e86db6-b3074402268e`
without starting it. The installed CLI successfully returned headerless JSONL via
`npm run swarm:logs -- --lines 5 --json`; the log directory and current log
remained `0700` and `0600`. Production dependency audit reports two moderate
findings in `qs` through `@larksuiteoapi/node-sdk`, with no available npm fix; no
dependency changed in this program.

The first normal restart attempt failed closed before stop because this shell could
not determine user-systemd activity. Later inspection distinguished the current
TraeX turn in Pane `wN:p3S` from O-8's stale exact external turn in Pane `w5:p56`.
## Final Production Convergence

The final source verification on 2026-09-18 passed `git diff --check`, 174
Vitest files with 2322 tests, TypeScript checking, the 320-file architecture
import check, the Superpowers documentation audit, and the production build.
The installed immutable release is
`9458dd675b520f92b07acf14e65feda51af3b77c1d841165765d8c4d553b5f7a-71040b2235a6`;
its generated build identity is
`sha256:9458dd675b520f92b07acf14e65feda51af3b77c1d841165765d8c4d553b5f7a`.

The ordinary restart gate remained blocked by an active Primary turn. After the
operator explicitly authorized a forced restart, the lifecycle correctly refused
to bypass a degraded SQLite health snapshot. That snapshot was not database
corruption: the old process could no longer resolve its deleted working directory
and reported `uv_cwd`. The supported `swarm:stop` followed by `swarm:start`
performed graceful detachment and started the installed release without weakening
the integrity gate.

The converged production snapshot reported:

- expected and observed build identity both `9458dd...` at commit `71040b2`;
- canonical unit ownership matched PID `2846099` and its listener;
- readiness `ready`, with database, projects, all four Herdr workspaces, Gateway,
  Lark, lease, and instance runtime healthy;
- startup recovery completed and SQLite `quickCheck=ok` with no issues;
- actionable outbox work and card convergence both drained to zero; and
- the two potentially dispatched Prompts remained `running/detached`, with zero
  newly discovered turns and durable error text stating that the existing TraeX
  turn is observed without replay.

The bounded local log command confirmed the new PID emitted `bridge-started`,
`herdr-socket-connected`, and `lark-websocket-ready`. Historical closed CardKit
streams were rejected and routed through the existing permanent recovery path;
they did not leave actionable delivery work. The overall `/status` remains
`degraded` only because retained historical dead letters and an existing
archived/attached Pane reconciliation warning remain visible. Readiness and all
acceptance-critical live components are healthy.

## Prompt-to-Artifact Completion Checklist

| Requirement | Design / implementation | Test or runtime evidence | Result |
| --- | --- | --- | --- |
| Worker progress is distinct from tool activity | Worker Main design; `src/cards/worker-main-card.ts`; `37446e2` | `worker-main-card.test.ts` covers plan progress, tool-only activity, and legacy activity | Complete |
| Human review is visible in Feishu using the Primary-style hierarchy | Worker Main review-notice design; canonical durable Worker Main update; `f5b2db7`, `af7f3b4`, `21b354e` | Blocked card tests cover orange actionable notice and `等待用户处理`; no remote high-risk approval was added | Complete |
| Stability and global critical paths were audited | This audit plus design and phased plan; O-1 through O-9 | Startup, shutdown, reconciliation, queue, outbox, transaction, and CardKit suites | Complete |
| Local Pino diagnostics and rotation are bounded | `b82496d`; systemd remains the sole file writer | Lifecycle tests cover three generations, bounds, filters, JSON output, permissions, and rollback; installed command returned structured records | Complete |
| SQLite remains the only durable queue | Architecture durable-before-wake contract; no application message queue | Wake-ups carry no payload or acknowledgement state; startup and periodic SQLite scans provide convergence | Complete |
| Restart safety is preserved | `59a4077`, `71040b2`; fail-closed identity, ownership, recovery, and integrity gates | Quarantine-only backlog no longer blocks; actionable work does; live integrity degradation was not bypassed | Complete |
| Lane-head scans are bounded | `c7a71ef` | Live median for 20 queries improved from 1816.152 ms to 0.038 ms with query-plan regression coverage | Complete |
| Missing terminal events converge without replay | `5a17aba` | Observer and full-fence SQLite regressions; production Prompt `791f...` recovered as detached and was not redispatched | Complete |
| Running immutable releases survive repeated installation | `71040b2` | Repeated-install regression; 104 lifecycle tests; final release installed and started | Complete |
| Repository gates pass | Source HEAD `71040b2` | 2322 tests, typecheck, architecture check, docs audit, build, and diff check passed | Complete |
| Production runtime matches the installed artifact | Immutable release and generated build info | Expected/observed identity match; PID ownership, readiness, lease, SQLite, workspaces, Gateway, Lark, recovery, outbox, and card convergence verified | Complete |
| Remote publication remains controlled | No push was performed | Branch remains ahead of `origin/main`; outgoing commit trailers and `public:audit` remain mandatory pre-push gates | Complete |
