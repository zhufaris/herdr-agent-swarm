# Feishu Human Message Session Ingestion — Implementation Plan

## Planning authority

- Approved specification: [`../specs/2026-10-04-feishu-human-message-session-ingestion.md`](../specs/2026-10-04-feishu-human-message-session-ingestion.md)
- Gate 1: dedicated session-ingestion design approved on 2026-10-04.
- Gate 2: written specification approved on 2026-10-04.
- Workspace: in-place `/workspace/herdr-agent-swarm`.
- Branch: `main`.
- Starting revision: `c01bb492ff93e209a87cec99f7843fa5e7f99fcd`.
- Baseline: `npm test` passed 263 files and 3,764 tests; `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Ownership: existing user changes in `TODO.md`, `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md` remain excluded from every ticket.
- Existing hotfix evidence: `e14a374c`, `2181cc67`, and `c01bb492` remain committed history and are reviewed by this plan rather than amended.
- Gate 3: approved by the user; implementation authorized without deployment,
  force-restart, push, PR, or external publication authority.

## Tickets

- [x] **T1: Continuously ingest Primary Core session events outside Turn ownership**

  **What to build:** Add the `CoreSessionIngestionSupervisor` deep module and wire active Primary sessions through it. A Primary Binding with an exact v2 session continuously ingests bounded Core batches into the durable inbox whether the Agent is idle, working, blocked, detached, or has no active Prompt. Preserve the deployed active-lane digest/checkpoint so existing event debt is neither skipped nor restarted from the beginning.

  **Spec references:** SCN-1, SCN-3, SCN-4, SCN-6; INV-1 through INV-6; Architecture / `CoreSessionIngestionSupervisor`; Compatibility & Migration.

  **Ownership and implementation path:** Conversation Projection owns the durable session lane and checkpoint. The new supervisor owns process-local producer/tail/backoff state and consumes a route-query port plus normalized Core stream and inbox ports. `ExternalTurnObserver` retains Turn adoption and projection but stops owning v2 current-session Core reads. Composition assembles the concrete adapters and connects periodic scans and Pane hints. The compatibility helper must produce the exact existing lane ID for the same Binding generation/session/stream tuple.

  **Acceptance criteria and verification:** Red-Green integration tests prove an idle Primary session ingests a new `human_message`, resumes an existing deployed cursor after reopen, preserves Core array order, coalesces concurrent hints into one producer, rejects a changed exact session fence, and performs zero Agent Input submissions. A frozen lane-identity test protects the existing digest. Focused supervisor/reader/inbox/observer tests, architecture checks, typecheck, and build pass.

  **Blocked by:** None.

  **Completed:** Added a Primary-scoped `CoreSessionIngestionSupervisor` that
  coalesces exact-session producers, resolves the current Pane/terminal/session
  route, and ingests up to the existing 512-event budget from the durable Core
  cursor independently of Turn ownership. The v2 Turn observer now consumes
  the same durable session lane without a competing remote read. The deployed
  active-lane digest is frozen for compatibility. Idle Human Message,
  multi-page resume, exact terminal rejection, concurrent scan, lifecycle and
  architecture coverage passed (6 files, 197 tests), together with typecheck,
  architecture check and build identity
  `sha256:75c98041ee1df7734f259165ea650d52ffc7a04ab293805b23544766c1ea99eb`.

- [x] **T2: Apply the same continuous ingestion contract to Worker sessions**

  **What to build:** Extend the supervisor's route set to exact active Worker sessions. Worker ingestion remains independent of Primary Turn activity and retains Worker generation, Worker-session generation, parent Binding generation and parent Pane fences. Worker Task projection consumes the same durable event-lane contract without introducing a second Core reader for the epoch.

  **Spec references:** SCN-2, SCN-3; INV-1 through INV-3 and INV-8; Architecture / durable inbox projection.

  **Ownership and implementation path:** Worker Runtime supplies immutable route facts through a consumer-shaped query capability. The supervisor translates them into the same session-ingestion identity used for Primary without importing Worker coordinators into the runtime module. `WorkerTurnObserver` keeps task ownership/projection decisions and consumes durable events only. Stale Worker or parent generations remove the local ingestion lease before another read.

  **Acceptance criteria and verification:** Red-Green Worker integration tests prove idle and active Worker Human Messages ingest, exact generation/parent fences reject stale routes, simultaneous Primary/Worker sessions do not share cursors or block each other, restart is idempotent, and no duplicate Worker Task/Agent Input is created. Focused Worker runtime/observer/supervisor tests, architecture checks, typecheck, and build pass.

  **Blocked by:** T1.

  **Completed:** The shared supervisor now discovers active Worker sessions,
  serializes producers with Worker generation, Worker-session generation and
  parent Binding/Pane fences, resolves the current Herdr terminal/session
  before reading, and wakes only the matching Worker observer after durable
  ingest. Stale parent generation fails before Core access. Worker routing,
  observer, session-thread, instance integration and architecture coverage
  passed (5 files, 166 tests), together with typecheck, architecture check and
  build identity
  `sha256:efcdd5e3ad3d6e7f93df1ab25bd0f5afd223a6cea7829f2e822a67ef1c3339a6`.

- [x] **T3: Reconcile historical pending Input Cards from canonical evidence**

  **What to build:** Add bounded canonical-evidence reconciliation for pending Input Cards. On startup and periodically, matching `human_message.submission_id` already stored in `core_event_inbox` invokes the existing atomic pending-to-working transition. Current-session catch-up supplies later evidence; typed cursor expiry uses receipt-proven exact-turn recovery. Missing or ambiguous canonical evidence leaves the card pending and exposes a bounded needs-human diagnostic without replay.

  **Spec references:** SCN-4 through SCN-7; INV-2, INV-4 through INV-7; Architecture / canonical Input Card reconciliation; Behavior & Failure Modes.

  **Ownership and implementation path:** Agent Input owns the state transition; the SQLite adapter owns a bounded indexed selection and reuses `observeCanonicalHumanMessage` rather than directly updating state. Conversation Projection supplies canonical inbox evidence. Recovery coordinates typed cursor gaps using existing exact-turn facilities and receipt identities, never Feishu or receipt order. No migration rewrites Input Card state.

  **Acceptance criteria and verification:** Red-Green store/integration tests cover crash after inbox commit, crash before card create checkpoint, duplicate reconciliation, terminal receipt plus matching Human Message, missing/ambiguous evidence, cursor-expired exact recovery, process reopen, and zero resubmission. Query-plan evidence shows indexed bounded selection. Focused Agent Input/inbox/recovery/outbox tests, typecheck, and build pass.

  **Blocked by:** T1.

  **Completed:** Added migration 92 and an indexed canonical Human
  Message/submission ledger populated atomically by live ingestion and
  backfilled from existing durable inbox evidence. Bounded reconciliation
  reuses the single pending-to-working transition and an indexed query plan.
  Pending cards with receipt-proven exact Turn identity can stage a complete
  authoritative snapshot and import only its canonical Human Message evidence;
  incomplete, missing or ambiguous recovery cannot change card state and never
  resubmits input. SQLite reopen/migration verification passed (504 tests), and
  focused inbox, snapshot, Agent Input and recovery checks passed (5 files, 44
  tests), together with typecheck, architecture check and build identity
  `sha256:6e65a101fa5dc295c4b1307700ff2e9a0d9858feb2634edfd45b230e4cbe2418`.

- [x] **T4: Converge Input Card delivery and report ingestion health truthfully**

  **What to build:** Ensure Input Card create/update projection lanes converge independently from unrelated Answer/Worker debt and expose bounded session-ingestion diagnostics/readiness. A working snapshot observed before create ACK must be delivered after create; duplicate checkpoints remain idempotent. Pending Inputs whose exact active session cannot be consumed make Agent Input readiness not ready, while unrelated historical projection/outbox debt remains degraded operational status.

  **Spec references:** SCN-5, SCN-8, SCN-9; INV-4, INV-7; Architecture / readiness and diagnostics; Out of Scope.

  **Ownership and implementation path:** Delivery and Operations owns projection-lane checkpointing and provider failure state. The health collector consumes a bounded supervisor snapshot; it does not scan full event/outbox history. Existing `input-card:<submissionId>` lane identity remains unchanged. No code in this ticket alters Core order, submission eligibility, or unrelated dead letters.

  **Acceptance criteria and verification:** Red-Green delivery tests prove working-before-create ACK, delivered create followed by one update, duplicate provider checkpoint, isolated provider failure, and independence from a blocked unrelated lane. Health tests prove loop/lag/failure summaries and pending-session readiness behavior. Status query-plan/budget checks, focused outbox/health tests, typecheck, build, and docs audit pass apart from explicitly preserved unrelated user-document warnings.

  **Blocked by:** T1, T3.

  **Completed:** Input Card create and update projections retain one dedicated
  `input-card:<submissionId>` lane, so unrelated Answer/Worker debt cannot
  reorder the pending-to-working transition. The session-ingestion supervisor
  now exposes bounded active, lagging and required-failure diagnostics; only a
  failed or unavailable exact session route with a pending Input Card makes
  Agent Input readiness not ready. Migration 93 records the indexed owner
  lookup used by this bounded readiness check. Delivery, health, ingestion,
  migration and architecture coverage passed (7 files, 221 tests), together
  with typecheck, architecture check and build identity
  `sha256:a727e1aec4b18123167b639f4070b2dd808c39c3aa966e0eb7dd9d190c8ba649`.
  Documentation audit reports only the two preserved stale line-anchor links
  in the unrelated user-owned
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`.

- [ ] **T5: Verify the complete Feishu Human Message path and deploy safely**

  **What to build:** Update current architecture/operator documentation, run findings-first review of all hotfix and ticket diffs, repair any blocking findings through TDD, and verify the complete Primary/Worker path. After explicit deployment authority, install and restart the candidate, then submit one real Feishu input and prove the same Input Card changes pending -> working from the matching canonical Core event without replay.

  **Spec references:** All scenarios and invariants; Testing Decisions; Out of Scope.

  **Ownership and implementation path:** Documentation records the same Agent Input, Conversation Projection and Delivery ownership as the implementation. Delivery review checks context boundaries, one-producer semantics, durable cursor atomicity, no-replay, exact generation fences and bounded diagnostics. Deployment uses the supported `./install.sh` and `npm run swarm:restart`; force remains a separate explicit runtime authorization if the normal gate blocks.

  **Acceptance criteria and verification:** All focused tests, architecture checks, `npm run typecheck`, `npm run build`, `npm run docs:audit`, and full `npm test` pass with fresh evidence. Production verification records expected/observed build, readiness, session cursor advancement, matching inbox Human Message, Input Card revision/state, outbox delivery checkpoint and absence of a second Core submission. Unrelated historical dead letters remain untouched and reported separately.

  **Blocked by:** T2, T3, T4.

  **Progress:** Findings-first review repaired four blocking gaps: required
  readiness appearing during backoff, missing PI Worker ingestion, asynchronous
  Primary/Worker generation races, and discarded exact-recovery outcomes. It
  also added durable migration-94 recovery state so sixteen terminal
  `needs_human` rows cannot starve a later independent Input, and fenced both
  new canonical tables with the instance lease. Final Standards and Spec
  reviews report no remaining blocking finding. Fresh verification passed 264
  files and 3,786 tests, typecheck, build, architecture checks, diff checks and
  the tracked-tree documentation audit. The live pre-deployment status still
  identifies installed commit `c01bb492` / build `sha256:582edba3...`, but the
  user-systemd bus is unavailable and HTTP status timed out. Installation,
  restart and real Feishu pending-to-working proof remain explicitly pending
  deployment authorization.

  Post-deployment observation found five current-session producers trapped on
  historical replay compatibility rather than new semantic conflicts. Old
  inbox JSON omitted a nullable `turnId`, while current Core emits `null`; Core
  also regenerates `record_skipped.occurredAt` on every decode. TDD coverage now
  canonicalizes only those two proven non-semantic differences while retaining
  fail-closed occurrence-time checks for business events. Fresh verification
  passes 264 files and 3,789 tests, typecheck, build and architecture checks.
  Installation, restart and production convergence proof remain pending for
  this repaired candidate.

  A second post-deployment comparison isolated the sole remaining conflict to
  one canonical `human_message`: its historical stream tag referenced no
  Submission Intent, while the current Core tag matched the exact durable,
  terminal Feishu Submission Intent. The inbox now permits only that
  evidence-backed correction, with Agent/session fences and unambiguous
  event/submission ledger bindings, and rebinds the event payload and canonical
  ledger atomically. Conflicting IDs without the same durable proof still fail
  closed.

## Dependency map

```text
T1 Primary session ingestion
 |\
 | +--> T2 Worker parity --------+
 |                               |
 +----> T3 historical recovery --+--> T5 review + deployment
 |                               |
 +----> T4 delivery + health ----+
```

T2, T3 and the T1-independent portions of T4 are conceptually separable, but
implementation remains serial in this workspace so each ticket receives an
atomic commit and fresh affected verification.

## Final delivery checks

- [x] Every SCN-1 through SCN-9 and INV-1 through INV-8 maps to a completed ticket and fresh test evidence.
- [x] One exact session epoch has one current-stream producer; Turn observers own projection only.
- [x] Core order is copied without Feishu/receipt/timestamp/ID sorting.
- [x] Historical pending -> working transitions have matching durable canonical Human Message evidence.
- [x] No accepted, terminal or uncertain submission body is replayed.
- [x] Primary and Worker generation/session/Pane fences are covered.
- [x] Input Card create-before-update and provider failure are durable and idempotent.
- [x] Readiness and status use bounded indexed diagnostics and reflect broken required ingestion.
- [x] Unrelated historical Answer/Worker outbox and dead-letter rows are unchanged.
- [x] Full tests, typecheck, build, architecture checks and applicable docs audit pass freshly.
- [x] Findings-first delivery review has no unresolved blocking issue.
- [ ] Deployment, if authorized, proves the exact running build and a real Feishu pending -> working transition.
- [x] No push, PR or external ticket publication occurs without separate authorization.
