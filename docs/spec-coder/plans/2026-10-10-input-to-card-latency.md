# Input-to-Card Latency and Stable Subagent Identity Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-10-input-to-card-latency.md`

Status: Gate 1 design, Gate 2 specification, and Gate 3 ticket set and
implementation authorization approved by the user on 2026-10-10. All tickets
and the delivery repair are committed; final delivery verification passed.

Workspace:
`<workspace>`

Branch and base: `worktree-unified-delivery-ingress` at
`8fa321c5162207cdb3673ce8a6c744fda5ab78e6`.

Workspace policy: reuse the current clean isolated worktree. Preserve the
original checkout and all unrelated user work. Stage only ticket-owned paths.
Do not push, install, restart, deploy, run live Feishu mutations, or alter the
production SQLite database without separate authorization.

Baseline: Node `v24.14.1`, npm `11.11.0`, installed locked dependencies;
`npm run typecheck` passed; `npm run build` passed with build identity
`sha256:33e42362d19788659cfa18e52fc4abf34d721c34cde218175044334d6534b2d2`.
`npm test` emitted no failed test before it stopped producing output, but did
not terminate and was interrupted with exit 130. This non-green baseline must
be rechecked during final delivery and must not be reported as a pass.

The user requested sequential optimization. All four tickets therefore run as
serialized waves even where file ownership could permit parallel mutation.
Read-only review may run in parallel; mutating workers may not.

## Dependency map

```text
T1 Stable Subagent identity projection
             |
             v
T2 Narrow read-only discovery + batch hydration
             |
             v
T3 Fenced CAS + interactive maintenance yielding
             |
             v
T4 Payload-free end-to-end latency trace
```

## Wave W1: `T1`

### - [x] T1: Preserve Subagent name and model independently of visible-item pruning

| Field | Content |
| --- | --- |
| What to build | Add a binding/session-fenced durable Subagent identity projection keyed by producer and `agent_id`; merge nickname/model from spawn or explicit agent activity monotonically; make sparse wait/close lifecycle events rebuild pruned visible items from that identity; use the same reducer for live projection and retained recovery; delete identity facts with their owning Session Activity projection. |
| Spec references | SCN-8, SCN-9, SCN-10, SCN-11, INV-6, INV-7, INV-8 |
| Dependencies | None |
| Delegation eligibility | Eligible: exact production evidence, expected identity, schema boundary, and deterministic SQLite reopen seam are known. No credentials or production mutation are required. |
| Delegation mode | delegate |
| Ownership and implementation path | Multi-agent protocol translation remains in the runtime adapter. SQLite Session Activity owns identity persistence, fences, monotonic merge, item reconstruction, pruning separation, and retained convergence. Card renderers continue to consume `SessionActivityView` only. Prefer an additive companion table with an owning-snapshot foreign key over duplicating identity into transient visible rows. |
| Mutation ownership | src/runtime/multi-agent-tool-lifecycle.ts, src/domain/session-activity.ts, src/domain/ports/session-activity.ts, src/store/sqlite/session-activity-store.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema-manifest.ts, tests/session-activity-store.test.ts, tests/sqlite-migrations.test.ts, tests/instance-lease.test.ts, tests/architecture-boundaries.test.ts |
| Exclusions | Delivery discovery/refill; Ring behavior; card layout or limits; child transcript-file lookup; Core/TraeX/Herdr changes; production data repair. |
| Isolation | Serialized first wave in the selected isolated worktree. Worker must not share a mutating checkout with any other ticket. |
| Concurrency conflicts | None |
| Verification seam | Red first with the captured 15-spawn sequence: Boyle is initially pruned, a sparse terminal close follows, and current behavior produces the UUID. Green requires `Boyle · GPT-5.6-Luna` live and after close/reopen retained recovery. Include independent name-only/model-only enrichment in both orders, explicit rename with model preservation, retained page boundaries, Primary/Worker agent-ID isolation, malformed/truncated and compacted evidence, unknown fallback, stale owner/session fence, binding replacement, Worker termination and snapshot deletion cascades, idempotent recovery, bounded missing-identity diagnostics, and terminal monotonicity. |
| Host capacity | One direct-child slot. Recheck before dispatch; wait on temporary capacity exhaustion. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn, stage, commit, push, deploy, restart, or access production state. |
| Acceptance criteria and verification | Visible-list pruning never erases known identity; sparse events preserve known nickname/model; unknown agents may still show UUID; old-session evidence cannot enrich the new session; live and retained paths converge to identical items; repeated recovery adds no duplicate item/revision/outbox work; additive migration is idempotent. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/session-activity-store.test.ts tests/sqlite-migrations.test.ts tests/instance-lease.test.ts tests/architecture-boundaries.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 4 files and 201 tests pass; focused Boyle pruning, legacy pre-identity, Worker retained-recovery, and bounded missing-identity diagnostic tests pass; typecheck exit 0; build exit 0 with identity `sha256:a3d96862f19f559611c3f2211f8cf56295d109a12c919c5a7bc4b2f7ccb1f8b0`; independent scoped re-review passed Spec and Code Quality with no findings. |
| Commits | `733f1faf410034aa556141384633629c81723d35` |

Suggested atomic commit:
`fix(session-activity): retain subagent identity across pruning`.

## Wave W2: `T2`

### - [x] T2: Split scope-head discovery from bounded batch hydration

| Field | Content |
| --- | --- |
| What to build | Refactor ordinary Prepared Delivery refill and quarantine/recovery discovery so read-only bounded queries discover authoritative candidates using only IDs and scheduling metadata, then bounded batch hydration reconstructs complete Ring or recovery work. Remove `head.*` selection and per-candidate `hydratePreparedDelivery` loops from both ordinary scope pages and quarantine recovery. Preserve exact current eligibility classifications and page/cursor behavior, and do not rerun expired-claim recovery once per discovery page. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-5, INV-1, INV-2, INV-4, INV-5 |
| Dependencies | T1 |
| Delegation eligibility | Eligible: read/query boundary is bounded, existing 64-scope and skewed-backlog tests provide deterministic seams, and no live Gateway is needed. |
| Delegation mode | delegate |
| Ownership and implementation path | Prepared Delivery SQLite store owns narrow candidate selection and batch mapping. The Prepared Delivery port returns complete domain work, not rows. Ring engine behavior and durable authority remain unchanged. Use indexed keyset pagination and a bounded `IN`/temporary value strategy supported by the current SQLite adapter; do not issue one statement per candidate. |
| Mutation ownership | src/domain/ports/prepared-delivery.ts, src/store/sqlite/prepared-delivery-store.ts, tests/prepared-delivery-store.test.ts, tests/ring-delivery-recovery.test.ts, tests/t8-global-cutover.test.ts |
| Exclusions | Claim/CAS predicate redesign; checkpoint mutation; maintenance priority; latency metrics; rendering/pagination; schema materialization of a permanent scope-head table. |
| Isolation | Serialized after accepted T1 commit. No concurrent Prepared Delivery mutation. |
| Concurrency conflicts | None |
| Verification seam | Instrument statement count and transaction mode for ordinary and quarantine paths. Red proves current refill performs per-head hydration and/or discovery inside a write path; Green proves a 64-scope page and multi-page quarantine backlog use bounded statements independent of head count. Between discovery and hydration inject a missing row, malformed plan/hash, changed scope/order, and newly unprepared row; require exact candidate/result cardinality and typed stale/invalid or recovery-blocked outcomes without exposing later work. Production-shaped skew, conflict isolation, prerequisites, Global scope, retry wake, missing checkpoint, concurrent interactive write, and restart fixtures remain equivalent. |
| Host capacity | One direct-child slot. Recheck at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn, stage, commit, push, deploy, restart, or access production state. |
| Acceptance criteria and verification | Ordinary and quarantine discovery perform no mutation and select no provider/card payload; query count has a constant upper bound per page; each returned item is fully hydrated once; corrupt, reordered, missing, or no-longer-prepared work fails closed without skipping a blocking head; expired-claim recovery is not repeated per page; scope ordering and all existing eligibility classifications are unchanged. |
| Blocked by | T1 |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-recovery.test.ts tests/t8-global-cutover.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 8 focused batch/fail-closed tests and 3 affected files / 92 tests pass; ready 1/8/64-scope pages use two statements; quarantine heads use one batch hydration; typecheck exit 0; build exit 0 with identity `sha256:92cc5975c497cbd513abfb41e13fc89c76757a13c1442724841954bdf7b0ff90`; independent scoped review passed Spec and Code Quality with no T2 findings. Writer-boundary and two-handle stale-race evidence remain assigned to T3. |
| Commits | `5e3ca4ff` |

Suggested atomic commit:
`perf(delivery): batch scope-head discovery hydration`.

## Wave W3: `T3`

### - [x] T3: Validate discovered heads with a short fenced CAS and yield maintenance to interactive work

| Field | Content |
| --- | --- |
| What to build | Make discovery advisory and authorize every claim/checkpoint/recovery mutation through a short transaction that revalidates row identity, state/order, due time, owner fence, prerequisite, replacement/quarantine, active claim, and effect certainty. Return typed stale outcomes and reread instead of weakening invariants. Bound recovery/refill pages and reschedule background work when interactive ingress/projection/Ring activity is pending. |
| Spec references | SCN-4, SCN-5, SCN-6, INV-2, INV-3, INV-5 |
| Dependencies | T2 |
| Delegation eligibility | Eligible after T2: concurrency outcomes and fake-clock/interleaving seams are explicit, but the ticket is high risk and requires main review of every state transition. |
| Delegation mode | delegate |
| Ownership and implementation path | Prepared Delivery persistence owns the fenced compare-and-swap and checkpoint correctness. Delivery scheduling owns bounded page continuation and interactive-yield policy. Active-work signals remain process-local hints; periodic reconciliation remains the convergence path. No Ring state becomes durable authority. |
| Mutation ownership | src/store/sqlite/prepared-delivery-store.ts, src/domain/ports/prepared-delivery.ts, src/events/ring-delivery-engine.ts, src/runtime/active-work-tracker.ts, src/runtime/periodic-workflow-runner.ts, tests/prepared-delivery-store.test.ts, tests/ring-delivery-hot-path.test.ts, tests/ring-delivery-recovery.test.ts, tests/periodic-workflow-runner.test.ts |
| Exclusions | Provider execution semantics; uncertain-effect replay; ingress global parallelism; Core event batching; latency trace propagation; debounce/render optimization. |
| Isolation | Serialized after T2. No concurrent delivery persistence or Ring scheduler mutation. |
| Concurrency conflicts | None |
| Verification seam | Two SQLite handles drive deterministic interleavings across Global, generic Primary, Worker, and Primary Turn Card claim paths. Race discovery against active claim, ACK settlement, safe supersession, conflict predecessor, prerequisite target state, replacement/recovery linkage, quarantine phase, app cooldown, due-time changes in both directions, effect certainty, target/thread/page projection revision, owner/session fence, and forward/backward checkpoint changes. Every loser returns a typed stale outcome, performs zero mutation/Gateway work, and rereads. Fake interactive work arriving after page one prevents immediate page two, does not falsely complete mandatory startup recovery or a safety scan, preserves exact-scope responsiveness, and later converges through bounded rescheduling. Measure writer transaction inputs and statement count rather than flaky CI wall time. |
| Host capacity | One direct-child slot. Recheck at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn, stage, commit, push, deploy, restart, or access production state. |
| Acceptance criteria and verification | Exactly one valid competing mutation wins in every claim cohort; stale discovery never calls the Gateway or overwrites a newer forward/backward checkpoint; a due-time change prevents or enables only a fresh reread; possible remote effects remain uncertain and non-replayable; checkpoints never skip unresolved/reopened work and may rebase; unrelated scopes progress; maintenance cannot hold the writer across discovery/hydration or multiple pages; partial/yielded mandatory recovery is not reported complete; missed wakes still converge. |
| Blocked by | T2 |
| Verification commands | `npx vitest run tests/prepared-delivery-store.test.ts tests/ring-delivery-hot-path.test.ts tests/ring-delivery-recovery.test.ts tests/periodic-workflow-runner.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed checkpoint/writer/backoff focused tests and 4 affected files / 129 tests pass; discovery and hydration are writer-free, checkpoint CAS is narrow and stale exhaustion blocks delivery, expired-claim recovery runs once per pass, persistent interactive work backs off, startup/safety remain incomplete while yielded, and ACK/retry share the global single-flight; typecheck exit 0; build exit 0 with identity `sha256:3b7d3988b951027fcad4fd6ae07431aaffb6e473a08c9e070cf02a2c0f824e95`; independent concurrency re-review passed Spec and Code Quality with no blocking findings. |
| Commits | `baeae7e0`, `88c7ebfc` |

Suggested atomic commit:
`perf(delivery): fence refill claims outside discovery`.

## Wave W4: `T4`

### - [x] T4: Add payload-free input-to-card latency attribution

| Field | Content |
| --- | --- |
| What to build | Propagate a bounded Delivery Trace correlation chain `Lark event/message -> Submission Intent -> canonical Core event/Segment -> Outbox reply -> claim attempt/provider receipt` through durable inbound acceptance, canonical projection, Outbox reservation/preparation, Ring grant, Gateway acknowledgement, and local settlement. Emit monotonic stage durations, outcomes, stale-CAS and maintenance-yield diagnostics using bounded metric dimensions and safe correlation fields. Expose enough status/log evidence to evaluate the approved stage budgets. |
| Spec references | SCN-7, INV-1, INV-5 |
| Dependencies | T3 |
| Delegation eligibility | Eligible: payload exclusions and required stages are explicit; logger/clock fakes make it deterministic. Cross-cutting ownership makes serialized execution preferable. |
| Delegation mode | delegate |
| Ownership and implementation path | A small provider-neutral trace value carries timestamps and correlation identities. Each owning boundary records only its stage. Structured logs use UUIDs as fields, never metric labels. Existing health/status diagnostics aggregate bounded counters/histograms; no new durable ledger or payload-bearing event stream is added. |
| Mutation ownership | src/domain/delivery-trace.ts, src/coordinator/durable-inbound-pipeline.ts, src/store/sqlite/core-event-inbox-store.ts, src/store/sqlite/prepared-delivery-store.ts, src/events/ring-delivery-engine.ts, src/runtime/service-logger.ts, tests/inbound-message-dispatcher.integration.test.ts, tests/core-event-inbox-store.test.ts, tests/prepared-delivery-store.test.ts, tests/ring-delivery-hot-path.test.ts, tests/health-server.test.ts, tests/service-logger.test.ts |
| Exclusions | Message/card/model payload persistence; high-cardinality metric labels; distributed tracing vendor dependency; UI dashboard; query optimization beyond T3; automatic SLO enforcement or load shedding. |
| Isolation | Serialized after T3. No concurrent ingress, projection, delivery, or diagnostics mutation. |
| Concurrency conflicts | None |
| Verification seam | A true integration test with a fake Gateway and monotonic clock drives durable ingress through canonical projection, one-or-more card updates, Gateway ACK, and SQLite settlement. Cover Primary and direct Worker input, duplicate ingress, stale attempts, retry/restart with an optional stage absent, and wall-clock rollback; assert no double-counting and no fabricated zero latency. Privacy tests use canary source text, answer text, tool result, CardKit JSON, Presentation Snapshot, credential, and token values and search captured logs/status/persisted trace state. Cardinality tests require only stage/outcome as metric labels and keep every UUID in correlation fields. |
| Host capacity | One direct-child slot. Recheck at dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child does not spawn, stage, commit, push, deploy, restart, or access production credentials/state. |
| Acceptance criteria and verification | Operators can correlate ingress to visible ACK using safe IDs; each approved stage has a duration/outcome; missing stages do not fabricate zero latency; metrics have bounded labels; no payload or secret is persisted/logged; stale CAS and maintenance yields are observable; existing status endpoints remain bounded and redacted. |
| Blocked by | T3 |
| Verification commands | focused trace/privacy/diagnostic tests selected during Red; `npx vitest run tests/inbound-message-dispatcher.integration.test.ts tests/core-event-inbox-store.test.ts tests/prepared-delivery-store.test.ts tests/ring-delivery-hot-path.test.ts tests/health-server.test.ts tests/service-logger.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Main observed 8 focused trace tests, 7 affected files / 228 tests, and 3 architecture/capability/receipt files / 99 tests pass; a production-boundary Primary chain reaches SQLite settlement without manual stage marks, Worker restart paths omit unavailable stages, duplicate/stale attempts do not double count, Outbox observation is synchronous post-commit, per-root paths/bindings/refusals are bounded, and payload/privacy/cardinality canaries remain absent; typecheck exit 0; build exit 0 with identity `sha256:467a2a3a23e95011ce9881fef7058a20040801590bbe33e01c504c701d5629e7`; independent architecture/privacy re-review passed Spec and Code Quality with no findings. |
| Commits | `436eacd9` |

Suggested atomic commit:
`feat(observability): trace input-to-card latency`.

## Execution policy

Each ticket follows one Red-Green cycle and produces one path-scoped atomic
commit after main-agent inspection and fresh affected verification. If a Red
test reveals that a ticket requires a domain/schema decision outside the
approved specification, stop and reopen the appropriate gate. A worker result
is evidence only; main must inspect the diff and rerun the accepted commands.

The checked boxes and accepted commit hashes in this file are the durable
execution state. Do not begin the next wave until the previous ticket's commit
and verification evidence are recorded.

## Final delivery checks

- [x] Every SCN and INV is covered by an accepted ticket and executable test.
- [x] The 15-spawn Boyle fixture passes live, pruning, sparse terminal, reopen,
      and repeated retained-recovery paths.
- [x] Discovery is read-only, selects narrow metadata, and has bounded query
      count independent of scope count.
- [x] Batch hydration has no per-scope query and fails closed on corrupt or
      missing blocking work.
- [x] Fenced CAS interleavings preserve ordering, prerequisites, replacements,
      checkpoints, owner fences, and uncertain-effect no-replay behavior.
- [x] Interactive work causes bounded maintenance yield without preventing
      eventual reconciliation.
- [x] Latency diagnostics cover every approved stage with bounded cardinality
      and no payload/secret exposure.
- [x] Each ticket's focused tests, `npm run typecheck`, and `npm run build`
      pass with fresh main-agent evidence.
- [x] `npm test` is rerun after all tickets; the pre-existing non-exit baseline
      is either resolved or reported with exact fresh evidence.
- [x] Independent standards/specification review has no unresolved blocking
      finding.
- [x] The final diff contains only approved source, test, migration, and
      spec-coder artifact changes.
- [x] No install, restart, deploy, live Feishu mutation, production SQLite
      mutation, push, or pull request occurs without separate authorization.

Fresh final delivery evidence:

- `npm test`: exit 0; 300 files and 4,576 tests passed in 104.69 seconds.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0; build identity
  `sha256:dda672133fe061d0d8515a245f7abb0d87eb63f45117f726d3e49af163e33e8a`.
- Independent Spec review: pass with SCN-1 through SCN-11 and INV-1 through
  INV-8 mapped to implementation and executable evidence.
- Independent Standards code review: pass with no unresolved code finding.
  The local task commits contained an automated co-author attribution; no push
  was authorized or performed, and that local history required sanitization
  before any future push.
- Full-suite verification initially exposed two lost-wake regressions in
  multi-page Answer recovery and Global deletion serialization. Commit
  `88c7ebfc` repaired the revisioned global-refill coordinator; both exact
  regressions, 131 Ring/store tests, and the final complete suite then passed.

Gate 3 approval authorizes T1 through T4 implementation in the listed serial
waves, ticket-level TDD, path-scoped atomic commits, plan checkbox/evidence
updates, review, and fresh verification. It does not authorize installation,
restart, deployment, production-state mutation, live Feishu smoke, push, pull
request, dependency upgrade, or Core/TraeX/Herdr changes.
