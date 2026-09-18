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

Live diagnostics showed no queued, active, or uncertain Worker turn and no
reconciliation failure. Snapshot cache failures were bounded and the Herdr circuit
breaker was closed. No new P0/P1 issue or repeatable P2 bottleneck was established,
so this slice remains audit-only.

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

Final source verification on 2026-09-18 passed `git diff --check`, 174 Vitest
files with 2318 tests, TypeScript checking, the 320-file architecture import
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
not determine user-systemd activity. A fresh `/status` observation remained ready
and healthy but reported one running Prompt. Herdr identified it as the current
TraeX turn in pane `wN:p3S`, so forcing restart would detach this live observer and
was not authorized. The remaining acceptance step is a later normal restart after
this turn settles, followed by live identity, readiness, SQLite, workspace, Gateway,
Lark, and log verification.
