# Session Event Ring Cursor Rebase and Legacy Input Card Retirement — Implementation Plan

Approved specification:
[Session Event Ring Cursor Rebase and Legacy Input Card Retirement](../specs/2026-10-05-session-event-ring-refill.md)

## Workspace, ownership, and baseline

### Swarm

- Workspace:
  `/workspace/herdr-agent-swarm/.trae/worktrees/fix-session-ring-cursor-rebase`
- Branch / starting revision:
  `worktree-fix-session-ring-cursor-rebase` at
  `ffada1611d23fd7512c1e8647747de44c234bbe3`
- Isolated because the main checkout contains user-owned uncommitted `TODO.md`
  additions and many concurrent worktrees. The main `TODO.md` is evidence only
  and must not be edited, copied over, staged, or committed by this plan.
- Dependencies: `npm ci` completed from the lockfile.
- Fresh baseline: `npm run build` passed; focused standalone installer tests
  passed 26/26; `npm test` passed 272 files / 3,923 tests; `npm run typecheck`
  exited 0.

### Core

- Workspace:
  `/workspace/herdr-core/.trae/worktrees/fix-session-ring-resume-cursor`
- Branch / starting revision: `fix/session-ring-resume-cursor` at
  `040948b5bf9a1e01b55459e846568bf2bfb289cc`
- Isolated to preserve the clean local `master` and its nine ahead commits.
- Toolchain: official checksum-verified Zig 0.16.0 selected explicitly via
  `ZIG=/home/example/.cache/toolchains/zig-x86_64-linux-0.16.0/zig`.
- Fresh baseline: `just test-one session_ring` passed 3/3 and `just build`
  completed the locked release build.

## Approval status

- Gate 1 design approved before planning.
- Gate 2 written specification approved after cursor rebase, the `ri14` and
  accepted-native-submission TODO incidents, and legacy Input Card retirement
  were reconciled into one scope.
- Gate 3 ticket approval and implementation authorization were granted on
  2026-10-05.
- Deployment, service restart, production database migration, and live Lark
  message deletion remain separately gated and are not authorized by Gate 3.

## Prior delivered foundation

The original plan overstated completion by marking expiry recovery complete
when it only failed closed. The historical work is retained as foundation, not
represented as unfinished implementation:

- Core `d9800683`: shared bounded ring primitive.
- Core `52d937c8`: capability-gated Session Event Ring v2.
- Core `040948b5`: cold refill and handoff transfer.
- Swarm `fe63c1c2`: stable session lane consumption.
- Swarm `ffada161`: typed cursor-expiry detection and proof that expiry does not
  replay cards or Agent Input.

The tickets below begin at the missing safe resume/rebase boundary.

## Tickets

- [x] **R1: Expose a safe Core resume cursor for an expired Session Event Ring read**

  **What to build:** Extend the capability-gated Core Session Event Ring expiry
  detail with an opaque `resume_cursor` that is immediately before the first
  retained event in the same ring and epoch. Preserve exclusive `after`
  semantics and all existing successful response shapes. Carry the field
  through server, API schema, socket error details, CLI normalization, and
  compatibility fixtures. If a published codec rejects additive error detail,
  introduce and negotiate a new method/capability instead of changing that
  codec.

  **Spec references:** SCN-R1; INV-R1, INV-R2, INV-R3; Core Session Ring
  transport; Compatibility and migration; Core testing decisions.

  **Ownership and implementation path:** Core's Session Ring partition is the
  only component allowed to calculate cursor sequence/predecessor identity. It
  computes resume/earliest/latest under the same partition lock and exports
  them as structured transport evidence. Neither CLI nor Swarm parses or
  decrements the cursor. No persisted ring or refill format changes unless the
  implementation proves one necessary.

  **Acceptance criteria and verification:**

  - a 513-event ring rejects the evicted cursor with all three cursors from one
    epoch;
  - reading with `after=resume_cursor` returns the earliest retained event as
    the first item exactly once;
  - empty/start, single-event, full-window, malformed, wrong-ring, wrong-epoch,
    and future-cursor cases retain their existing outcomes;
  - schema/socket/CLI tests prove the field remains structured and existing
    published compatibility contracts remain valid;
  - run the red focused test first, then `just test-one session_ring`, relevant
    schema/CLI tests, `cargo fmt --check`, and `just build`;
  - before the atomic Core commit, run the applicable `just check` gate and use
    the pre-proposed message `fix(api): expose safe session ring resume cursors`
    only if Gate 3 approval explicitly aligns with it.

  **Blocked by:** None.

- [x] **R2: Atomically rebase an expired Swarm lane and ingest the complete retained window**

  **What to build:** Parse Core's `resume_cursor`, extend the typed expiry
  error, and add one SQLite transition that fences the exact old lane/session/
  epoch/checkpoint, records an idempotent projection gap, and replaces the
  stale read cursor atomically. Immediately reread from the durable checkpoint,
  ingest the earliest retained event, and converge to latest. Preserve stable
  event-ID deduplication, projection state, and no-card/no-input replay. A Core
  server without `resume_cursor` remains fail-closed.

  **Spec references:** SCN-R1, SCN-R2, SCN-R3; INV-R1 through INV-R7; Swarm
  Core ingestion; Failure and consistency decisions; Swarm testing decisions.

  **Ownership and implementation path:** `HerdrEventsPort` and its adapter
  normalize typed Core evidence. The Core event inbox aggregate owns checkpoint
  and projection-gap consistency behind a store result of `rebased` or
  `stale_rebase`. The reader owns bounded read continuation; the ingestion
  supervisor owns retry/lag diagnostics but cannot mutate checkpoints itself.
  Existing `ingestBatch` remains the only lane-item insertion path.

  **Acceptance criteria and verification:**

  - the first focused integration test fails because the current checkpoint is
    retried forever, then passes by ingesting the earliest retained event and
    clearing retry/lag after catch-up;
  - injected transactional failure persists neither gap nor new checkpoint;
  - competing SQLite handles produce one rebase winner and one stale result;
  - reread duplicates leave lane item, Conversation Segment/page, view
    revision, outbox, and Input Card counts unchanged;
  - missing resume cursor never uses `earliest_cursor` as `after` and submits
    zero Agent Inputs;
  - focused `herdr-session-events-v2`, Core ingestion/supervisor, inbox/store,
    event projector, conversation, and outbox tests pass with typecheck,
    architecture check, build, and `git diff --check`;
  - create the atomic Swarm commit
    `fix(events): rebase expired session ring checkpoints`.

  **Blocked by:** R1, because only Core can provide the safe opaque resume
  position.

- [x] **R3: Converge accepted native submissions and missing Assistant output without replay**

  **What to build:** Complete the owner-scoped recovery path for the two
  user-owned TODO incidents: an accepted native submission awaiting exact Core
  turn identity and a `ri14`-shaped Prompt whose Assistant final output was not
  projected. After rebase, correlate receipt and canonical Human evidence to
  the exact session/turn. When retained evidence is insufficient, invoke only
  existing submission-fenced or exact-turn recovery, ingest successful evidence
  into the stable inbox, and converge normal Prompt/Run Card/Answer projection.
  Persist indexing/retry/needs-human outcomes with actionable safe identities.

  **Spec references:** SCN-R4, SCN-R5; INV-R5 through INV-R8; Exact Submission
  Intent and turn recovery; Failure and consistency decisions; Swarm testing
  decisions.

  **Ownership and implementation path:** Agent Input remains owner of receipt
  certainty and immutable Submission Intent. Conversation Projection owns
  canonical turn and output state. Authoritative turn snapshots and canonical
  input recovery remain the only bounded historical seams. The coordinator may
  select due recovery but cannot resubmit prompt text, rewind the shared lane,
  or infer completion from the visible card.

  **Acceptance criteria and verification:**

  - an accepted receipt plus canonical Human event durably attaches one exact
    turn identity across duplicate scans and reopen;
  - a `ri14`-shaped retained Assistant/terminal sequence creates the missing
    normal Answer projection once through the standard outbox;
  - when retained events are absent, exact-turn recovery succeeds idempotently
    for the identified owner and does not reopen unrelated projected events;
  - indexing remains retryable; not-found, ambiguous, unavailable exhaustion,
    and identity conflict become durable needs-human evidence without blocking
    later inputs;
  - spies/counters prove zero Agent Input submit calls in every recovery path;
  - focused submission-intent, canonical recovery, external/detached observer,
    Core inbox, Conversation/Answer, and integration tests pass with typecheck,
    architecture check, build, and `git diff --check`;
  - create the atomic Swarm commit
    `fix(recovery): converge accepted native turns without replay`.

  **Blocked by:** R2, because the live lane must first escape the expired
  checkpoint and expose which exact evidence is still missing.

- [x] **R4: Retire ownership-proven legacy Input Cards through the durable outbox**

  **What to build:** Add an additive, idempotent retirement state for legacy
  `input_card_views`; scan a bounded set of ownership-proven terminal candidates;
  atomically reserve one `message_delete` with the retirement operation; and
  settle the exact operation only from deleted/already-absent delivery evidence.
  Pending, accepted-without-turn, uncertain, missing-target, conflicting, and
  failed candidates remain non-retired and preserve their evidence. Reuse the
  existing outbox retry/dead-letter path and keep Orchestrator-clear deletion
  settlement unchanged.

  **Spec references:** SCN-C1 through SCN-C4; INV-C1 through INV-C4; Legacy
  Input Card retirement; Failure and consistency decisions; Compatibility and
  migration; Swarm testing decisions.

  **Ownership and implementation path:** The compatibility retirement aggregate
  owns eligibility and state; Submission Intent/canonical correlation supplies
  proof but is not rewritten. SQLite owns atomic operation/outbox reservation.
  Delivery owns external delete and typed outcome normalization. Startup and
  periodic recovery only request bounded scans and cannot directly mark rows
  retired. Presentation code and visible Lark text are not consulted.

  **Acceptance criteria and verification:**

  - an ownership-proven terminal legacy view with exact message/Gateway route
    reserves one semantic delete effect, including under competing handles;
  - migration/reopen/repeated scans reuse the operation and outbox idempotency
    key rather than creating a second delete;
  - deleted and already-absent acknowledgement retire the exact view; retryable
    failures keep deleting state; permanent/uncertain/mismatched results remain
    failed or needs-human and never claim deletion;
  - pending, uncertain, accepted-without-turn, missing-message, and conflicting
    rows enqueue zero deletes; after R3 supplies exact terminal evidence the
    same candidate becomes eligible once;
  - no test deletes or mutates canonical Conversation/Answer/Turn/Main/Worker
    cards, Core checkpoints, or Prompt execution, and ordinary admission still
    creates zero Input Cards;
  - legacy deletes enter the existing history class; a full prefetched history
    ring is invalidated on a new-work wake and refilled so the next free slot
    can serve newly arrived live work without interrupting active delivery;
  - focused migration/store, submission-intent, outbox/dispatcher,
    startup-recovery, and legacy Input Card integration tests pass with
    typecheck, architecture check, build, and `git diff --check`;
  - create the atomic Swarm commit
    `fix(cards): retire legacy input cards durably`.

  **Blocked by:** R3 for the accepted/pending eligibility transition; already
  terminal candidates are characterized in the red tests before R3 but the
  ticket is completed only after the full authority path exists.

## Coverage check

| Requirement | Responsible ticket(s) |
| --- | --- |
| SCN-R1 | R1, R2 |
| SCN-R2 | R2 |
| SCN-R3 | R2 |
| SCN-R4 | R3 |
| SCN-R5 | R2, R3 |
| SCN-C1 | R4 |
| SCN-C2 | R3, R4 |
| SCN-C3 | R4 |
| SCN-C4 | R4 |
| INV-R1 | R1, R2 |
| INV-R2 | R1, R2 |
| INV-R3 | R1, R2 |
| INV-R4 | R2 |
| INV-R5 | R2, R3 |
| INV-R6 | R2, R3 |
| INV-R7 | R2, R3 |
| INV-R8 | R3 |
| INV-C1 | R4 |
| INV-C2 | R4 |
| INV-C3 | R4 |
| INV-C4 | R4 |

Dependency order:

```text
R1 Core safe resume cursor
  -> R2 Swarm atomic checkpoint rebase
       -> R3 accepted submission and Assistant recovery
            -> R4 durable legacy Input Card retirement
```

There are no missing or cyclic dependencies. Each ticket produces an
observable green capability and an atomic repository-local commit. R1 is the
only Core ticket; R2-R4 are Swarm tickets.

- [x] **R5 — Isolate malformed canonical recovery candidates during production startup**

  Preserve the per-Submission no-replay boundary when historical canonical
  snapshot projection fails. Record the exact candidate as unavailable for
  human review, continue the bounded batch, and ensure supervisor promise
  cleanup cannot create an unhandled rejection. Verify with focused recovery
  and ingestion-supervisor tests. Normalize Feishu's delete-specific expired
  message response (`230009`) as already absent so the exact retirement can
  settle truthfully, then run the full Swarm delivery checks.

- [x] **R6 — Reconcile pre-upgrade expired-message delete dead letters**

  During stale outbox recovery, treat only an exact Feishu `message_delete`
  dead letter with permanent, rejected `230009` evidence as proof that the
  legacy Input Card is already absent. Atomically dismiss the obsolete outbox
  failure, release its quarantine and recovery record, and advance the exact
  retirement from failed to retired. Preserve uncertain deletes unchanged.
  Verify through the durable store recovery seam and rerun the full delivery
  checks before deployment.

## Final delivery checks

After R1-R4 are complete:

1. run findings-first review of both starting-revision-to-HEAD diffs against
   the approved specification, context ownership, compatibility, security, and
   no-replay rules;
2. route material findings through the owning ticket's Red-Green repair;
3. run fresh Core `just check` and `just build` with Zig 0.16.0;
4. run fresh Swarm focused suites, `npm test`, `npm run typecheck`,
   `npm run architecture:check`, `npm run build`, and `git diff --check`;
5. inspect all commit boundaries, messages, and trailers; do not push;
6. report production rollout as pending. Do not install, restart, migrate the
   live database, or delete live Lark messages without a separate explicit
   confirmation.
