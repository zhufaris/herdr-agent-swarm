# Core Ingestion Latency and Completion Elegance Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-14-core-ingestion-latency-elegance.md`.
The original approach A and Gate 1 were approved interactively. The first T1
public-seam Red unexpectedly passed, proving the proposed global priority
scheduler was unnecessary. Gate 1 was reopened and the revised design was
approved interactively on 2026-10-14. The prior Gate 2 and Gate 3 approvals no
longer authorized implementation; the revised Gate 2 and Gate 3 were then
approved interactively before execution.

The native implement-spec executor will run every approved ticket. The
authoritative workspace is the existing clean isolated linked worktree at
`<repo-root>/.trae/worktrees/fix/stop-active-turn-deploy`,
detached at recorded wave base
`5402da9a49f15159acb2f434e23cd41e10125e5c`. The original `main` checkout and
its user-owned staged/untracked files remain excluded. Initial task-owned
changes are the revised specification and this plan only; the exploratory
passing test was fully removed.

Locked dependencies are installed. Fresh revised-planning baseline record
`3e4049fff4d94ed9bd9c71501e88acc8` is retained in the specification and
covers four files and 117 passing tests. The capture explicitly excludes the
active specification and this generated plan from the workspace fingerprint.

All four durable waves are serial singleton waves. Safe serial execution reuses
the authoritative workspace; no integration worktree or parallel worker
isolation is required. Main integrates one result, runs fresh verification,
creates one path-scoped atomic Conventional Commit and updates its checkbox
before recomputing the next frontier. A direct implementer may be used by
default when live capacity permits, but receives `delegation_allowed = false`
and may not stage, commit, update this plan, access production state, install,
deploy, restart, push or create a pull request.

The durable order is W1 `T1`, W2 `T2`, W3 `T3`, W4 `T4`. There are no
functional blocking edges; later singleton waves are an approved safe serial
integration order, not invented dependencies.

## Wave W1: `T1`

### - [x] T1: Adapt healthy polling and isolate reprojection from notification tails

| Field | Content |
| --- | --- |
| What to build | Preserve the existing proven next-permit notification behavior and global concurrency four. Replace fixed overlapping polling with a self-scheduling fallback: healthy caught-up owners scan every 30 seconds, while awaiting, lagging, retrying or required-failure state scans every two seconds and unknown-source/manual wakes reconcile immediately. Split pending reprojection into a bounded maintenance phase so a newer exact notification runs before reprojection that has not started, without cancelling active work or violating same-owner serialization and eventual convergence. Add bounded cadence/phase diagnostics. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-12, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-11, ARCH-1, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | Production evidence and public Supervisor seams are grounded; fake timers, blocked on-ingested/reprojection phases and temporary owner state make the bounded reversible change independently inspectable without credentials or external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Core Ingestion Supervisor remains the only lifecycle/timer owner. Keep its existing outer mapper and four-owner permit pool unchanged. Exact sources, durable cursors and existing retry classifications remain authoritative. Separate only adaptive scheduling and pending reprojection phase ownership behind the existing Supervisor interface. Composition supplies the existing degraded cadence; healthy 30 seconds is an internal injectable default. |
| Mutation ownership | src/coordinator/core-session-ingestion-supervisor.ts, src/composition/create-primary-runtime.ts, src/domain/types.ts, tests/core-session-ingestion.test.ts, tests/managed-bridge-runtime.test.ts, tests/health-server.test.ts |
| Exclusions | New priority/fairness queue, reserved permit, promotion scheduler, new environment/config variables, durable queue, Conversation Segment behavior, Completion Review, Delivery Trace semantics, Core/TraeX scheduling, production state and deployment. |
| Isolation | Serial mutation in the authoritative worktree at wave base `5402da9a49f15159acb2f434e23cd41e10125e5c`; no concurrent mutating ticket. |
| Concurrency conflicts | None |
| Verification seam | A preservation test proves the current next-permit notification order. Fake scheduling callbacks/clocks observe healthy/degraded cadence, coalesced immediate wake, no overlapping scan and stop cleanup. A blocked `onIngested` seam queues a newer notification before reprojection, proving notification runs first after the active phase while same-owner work remains serial and reprojection later converges. |
| Host capacity | One direct-child slot; recheck before dispatch and execute main-local only if default delegation is unavailable. |
| Direct-child boundary | `delegation_allowed = false`; main supplies the complete common brief and implementation role with no indirect delegation, staging, commit, production access or plan mutation. |
| Acceptance criteria and verification | The existing notification-next-permit test passes before and after without product changes for priority; healthy state schedules 30 seconds; any degraded owner schedules two seconds; unknown/manual wake is immediate and single-flight; notification completion does not await unstarted reprojection; active reprojection is not cancelled; same-owner phases never overlap; later maintenance runs once; stop cancels timer and starts no successor; diagnostics remain bounded and payload-free. Run Supervisor/runtime/health tests, typecheck, build, architecture check and diff check. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/core-session-ingestion.test.ts -t "preserves exact notification\|runs a newer exact notification\|uses a thirty-second fallback"`; `npx vitest run tests/core-session-ingestion.test.ts tests/managed-bridge-runtime.test.ts tests/health-server.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed preservation Green plus two intended Reds before implementation. Integrated Green passed 141/141 affected tests; typecheck passed; build passed with identity `sha256:47ec45129e424ff5c9811185d26ad3fb4935e063dfbd3e2deeeede13f055c26c`; architecture check validated 544 source files; diff check passed. Main review rejected unsafe derived `finally` promises, lost nondefault cadence and missing diagnostics; the accepted revision added safe success/failure scheduling, retained start cadence, fallback/maintenance diagnostics and focused rejection/cadence tests. Delivery review then exposed transient-session serialization and an unbounded route-unavailable path. Main observed the repair Red and accepted owner-key serialization plus the shared four-permit maintenance path; the repaired Supervisor/runtime/health set passed 144/144 with typecheck, build and architecture checks. |
| Commits | `435da6114ad099605c7c8134f3f4f76bfc750e05`, `da807f84aaecca0c42d24bcd86a9e660899953cb` |

## Wave W2: `T2`

### - [x] T2: Measure first-visible latency once and keep updates path-local

| Field | Content |
| --- | --- |
| What to build | Change `DeliveryLatencyTrace` so one root emits explicit `input_to_first_visible_ack` and `core_to_first_visible_ack` only for its first successfully acknowledged path. Later paths emit only Outbox-to-Ring, Ring-to-Gateway and Gateway-to-settlement latency. Keep old root-relative names as one-shot deprecated aliases for one compatibility window and expose explicit first-visible counters/duration in status. |
| Spec references | SCN-6, INV-10, INV-11, ARCH-4, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | Pure monotonic-clock/correlation fakes provide a fast deterministic seam; scope is bounded to trace/log/status contracts and requires no external system. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Delivery Observability owns root/path lifecycle and metric emission. Callers keep marking existing stages and never classify first-visible work. Service logging and health/status consume bounded DTOs; UUIDs remain correlation fields rather than labels. |
| Mutation ownership | src/domain/delivery-trace.ts, src/domain/delivery-engine.ts, src/runtime/service-logger.ts, src/events/ring-delivery-engine.ts, tests/delivery-latency-trace.test.ts, tests/ring-delivery-hot-path.test.ts, tests/service-logger.test.ts, tests/health-server.test.ts |
| Exclusions | Ingestion scheduling, Segment state, Completion Review, tracing vendors, persistent trace ledger, payload logging, SLO enforcement, Lark network optimization and production dashboards. |
| Isolation | Serial mutation in the authoritative worktree after accepted T1; scheduling order only and no functional dependency on T1. |
| Concurrency conflicts | None |
| Verification seam | Monotonic trace tests create multiple reply/attempt paths, failure, retry, stale, root merge and eviction; logger/status captures prove exact counts, compatibility aliases, bounded cardinality and privacy canaries. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child cannot delegate, stage, commit, mutate plan, access production or perform external effects. |
| Acceptance criteria and verification | One root emits one new first-visible pair and at most one legacy alias pair at its first valid Gateway ACK; subsequent updates emit no root-relative metric; every path retains local delivery metrics; paths that fail or go stale before Gateway ACK do not consume first-visible identity, while a valid ACK remains first-visible even if later settlement fails, retries or yields; snapshot naming/counts are explicit; eviction preserves bounded ownership and a late correlation cannot merge two roots after both have emitted immutable metrics; canary message/answer/card/credential data remains absent. Run trace, Ring, logger and health suites, typecheck, build, architecture check and diff check. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/delivery-latency-trace.test.ts -t "emits first-visible latency once"`; `npx vitest run tests/delivery-latency-trace.test.ts tests/ring-delivery-hot-path.test.ts tests/service-logger.test.ts tests/health-server.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the intended Red: new first-visible stages were absent and both delivery paths repeated root-relative metrics. Integrated Green passed 4 files and 117 tests; typecheck passed; build passed with identity `sha256:c666f2877c9954e9df6dfc1b24d1354cb07f5b8fb0bf2291955297bd31e05e88`; architecture check validated 544 source files; diff check passed. Delivery review then proved that settlement-owned visibility lost valid ACKs and that eviction/late merge could duplicate counters. Main observed five focused repair Reds. The accepted repair records first-visible at Gateway ACK, keeps settlement path-local and retains bounded payload-free root tombstones. A second review showed that retroactive late-merge counter repair could not retract subscriber metrics; Main observed a focused Red and froze two already-visible root identities, refusing their late merge so logs, counters and last duration remain consistent. Main reran trace/Ring/logger/health with 122/122 passing; typecheck passed; build produced `sha256:d80ed10e5ee2d6707e2f2da84566652bc492e50523f69e3510bcad9a8985da97`; architecture validated 544 files; diff check passed. |
| Commits | `9215e1e7f826e796ea57954745eb8b23acf12b73`, `2234abd6355477879d1b4a492db3f77be957d60e`, `93934e475a0cc1a62c2810acfeb02220cc8a005f` |

## Wave W3: `T3`

### - [x] T3: Resolve shared-turn Segment terminal ownership atomically

| Field | Content |
| --- | --- |
| What to build | Resolve every exact producer/session/turn Segment cohort by canonical start position inside one projection transaction. Close earlier working Segments at the next Segment start boundary, let only the canonical latest eligible Segment own terminal deltas, final answer, immutable completion choice and completion obligation, and fail closed when that latest owner is stale. Preserve abort, replay, reopen and owner/session fencing without creating duplicate Action Sets or effects. |
| Spec references | SCN-7, SCN-8, INV-7, INV-8, INV-11, ARCH-2, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | The exact production two-Human/same-turn failure is captured and temporary SQLite/canonical event seams exercise the complete atomic transition without credentials or external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Conversation Projection owns canonical cohort selection, non-overlapping boundaries and terminal mutation. SQLite applies all closures/latest transition/choice/obligation changes atomically behind `projectCanonicalEvent`; cards and Delivery remain consumers of durable state. |
| Mutation ownership | src/store/sqlite/conversation-segment-store.ts, tests/conversation-segment-store.test.ts, tests/human-turn-card.integration.test.ts, tests/turn-card-workflow.test.ts |
| Exclusions | Completion Review visual content, `finalContext` interface, standalone mention policy, schema migration, Core/TraeX ordering, historical repair, inferred choice parsing, production state and deployment. |
| Isolation | Serial mutation in the authoritative worktree after accepted T2; scheduling order only and no functional dependency on T2. |
| Concurrency conflicts | None |
| Verification seam | Canonical projection integration drives two/three Human Messages in one turn through final/terminal evidence and inspects boundaries, state, timeline ownership, choice/action/obligation counts, duplicate replay, close/reopen, abort and stale latest owner. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child cannot delegate, stage, commit, update plan, access production or perform external effects. |
| Acceptance criteria and verification | Latest eligible same-turn Segment alone completes and owns one final/review; earlier working Segments close at next-start boundaries; closed latest never falls back; replay/reopen creates no duplicate state/effect; abort creates no review; different-turn terminal behavior and existing independent admission remain green. Run Segment/Human Turn/Turn workflow tests, typecheck, build, architecture check and diff check. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts -t "completes the latest Segment and closes earlier inputs"`; `npx vitest run tests/conversation-segment-store.test.ts tests/human-turn-card.integration.test.ts tests/turn-card-workflow.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed Red: both same-turn Segments remained working and no canonical boundary, completion choice or obligation was established. Integrated Green passed 3 files and 148 tests; typecheck passed; build passed with identity `sha256:0ac43c216ebec8da2b37a9070f6d6c3dfb68ed0b800ed3aabad823f98ddc84ec`; architecture check validated 544 files; diff check passed. Main review repaired two findings before acceptance: latest-state validation now precedes earlier closure, and each earlier closure atomically increments view version then receives an immediate post-commit projection notification. Delivery review requested exact closed-owner evidence; the focused parameterized test now proves both failed and closed canonical latest owners fail closed without earlier mutation, review state or notification (2/2 passed). Tests cover two/three-member cohorts, replay stability, incompatible/closed latest fail-closed and shared-turn abort without review state. |
| Commits | `7133eb41293ba6f1b6a194b0f0ffb831d642f5d8`, `daf1e90a31d5a6b66866d9b5eb9fc92316de868f` |

## Wave W4: `T4`

### - [x] T4: Render one compact mention-and-button card without repeating the final answer

| Field | Content |
| --- | --- |
| What to build | For Human Review, keep the final Answer/Turn Card as the sole complete answer with no requester mention or review controls. Remove `finalContext` from the shared fresh Completion Review presentation input across Primary Segment, Primary Prompt and Worker Turn. Render one separate compact Review Card whose initial payload contains one native mention, question, business buttons, Ignore and a short reference to the answer above. For `intent:none` final-request compatibility, derive the trusted mention from the exact current Submission actor without requiring visible raw-final control text, keep that sole mention in the final card and atomically suppress the obligation at presentation reservation time before any standalone reminder or prerequisite exists. Retain exact-ACK cleanup only for never-attempted, effect-free historical rows. Preserve deterministic Action Set/outbox identity, ACK activation, callback fences, supersession and uncertain-effect no-replacement recovery. |
| Spec references | SCN-9, SCN-10, SCN-11, INV-9, INV-11, ARCH-3, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | Shared semantic/materialized presentation tests and temporary store/fake Gateway seams cover the full user-visible behavior without live Feishu or credentials; the internal interface cutover is bounded and reversible. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Completion Interaction owns deterministic Action Set lifecycle and the sole fresh review surface. Shared presentation ports accept action identity, trusted mention target, optional subject label and immutable choice specification only. Feishu materializes mention/buttons; Delivery retains effect/ACK authority. All three owner paths cut over together so the interface has one meaning. |
| Mutation ownership | src/domain/completion-action-set.ts, src/domain/ports/presentation.ts, src/cards/completion-actions.ts, src/coordinator/turn-card-workflow.ts, src/coordinator/answer-page-workflow.ts, src/coordinator/worker-turn-card-workflow.ts, src/store/sqlite/conversation-segment-store.ts, tests/conversation-segment-store.test.ts, tests/turn-card-workflow.test.ts, tests/answer-page-workflow.test.ts, tests/worker-turn-card-workflow.test.ts, tests/gateway-view.test.ts, tests/sqlite-store.test.ts |
| Exclusions | Terminal cohort ownership, schema migration, historical card rewriting, inferred choices, inline buttons, reservation of any new standalone mention surface or second mention-bearing projection, destructive suppression of possible-effect rows, Lark urgent effects/network optimization, production state and deployment. |
| Isolation | Serial mutation in the authoritative worktree after accepted T3; scheduling order only and no functional dependency on T3. |
| Concurrency conflicts | None |
| Verification seam | Shared renderer tests inspect provider-neutral and Feishu materialized cards. Owner-store/workflow tests inspect final/review outbox identities, mention/button placement, absence of final context/text reminder, ACK activation, duplicate reopen/retry, uncertain no-replacement, supersession and callback authorization. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; child cannot delegate, stage, commit, update plan, access production or perform external effects. |
| Acceptance criteria and verification | For Human Review, the final card contains the only full answer and no mention/buttons; exactly one fresh review row contains one mention, question/buttons/Ignore, short reference and no final context. For `intent:none` final-request compatibility, a marker-free canonical final derives the sole trusted mention only from an exact current human Feishu Submission actor whose owner, generation and ingress match the Segment. The exact reserved final presentation may contain that mention; legacy payload or immutable semantic snapshot evidence must prove its exact actor/root/projection/page identity. Before ACK or Ring eligibility there is no standalone text row or prerequisite and the obligation is suppressed. Invalid actor or missing/mismatched presentation evidence fails closed and preserves the appropriate fallback. Historical possible-effect rows fail closed; retry/restart creates no replacement; callbacks remain actor/message/generation fenced and exactly once; Primary Segment/Prompt and Worker paths share the same compact contract. Run all listed Review/Gateway/owner suites, typecheck, build, architecture check, docs audit and diff check. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/turn-card.test.ts -t "renders a sanitized fresh Completion Review card"`; `npx vitest run tests/conversation-segment-store.test.ts -t "derives the trusted requester mention|fails closed for a|routes a native mention request"`; `npx vitest run tests/turn-card.test.ts tests/conversation-segment-store.test.ts tests/turn-card-workflow.test.ts tests/answer-page-workflow.test.ts tests/worker-turn-card-workflow.test.ts tests/gateway-view.test.ts tests/sqlite-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm run docs:audit`; `git diff --check`; `rg -n "finalContext" src` |
| Verification results | Main observed Red: the fresh Review Card contained `DUPLICATE_FINAL_CONTEXT_CANARY` and omitted the compact reference. Integrated Green passed 7 suites and 735 tests; typecheck passed; build passed with identity `sha256:3d24db632ed5b91d68115d0f8d3d9f739682df577d4d26ea4cfdedec30329471`; architecture check validated 544 files; docs audit and diff check passed; no production source contract or call-site `finalContext` usage remains. Main restored one intentional test-only runtime extra-field canary after delegated verification had made the assertion vacuous and confirmed exactly one mention, question, all options, Ignore, compact reference, minimal callbacks and no copied answer. A live `intent:none` test exposed one card mention plus an ACK-released standalone text; the first repair suppressed only a never-attempted row after ACK and passed 642/642 affected tests. Production then proved a Ring race with distinct delivered orders `408810` card and `408811` text: the next claim could win before suppression. Main observed the stronger reservation-time Red, verified the exact legacy reserved presentation/root/projection/native mention, and suppressed before reserving any text/prerequisite. Focused Green passed 1/1 and affected suites 629/629. Standards review then found semantic rows persist payload `{}`; Main added semantic/fallback tests, observed legacy and fallback Green with semantic Red, and extended proof to exact immutable snapshot `options.completionNotice`. Final targeted Green passed 3/3; affected suites passed 631/631; typecheck, build `sha256:22c9fdf60459479116fe0563e2ee81e9c7bd9d17db5b9c0950e33f784a5d75d2`, architecture and diff checks passed. Missing/mismatched mention evidence retains fallback and historical possible-effect rows remain untouched. R7 then removed the visible raw-final marker requirement and derived authorization from the exact current human Feishu Submission actor with owner, generation and ingress fences. Main observed the marker-free legacy/semantic Red (2 failures); focused Green passed 2/2, actor fail-closed plus compatibility coverage passed 6/6, the full conversation-segment store passed 91/91, Turn Card workflow passed 16/16, SQLite store completed successfully, and typecheck, build, architecture and diff checks passed. Standards re-review found that the shared token validator admitted Lark's missing-sender sentinel `unknown`; the final repair limits strict `ou_...` validation to the new marker-free Primary authorization path, adds canonical-final coverage for `unknown`, non-`ou_`, non-string and malformed IDs, preserves existing Worker Human Review behavior, and passes the full conversation-segment store 94/94. |
| Commits | `b2253e6cb0c1f921cd76d865bc0cf9bd4cd0f279`, `6b1c7740aabb7ab036a3f93c089ad52a134054dd`, `1800880666c2c665aca05562ff5405fb775e126d`, `5153f02703040a6f73e15f3ddeeb7d3b41981a52`, `2db2536fbe12c7828d6bbad035c82b52f78c1390` |

## Final delivery checks

- Every approved SCN, INV and ARCH decision maps to at least one ticket and
  executable seam. SCN-1/SCN-2 and INV-2/INV-3 explicitly preserve existing
  next-permit behavior and prohibit a second scheduler rather than requesting
  product implementation.
- Main observes ticket Red before implementation except for the approved
  preservation check, which must stay green; then accepts only attributable
  ticket-owned changes, freshly verifies and creates one path-scoped atomic
  Conventional Commit before checking the ticket.
- T1 proves adaptive cadence, reprojection isolation, existing next-permit
  preservation, same-source order and monotonic shutdown.
- T2 proves one first-visible lifecycle and payload-free path-local updates.
- T3 proves atomic latest-owner terminal cohort semantics and no duplicate
  review state.
- T4 proves one complete final answer, exactly one compact mention/button card,
  no standalone reminder and restart/callback safety.
- After T4, run cumulative focused suites, `npm test`, `npm run typecheck`,
  `npm run build`, `npm run architecture:check`, `npm run docs:audit`,
  `git diff --check`, and the delivery artifact checker.
- Review cumulative code for timer leaks, same-owner overlap, transaction
  atomicity, idempotency, provider-effect certainty, metric cardinality,
  dependency direction and payload/secret exposure.
- Inspect ticket commits and final status; preserve the original main checkout
  and every user-owned file.
- No install, restart, deployment, production database mutation, live Feishu
  smoke, push, pull request, external issue or worktree deletion occurs without
  separate explicit authorization.
