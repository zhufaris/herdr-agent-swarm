# Feishu Stream Recovery Watchdog Implementation Plan

Specification: [Feishu Stream Recovery Watchdog](../specs/2026-10-02-feishu-stream-recovery-watchdog.md)

Workspace: in place at `/workspace/herdr-agent-swarm` on `main`.

Starting revision: `49c7f224e1b287ffa56f3b963d491cff39f1a3ec`.

Baseline: `npm test` passed 235 files and 3304 tests; `npm run typecheck` passed; `npm run build` passed on 2026-10-02.

Protected initial untracked content: `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`.

Approval status: Gate 1 design, Gate 2 specification, and Gate 3 implementation authorization approved.

Implementation note: the repository already uses `delivery_recoveries` to audit one failed outbox reply and `answer_recovery_links`/`answer_recovery_candidates` to converge multiple failed effects through one successor. Together these existing durable records implement the approved projection-scoped `ProjectionRecoveryGeneration`; no duplicate table is required. `DeliveryRecoveryWorkflow` remains the operator-card workflow, while the new coordinator is named `ProjectionDeliveryRecoveryWatchdog` to keep the responsibilities distinct.

## Tickets

### - [x] T1: Recover a defunct Primary Answer into one in-thread successor

| Field | Content |
| --- | --- |
| What to build | Deliver the first complete watchdog path for S1: persist one projection-scoped recovery generation for a Primary Answer whose target is explicitly defunct or closed, freeze the old Answer target, reserve one in-thread successor using existing Gateway intents, activate it only after creation ACK, and publish the durable final snapshot or exact covered suffix without submitting a Prompt. Wire the watchdog through the existing periodic-runner and outbound wake patterns so explicit evidence triggers a low-latency scan and a lost hint is recovered periodically. |
| Spec references | S1, S5, S8; Domain Model invariants 1-7; Claim-and-freeze and Activate-successor transaction boundaries; Architecture ports and dependency direction; exact-cursor and final-snapshot outcomes. |
| Ownership and implementation path | Use the existing `delivery_recoveries`, `answer_recovery_links`, and stable Answer successor idempotency as the durable `ProjectionRecoveryGeneration`; expose a narrow watchdog store query under the Answer projection port; extend outbox recovery transitions so scoped defunct Answer failures remain recoverable instead of `dismiss_defunct_target`; add `ProjectionDeliveryRecoveryWatchdog` under `src/coordinator/`; use existing Answer page/timeline reducers and Gateway `stream.create/append/finish`; assemble scheduling and wake dependencies through composition/main rather than importing adapters. The store owns atomic freeze/link and ACK activation. |
| Acceptance criteria and verification | A failing regression first proves current `230011` Answer content can disappear. After implementation, an explicitly defunct/closed Primary Answer produces exactly one claimed recovery generation and in-thread successor; old pending effects stop scheduling but remain auditable; successor is not active before ACK; ACK activation and catch-up reservation are atomic; competing scans create one local successor; restart round-trip preserves state; prompt-submission fake records zero calls. Run focused `sqlite-store`, Feishu error, Answer workflow, outbox dispatcher, watchdog, architecture-boundary tests, then typecheck and build. |
| Blocked by | None. |

Suggested atomic commit: `fix(delivery): recover defunct primary answer streams`

### - [x] T2: Converge uncertain Primary Answer failures from durable cursors

| Field | Content |
| --- | --- |
| What to build | Extend the Primary Answer watchdog path for S2, S3, and live recovery: keep the original target for the first four uncertain failures, make it eligible after the fifth, validate checkpoint coverage, and select exact suffix, latest durable timeline/event rendering, or final snapshot in that order. Include Answer content appended while successor creation is awaiting ACK. |
| Spec references | S2, S3, S5, S8; uncertain failure eligibility; deterministic resume selection; ambiguous acknowledgement and bounded-duplicate guarantees. |
| Ownership and implementation path | Extend normalized Feishu/outbox failure evidence without treating ambiguous transport outcomes as proven rejection; let existing delivery attempt state remain authoritative for the five-attempt threshold; add cursor/fallback selection to the projection recovery policy; reuse Answer delivery coverage, recovery links, timeline pages, and existing renderers. The watchdog coordinates selection, while SQLite validates same-projection coverage and atomically materializes catch-up work after ACK. |
| Acceptance criteria and verification | Attempts 1-4 retry only the old target; attempt 5 yields one recovery candidate. A valid checkpoint resumes strictly after acknowledged coverage. Missing, pruned, mismatched, or stale coverage chooses latest durable timeline/event; a completed projection with no viable incremental source publishes a final snapshot. Content persisted during `awaiting_ack` appears on the successor. Ambiguous successor ACK reuses the same recovery/idempotency identity and never produces two active local targets. Prompt submission remains zero. Run focused recovery policy, SQLite, Answer page/timeline, dispatcher, watchdog integration tests, typecheck, and build. |
| Blocked by | T1. |

Suggested atomic commit: `fix(delivery): resume primary answers from durable cursors`

### - [x] T3: Recover Worker Task streams without losing terminal output

| Field | Content |
| --- | --- |
| What to build | Apply the same projection recovery lifecycle to Worker Task pages, including observed `300307` stream-finalization failures, content failures, final snapshots, concurrent scans, and late old-target receipts. Preserve current Worker session/thread ownership fencing and current authoritative Worker card rendering. |
| Spec references | S2, S3, S5, S6, S8; projection kinds and ownership proof; one-active-target, no-Prompt-replay, and final-visibility invariants. |
| Ownership and implementation path | Extend the watchdog projection reader and policy for Worker Task identity, worker session generation, page checkpoint, and current Worker thread proof; integrate existing Worker turn card/page stores and renderer rather than creating a second content model; retain existing `300307` recovery where an authoritative replacement already exists, routing uncovered cases into the projection watchdog. SQLite enforces generation/ownership fences and activation. |
| Acceptance criteria and verification | `300307` and other uncertain Worker finalization failures retry the original target through the configured five attempts and then recover when no authoritative replacement already resolves them. Explicitly defunct Worker targets recover immediately. Final Task output is visible on one active successor; persisted page/generation ownership survives reopen; stale Worker generations and unproven rows are refused; late old-target success cannot reactivate the old target; no Primary or Worker Prompt is submitted. Run focused Worker card ownership/workflow, SQLite recovery, outbox dispatcher, watchdog integration, typecheck, and build. |
| Blocked by | T1, T2. |

Suggested atomic commit: `fix(delivery): recover interrupted worker task streams`

### - [x] T4: Fall back to a top-level recovery conversation for dead roots

| Field | Content |
| --- | --- |
| What to build | Complete S4 for both projection kinds: when durable evidence proves the original reply root or thread is defunct, create a top-level recovery conversation in the configured Feishu group, then create/continue the recovered Answer or Task there. Make the acknowledged conversation/surface the only future target. |
| Spec references | S4, S5, S7; deterministic target policy; successor ACK rule; configured-chat and ownership security boundaries. |
| Ownership and implementation path | Extend the recovery intent factory to select existing `conversation.create` before stream creation when root proof requires it; persist the two-stage successor references and use one stable recovery identity across retries; resolve the configured group only through proven binding/Worker ownership. Gateway and Feishu adapter contracts remain unchanged. SQLite transactions fence old target work and install the new conversation/surface only after the corresponding ACKs. |
| Acceptance criteria and verification | A usable original thread stays in-thread. A proven dead root creates one top-level recovery conversation and then one active stream/snapshot target. An unproven owner or destination creates nothing and moves to an auditable exhausted/refused outcome. Retries reuse stable identities; ambiguous ACK can cause a rare external duplicate but still converges to one active local successor. Configured-chat allowlisting is unchanged. Run Gateway intent/plugin, SQLite, watchdog integration, security/routing, typecheck, and build checks. |
| Blocked by | T2, T3. |

Suggested atomic commit: `fix(delivery): fall back to recovery conversations`

### - [x] T5: Backfill historical stream gaps and expose recovery health

| Field | Content |
| --- | --- |
| What to build | Use the same watchdog selector at startup to recover historical Primary Answer and Worker Task gaps whose ownership and durable content are provable. Resume nonterminal recovery generations after reopen. Add bounded operational summary/log fields for backlog count, oldest eligible age, state counts, and exhausted count without making backlog alone fail readiness. |
| Spec references | S6, S7, S8; Compatibility & Migration; startup convergence; refusal and exhausted behavior; operational visibility requirements. |
| Ownership and implementation path | Integrate watchdog scanning into existing startup recovery/view convergence after migrations and before normal drain ordering where required; select candidates from existing per-reply `delivery_recoveries`, quarantines, Answer coverage/recovery links, Worker page state, and projection gaps without rewriting source projections; extend operations store/domain status types and health/status rendering with bounded aggregates; emit structured recovery logs correlated by projection and recovery IDs. |
| Acceptance criteria and verification | Reopen continues `eligible`, `rebuilding`, and `awaiting_ack` generations idempotently. Proven historical gaps reserve recovery once; unproven gaps remain unchanged or exhausted with reason. Fully delivered history is not replayed. Recovery backlog is visible in `/status` and logs but does not independently fail `/ready`. Startup ordering does not drain a frozen old lane before recovery reconciliation. Full migration/reopen, startup converger, status/health, service lifecycle, architecture-boundary, typecheck, build, and full `npm test` pass. |
| Blocked by | T1, T2, T3, T4. |

Suggested atomic commit: `fix(delivery): backfill and report stream recoveries`

## Coverage and Dependency Review

- S1 is owned by T1.
- S2 is owned by T2 for Primary Answer and T3 for Worker Task.
- S3 is owned by T2 and T3.
- S4 is owned by T4.
- S5 is established by T1 and extended across both projections by T2-T4.
- S6 is covered by per-ticket reopen tests and completed operationally by T5.
- S7 is enforced in T3/T4 and included in historical selection by T5.
- S8 is established for Primary Answer by T1/T2 and Worker Task by T3, with historical convergence in T5.
- The no-Prompt-replay invariant is asserted in T1-T3 and startup recovery in T5.
- Exact cursor, latest durable event/timeline, and final snapshot fallback are implemented in T2 and reused by T3/T4/T5.
- Dependency graph is acyclic: `T1 -> T2 -> T3 -> T4 -> T5`, with T4 requiring both projection implementations and T5 requiring every live recovery target path.

## Final Delivery Checks

- Review every ticket diff against the approved specification and repository architecture.
- Confirm one Conventional Commit per completed ticket and inspect each complete staged diff before committing.
- Confirm no commit contains `Trae CLI co-author attribution`.
- Run all affected focused tests, `npm run typecheck`, `npm run build`, and fresh full `npm test`.
- Run `npm run public:audit` only before any separately authorized push; no push or PR is authorized by this plan.
- After implementation verification, run `./install.sh`, then inspect restart safety and use the supported forced restart path only under the user's existing deployment authorization; verify build identity, readiness, recovery status, and targeted service logs.
