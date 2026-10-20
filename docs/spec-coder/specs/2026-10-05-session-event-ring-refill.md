# Session Event Ring Cursor Rebase and Legacy Input Card Retirement

## Status and authority

- **Design approval:** Gate 1 approved the durable cursor-rebase design and the
  user then explicitly added legacy Input Card cleanup and remaining related
  TODO incidents to the same repair.
- **Specification approval:** Gate 2 approved this written specification on
  2026-10-05.
- **Scope:** coordinated Herdr Core and Herdr Agent Swarm change. Core owns the
  bounded Session Event Ring and resumable transport contract. Swarm owns
  durable consumption, exact owner recovery, canonical card projection, and
  durable retirement of its historical Input Card messages. Lark is delivery
  output only.
- **Prior delivery:** Core commits `d9800683`, `52d937c8`, and `040948b5`
  delivered the shared bounded ring, capability-gated session ring v2, cold
  refill, and handoff transfer. Swarm commits `fe63c1c2` and `ffada161`
  delivered stable session lanes and fail-closed cursor-expiry reporting.
  Those commits are retained; this repair closes the missing rebase path.

## Problem

Core's refill is working and intentionally retains at most 512 events. When a
Swarm lane checkpoint is older than that window, Core returns
`cursor_expired { earliest_cursor, latest_cursor }`. Session ring reads use an
exclusive `after` cursor, while `earliest_cursor` identifies the first retained
event. Swarm therefore cannot safely use `earliest_cursor` as `after` without
skipping that event, and it cannot decrement an opaque cursor. Today it retries
the unchanged stale checkpoint forever. The affected `9e2u` lane reached at
least retry 41, left `agentInput.ok=false`, and accumulated projection lag.

That stalled lane can also strand accepted native submissions before an exact
Core turn identity is attached and can hide Assistant output that already
exists in the canonical Core session. The user-owned main-checkout `TODO.md`
records both the `ri14` missing-output incident and the accepted-native-input
state that remains at "awaiting exact Core turn identity without replay".
They are evidence for this repair, but that uncommitted file is not edited or
copied into the task branch.

Separately, the canonical-only Turn Card migration stopped creating new Input
Cards but deliberately preserved historical external cards. Production rows
now include old `input_card_views` that remain visibly Working even when their
Submission Intents are terminal. Clearing SQLite rows would lose ownership and
delivery evidence while leaving Lark messages visible. Pending or uncertain
rows are especially unsafe to withdraw until exact canonical ownership is
resolved.

## Outcomes

1. A retained-window refill remains bounded, and an expired Swarm checkpoint
   is rebuilt once from a Core-provided safe resume cursor instead of retried
   forever.
2. The rebase records the missing interval as durable projection-gap evidence
   and ingests every retained event, including the earliest event, with stable
   event-ID deduplication.
3. Accepted or uncertain Submission Intents acquire exact canonical Human/turn
   identity through receipt and Core evidence when available, or reach a
   durable actionable recovery outcome. Agent Input is never replayed.
4. Assistant output such as the `ri14` incident converges from authoritative
   Core events through the existing inbox/projector/outbox path without
   production-state inference from visible cards.
5. Ownership-proven historical Input Card messages are retired through the
   durable `message_delete` outbox. The legacy view becomes retired only after
   a deleted or already-absent acknowledgement.

## Non-goals

- Do not enlarge the 512-event ring or expose unbounded JSONL through normal
  session reads.
- Do not rewrite, reorder, or truncate Core JSONL.
- Do not replay Agent Input, reconstruct prompt text from Lark, or infer Core
  state from card text.
- Do not delete uncertain/pending Input Cards merely because they are old.
- Do not clear `input_card_views` manually or delete unrelated Answer, Turn,
  Main, Worker, operation-result, or interaction cards.
- Do not implement unrelated open TODOs such as Pane-token thread titles,
  Primary-tool credential adoption, long Answer rollover, or Delivery Ring
  observability.
- Do not install or restart either production service in this specification;
  deployment remains a separate explicit confirmation gate.

## Domain language and ownership

| Term | Owner | Meaning |
| --- | --- | --- |
| **Session Event Ring** | Core | Fixed-capacity ordered events for one exact `(agent_kind, session_id)`. |
| **Ring cursor** | Core | Opaque monotonic position; `after` is exclusive. |
| **Resume cursor** | Core | Opaque cursor immediately before the first retained event, safe to pass as `after`. |
| **Lane checkpoint** | Swarm | Durable cursor and projection position for one owner generation and exact session. |
| **Cursor rebase** | Swarm | One atomic transition that records an evicted interval and replaces the stale read cursor with Core's resume cursor. |
| **Projection gap** | Swarm | Durable evidence that canonical history was evicted or exact projection evidence is incomplete. |
| **Exact owner recovery** | Swarm + Core | Bounded query for one Submission Intent or exact turn, never a whole-session replay. |
| **Legacy Input Card** | Swarm compatibility | Historical admission-time Lark message represented by `input_card_views`; no new ordinary input creates one. |
| **Card retirement** | Swarm delivery | Durable request and acknowledged result for deleting one ownership-proven legacy Lark message. |

Core never owns Swarm checkpoints or cards. Swarm never interprets opaque Core
cursors. Lark never owns workflow state.

## User scenarios

### SCN-R1 — Expired cursor resumes at the complete retained window

Given a lane checkpoint before Core's retained window, Core returns a typed
expiry containing `resume_cursor`, `earliest_cursor`, and `latest_cursor` from
one ring/epoch snapshot. Swarm atomically records the missing interval and
changes only the lane read cursor to `resume_cursor`. The next read returns the
first retained event rather than skipping it.

### SCN-R2 — Duplicate refill remains projection-idempotent

If a crash, retry, handoff, or concurrent observer rereads retained events,
stable `(lane_id, event_id)` identity resolves to the existing lane item.
Previously projected events never become pending again and create no new Turn
Card, Answer page, Input Card, or delivery intent.

### SCN-R3 — Concurrent or stale rebase loses safely

Only a transaction that still observes the reported stale checkpoint and the
same lane/session identity may rebase it. A competing winner, changed epoch, or
changed checkpoint returns `stale_rebase`; callers reopen/reread Core rather
than overwriting newer progress.

### SCN-R4 — Accepted submission acquires exact turn identity

When Core has accepted a native submission but Swarm has not yet attached an
exact turn, receipt reconciliation and retained canonical Human events bind the
Submission Intent to the exact session/turn. If the needed event was evicted,
Swarm runs only the existing submission/turn-fenced recovery. `indexing` stays
retryable; `not_found`, `ambiguous`, or unavailable exhaustion becomes durable
needs-human evidence with an actionable diagnostic. No outcome resubmits input.

### SCN-R5 — Missing Assistant output converges after repair

For a `ri14`-shaped Prompt whose native submission is accepted, the repaired
lane consumes retained Assistant and terminal events and projects them through
the normal conversation/Answer outbox. If those exact events were evicted, an
identified active/pending owner or already-open gap may request exact-turn
recovery. An unowned historical interval produces no card work.

### SCN-C1 — Terminal legacy Input Card is withdrawn

For a legacy Input Card with an exact delivered `message_id` and a Submission
Intent already proven terminal/canonically adopted, Swarm atomically records a
retirement operation and one idempotent `message_delete` intent. A deleted or
already-absent delivery acknowledgement marks that exact legacy view retired.

### SCN-C2 — Pending or uncertain card waits for authority

A legacy Input Card whose Submission Intent remains pending, accepted without
exact canonical identity, or uncertain is not withdrawn. It first follows
SCN-R4. Only a later ownership-proven terminal outcome makes it eligible.
Ambiguous/conflicting identity remains visible and needs human action.

### SCN-C3 — Retirement survives retries and restart

Repeated scans, process restart, concurrent store handles, outbox retry, and
duplicate deleted/already-absent callbacks converge on one retirement operation
and one semantic delete effect. Retryable delivery failure retains the pending
operation; permanent failure is durable and does not pretend the card vanished.

### SCN-C4 — Missing or conflicting Lark identity fails closed

A legacy row without an exact delivered message ID, with conflicting Gateway
or ownership evidence, or with a non-terminal delete outcome is not marked
retired. No target is guessed and no SQLite row is erased.

## Invariants

- **INV-R1 — Bounded source:** normal session reads expose only the retained
  ring window; exact recovery is owner/turn scoped.
- **INV-R2 — Complete boundary:** a rebase begins immediately before the first
  retained event and therefore cannot omit that event.
- **INV-R3 — Opaque cursors:** only Core constructs or interprets ring cursors.
- **INV-R4 — Atomic rebase:** gap evidence and checkpoint replacement commit
  together under exact old-checkpoint and lane/session/epoch fences.
- **INV-R5 — Stable deduplication:** each stable `(lane_id, event_id)` has one
  durable lane item across refill, rebase, handoff, retry, and restart.
- **INV-R6 — No input replay:** accepted, uncertain, cursor-expired, and
  recovery-failure paths never invoke Agent Input submission.
- **INV-R7 — Independent progress:** one gap or needs-human owner does not
  prevent later independent Human Messages from ingestion and projection.
- **INV-R8 — Authoritative output:** Assistant/terminal projection comes only
  from Core events or exact Core recovery, never visible card state.
- **INV-C1 — Proven ownership:** only a legacy Input Card durably linked to its
  exact Submission Intent, route/Gateway, and delivered message may retire.
- **INV-C2 — Delete before retire:** local state becomes retired only after a
  `deleted` or `already_absent` acknowledgement for the exact delete intent.
- **INV-C3 — One semantic effect:** each legacy message has at most one active
  retirement operation and one idempotency key across restart and concurrency.
- **INV-C4 — Historical isolation:** retirement does not mutate canonical
  Conversation Segments, Core lane order, Prompt execution, or other cards.

## Architecture and interfaces

### Core Session Ring transport

Extend the capability-gated v2 expiry response additively with
`resume_cursor`. It is the encoded predecessor of `earliest_cursor` in the
same ring and epoch; for an empty/start window it is that ring's start
position. The server computes all three cursors while holding the partition
snapshot used to decide expiry. Existing `earliest_cursor` and
`latest_cursor` meanings do not change, successful batch shapes do not change,
and older consumers may ignore the additional error detail.

The Core CLI/socket adapter must preserve structured error details rather than
turning `resume_cursor` into text. Swarm accepts automatic rebase only when the
typed response includes a valid non-empty resume cursor. An older Core that
omits it remains fail-closed with `cursor_expired` and retry/diagnostic state;
Swarm never substitutes `earliest_cursor` as an exclusive `after` value.

### Swarm Core ingestion

`CoreSessionCursorExpiredError` carries the three cursor fields. The reader
hands the exact lane identity and expired-checkpoint evidence to a store action
equivalent to `rebaseExpiredCheckpoint`. That action owns the transaction:

1. verify lane, source/ring, agent kind, session, epoch, and current stale
   `read_cursor`;
2. append one idempotent `projection_gaps` record for the evicted interval;
3. replace the read cursor with `resume_cursor` while retaining the last known
   latest cursor and monotonic lane sequence; and
4. return `rebased` or `stale_rebase`.

The reader then rereads from the durable checkpoint and ingests through the
existing `ingestBatch` transaction. The supervisor treats successful rebase as
progress, clears exponential retry state after catch-up, and exposes a bounded
gap/recovery diagnostic rather than an endless cursor-expired loop.

### Exact Submission Intent and turn recovery

Agent Input keeps authority over immutable Submission Intent, Core receipt,
effect certainty, and no-replay rules. Conversation Projection keeps authority
over canonical Human/Assistant/terminal events and exact turn ownership. The
existing canonical-input and authoritative-turn recovery interfaces remain the
only historical query paths.

Rebase schedules recovery only for a durable pending/accepted/uncertain owner,
an active turn, or the new open gap. Successful evidence is ingested into the
same stable inbox and reuses existing projectors. Recovery outcomes and retry
budgets are durable; exhaustion produces needs-human state and an exact safe
diagnostic keyed by binding/submission/turn, never prompt text.

### Legacy Input Card retirement

Add a compatibility-only retirement aggregate keyed by `submission_id` (or an
equivalent uniqueness-preserving extension of `input_card_views`). Its state is
`eligible -> deleting -> retired` or `failed`, and it stores the exact
`message_id`, Gateway/route fence, delete outbox ID, attempts/outcome, and
timestamps. Eligibility is derived from durable Submission Intent plus
canonical correlation; card rendering or visible text is never consulted.

Reservation and the `message_delete` outbox row commit together. Reuse the
existing outbound lane, delivery retry/dead-letter rules, and Gateway result
normalization. Generalize the existing deletion-settlement callback so the
exact delete owner is resolved by durable projection/operation identity;
Orchestrator-clear behavior remains unchanged. A deleted or already-absent
result settles retirement; retryable, rejected, uncertain, or conflicting
results do not.

Run eligibility scanning during startup recovery and periodic reconciliation
with a bounded limit. It is idempotent and cannot block ordinary input,
session ingestion, or outbox lanes unrelated to the legacy message.
Legacy deletion is history-class work. The bounded delivery ring keeps FIFO
order within live and history classes, schedules them 3:1, and discards only
unclaimed cached references when new work arrives so a fresh live card can be
rediscovered before a backlog of legacy deletions. SQLite remains authoritative
and active deliveries are never interrupted.

## Failure and consistency decisions

| Condition | Durable outcome | Automatic action |
| --- | --- | --- |
| Expiry with valid resume cursor | gap + rebased checkpoint | read complete retained window |
| Expiry without resume cursor | cursor-expired diagnostic | no guessed cursor; wait for compatible Core |
| Rebase fence loses race | `stale_rebase` | reopen/reread; do not overwrite winner |
| Retained duplicate event | existing lane item | no projection/delivery replay |
| Exact recovery indexing | retryable recovery state | bounded retry |
| Exact recovery absent/ambiguous/exhausted | needs-human evidence | no Agent Input replay |
| Malformed exact-recovery projection | exact Submission Intent marked unavailable/needs-human | isolate candidate, continue bounded batch, never replay Agent Input |
| Eligible card delete acknowledged | retired legacy view | no further delete |
| Delete target already absent or expired (`230009`) | retired legacy view | no further delete; exact pre-upgrade permanent/rejected `message_delete` dead letters converge during startup recovery |
| Delete retryable failure | deleting/pending | outbox retry only |
| Delete permanent/uncertain failure | failed/needs-human | keep ownership evidence; do not mark retired |
| Missing/conflicting legacy target | ineligible/needs-human | no delete and no row clearing |

## Compatibility and migration

- Core's change is additive inside the already capability-gated session ring
  v2 error detail. If compatibility tests show any published codec would reject
  the added field, introduce and negotiate a new method/capability instead of
  mutating that codec.
- Swarm continues to support Core v1 and a v2 server without `resume_cursor`,
  but automatic cursor rebase requires the new typed field.
- SQLite migration is additive and idempotent. Existing lane checkpoints and
  `input_card_views` remain intact. Historical retirement candidates are
  discovered after schema migration; no migration emits external effects by
  itself.
- New ordinary admissions continue to create zero Input Cards. Compatibility
  render/read code remains only for historical rows and can be removed in a
  later separately approved contraction after retirement evidence is complete.

## Testing decisions

### Core

- ring overflow returns `resume_cursor`, `earliest_cursor`, and
  `latest_cursor` from one epoch; reading after the resume cursor returns the
  earliest retained event exactly once;
- empty/start, one-event, full-window, and 513-event windows preserve exclusive
  `after` semantics;
- malformed, wrong-ring, wrong-epoch, and future cursors remain rejected;
- API schema/CLI/socket fixtures retain structured fields and published codec
  compatibility;
- focused `session_ring` tests and `just build` pass with Zig 0.16.0; final Core
  verification follows repository `just check` requirements.

### Swarm

- a red integration test begins with an expired durable checkpoint, rebases,
  ingests the earliest retained event, catches up, and clears retry/lag state;
- injected failure proves gap + checkpoint rollback together; competing store
  handles prove one winner and `stale_rebase` for the loser;
- duplicate retained events leave lane-item, segment/page, revision, and outbox
  counts unchanged;
- `ri14`-shaped Assistant completion and accepted-native-input fixtures recover
  from Core evidence, attach exact turn identity, and submit zero Agent Inputs;
- terminal legacy cards reserve one delete; pending/uncertain cards reserve
  none until exact recovery; duplicate scans/reopen/concurrency reserve no
  second semantic effect;
- deleted and already-absent callbacks retire the exact row; retryable,
  permanent, uncertain, malformed, and mismatched callbacks preserve truthful
  non-retired state;
- focused Core ingestion, inbox/store, canonical recovery, Conversation/Answer,
  outbox/dispatcher, migration, and startup recovery tests pass, followed by
  `npm test`, `npm run typecheck`, `npm run architecture:check`,
  `npm run build`, and `git diff --check`.

## Workspace and baseline evidence

### Swarm

- **Workspace:** isolated worktree
  `/workspace/herdr-agent-swarm/.trae/worktrees/fix-session-ring-cursor-rebase`.
- **Branch / start:** `worktree-fix-session-ring-cursor-rebase` at
  `ffada1611d23fd7512c1e8647747de44c234bbe3`.
- **Ownership:** clean at planning boundary; the main checkout's uncommitted
  `TODO.md` additions and all unrelated worktrees are user-owned and excluded.
- **Dependencies:** `npm ci` completed from the lockfile.
- **Fresh baseline:** `npm run build` passed; installer focus passed 26/26;
  `npm test` passed 272 files / 3,923 tests; `npm run typecheck` exited 0.

### Core

- **Workspace:** isolated worktree
  `/workspace/herdr-core/.trae/worktrees/fix-session-ring-resume-cursor`.
- **Branch / start:** `fix/session-ring-resume-cursor` at
  `040948b5bf9a1e01b55459e846568bf2bfb289cc`.
- **Ownership:** clean at planning boundary; the existing local `master` and
  its nine ahead commits remain untouched.
- **Toolchain:** official Zig 0.16.0 archive, verified against ziglang.org
  SHA-256 `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`,
  selected explicitly through `ZIG`.
- **Fresh baseline:** `just test-one session_ring` passed 3 tests and
  `just build` completed the locked release build.

## Delivery boundary

Implementation may produce atomic local commits after Gate 3 authorization.
Core's repository instruction additionally requires commit-message alignment
before its commit. Neither repository may be pushed. Installation, service
restart, live database migration, legacy-card deletion in production, and the
`9e2u`/`ri14` live acceptance run remain excluded until the user separately
confirms deployment.
