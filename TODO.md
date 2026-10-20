# TODO

## Release version

- [x] Bump `herdr-agent-swarm` to `0.3.0` and synchronize package lock and generated build metadata.
- [x] Bump `herdr-agent-swarm` to `0.4.0` and synchronize package lock, MCP server metadata, release docs, and generated build metadata.
- [x] Bump `herdr-agent-swarm` to `0.5.0` and synchronize package lock, MCP server metadata, release docs, and generated build metadata.

## Architecture

- [x] Continue incremental dead-code and obsolete-test cleanup while deepening
  modules: remove superseded interfaces and fixtures in the same change that
  makes them unreachable, keep tests at stable behavioral seams, and verify each
  cleanup with architecture checks plus the affected suites. The 0.5.0 cleanup
  removed the unreachable rich-text implementations, their dedicated tests,
  two obsolete SQLite protocol tests, and one obsolete event-card fixture while
  retaining the SQLite compatibility migrations required by existing databases.
- [x] Build a unified event integration layer with explicit reliability classes:
  durable inbound records, transactional lifecycle/outbox intent, best-effort
  in-process wake-up hints, and bounded Herdr socket hints. Keep SQLite and fresh
  Herdr reconciliation authoritative; do not collapse these channels into one
  delivery or replay guarantee.
- [x] Isolate malformed Core events at event/reducer-revision granularity with
  three durable attempts, a redacted fingerprint, exact-event quarantine, and
  continued projection of adjacent healthy events.
- [x] Roll back in-memory Core reducer state when a projection attempt fails so
  retries preserve the same event payload and quarantining one event cannot
  consume or renumber its healthy neighbour.
- [x] Commit Core-origin Run/Topic projection changes, any nested durable
  outbound intent, and the exact-event `projected` settlement in one SQLite
  transaction; retain the pending frame across commit failure and restart.
- [x] Track owner-scoped projection and CardKit delivery gaps and render one
  aggregate warning on mutable/new Main, Answer, and Worker cards. Compensate a
  delivery gap only after the exact canonical snapshot is checkpointed.
- [x] Recover an expired Answer target on a new static CardKit page without
  patching the frozen page or replaying Agent work; retain the failed delivery
  and its replacement evidence for audit.
- [x] Protect projection-gap and external-turn-recovery tables with the same
  instance-lease write fence as the rest of the durable workflow state.
- [x] Consume Core's typed historical native-turn recovery with exact identity
  fences and canonical-start audit evidence. Persist bounded exponential
  recovery scheduling, suppress repeated identical logs except at logarithmic
  milestones, preserve blocked/working turns as uncertain, and fail closed
  without replay before releasing later FIFO work.
- [ ] **P0 — Unify Feishu and Herdr interaction flow at the Binding boundary.**
  Route Feishu Human Messages and non-Swarm commands through the same durable
  Binding-owned Prompt admission, FIFO/native Herdr queue, turn supervision,
  Herdr/TraeX submission, Core-event projection, and Answer Card delivery flow
  used for Herdr-originated work. Preserve one Prompt/turn identity and the
  no-replay guarantee across ingress sources. Keep Swarm control commands on
  their separate durable `CommandIntent` lanes while sharing the same fenced
  Binding, generation, pane/session identity, audit, recovery, and outbox
  infrastructure; they must not enter the ordinary Prompt FIFO or fabricate a
  TraeX turn. Cover Human Message, non-Swarm slash-command, active-turn queueing,
  restart recovery, and Swarm-command separation with focused integration tests.
  Source implementation and release validation are complete: the Swarm full
  gate passed 3,164 tests plus type, architecture, documentation, build, public
  release, and diff checks; the isolated Core gate and temporary-home TraeX
  integration lifecycle also passed. Keep this item open until the approved
  production install and live Herdr/Feishu acceptance prove the durable boundary.
  - **Source progress through Tasks 1–7:** Prompt source identity and the managed
    `prompt_id == native_submission_id == Core submission_id` invariant are
    implemented; exact Herdr adoption no longer uses text/time/queue inference;
    Feishu, non-Swarm slash, and Herdr origins share Binding Prompt observation
    and projection; mutation sources converge on CommandIntent with frozen-target
    stale cancellation; legacy Session-operation admission/scanning is retired
    behind an ordered startup drain. Focused task gates, typecheck, and
    architecture checks passed in their owning task reports.
  - **Still open:** the P0 remains incomplete until the approved production
    rollout and live acceptance are evidenced. Deployment, live recurrence
    verification, Core rollout, and Feishu acceptance are not claimed here.
- [ ] **P0 — Start a new durable Answer segment for every subsequent Human
  Message accepted inside an exact Agent turn.** Freeze the current Answer page
  at the canonical pre-message cursor, create a new Answer Card whose
  `Reply to 👤` summary identifies that Human Message, and project later
  Agent/Tool/Goal/Task List facts only to the new segment. Apply the same rule to
  Feishu and Herdr-local input, preserve the existing Prompt/native turn and
  no-replay semantics, and make duplicate-event and restart recovery idempotent.
  See `docs/superpowers/specs/2026-10-01-human-message-answer-segmentation-design.md`.
- [ ] **P1 — Bound long Answer streams with canonical turn-aware card
  rollover.** Treat each canonical Core JSONL `human_message` as the primary
  boundary for creating a new Answer Card, regardless of Feishu receipt or
  delivery order. When no new Human Message arrives, roll over after 30 exact
  Core turns so one card cannot grow without bound. Define precisely which Core
  lifecycle event closes a turn, preserve canonical source cursors and frozen
  pages, and make duplicate replay, restart recovery, and late projection
  idempotent without splitting one turn across cards.
- [x] **P0 — Stop startup from recreating expired Worker `stream_finish`
  deliveries.** An exact rejected Feishu `300307` finalizer may terminalize the
  corresponding active Worker page only when the persisted payload is valid,
  the Worker turn is terminal, and an authoritative terminal Worker snapshot is
  already delivered. Dismiss/release the failed finalizer and page transition
  atomically, backfill the same proof for already released historical rows, and
  verify repeated startup convergence creates no additional `stream_finish` or
  Agent work. Do not generalize `300307` to non-Worker, non-finalizer, malformed,
  uncertain, or snapshot-incomplete deliveries.

## Feishu pane entry threads

- [ ] **P1 — Use the stable Pane token as the Feishu thread title.** Resolve
  the current generation-fenced Pane token from Herdr metadata and use it for
  the group conversation/thread title so the Feishu conversation list shows a
  compact stable token instead of an internal Pane ID such as `wY:p1`. Keep the
  full Pane ID only in durable identity fences, callbacks, audit, and operator
  diagnostics; fail closed to an explicit neutral title when no trustworthy
  token is available rather than presenting the Pane ID as the token.
- [x] Make each link shown for a Swarm Pane open that Pane's corresponding
  Feishu thread directly, while preserving generation-fenced Pane/Binding
  identity and avoiding links to stale or replacement threads.
- [x] From `/swarm panes`, publish a selected active pane's Main Card entry
  snapshot to the group root instead of replying inside the invoking thread.
- [x] Persist a generation-fenced thread alias so replies in the new thread enter
  the selected Binding's existing Agent FIFO without creating another Binding.

## Card readability

- [ ] **P1 — Stream incremental JSONL output into the current Feishu Answer
  Card with bounded latency.** Consume each complete canonical Core/TraeX JSONL
  delta as it becomes durable, project it idempotently through the current
  Answer segment, and wake the owning Primary Pane Ring without waiting for
  turn completion or the periodic reconciliation scan. Coalesce bursty updates
  with a short adaptive window, preserve source-event order, frozen-page and
  CardKit stream-sequence invariants, and never reconstruct partial JSONL lines
  or replay Agent Input. Distinguish multiple incremental Assistant messages
  from one long `output_text` emitted as a single completed JSONL record: true
  token-level display for the latter requires an upstream text-delta or
  checkpoint event. Verify time-to-first-visible-update, sustained update
  cadence, rollover, restart recovery, retry/quarantine, and no duplicate or
  regressing card revisions under long-output load.
- [ ] **P1 — Surface canonical context-compaction, model, and Subagent activity
  in Feishu Turn Cards.** Extend Herdr Core with source-neutral
  `context_compacted` and `model_changed` events and optional model metadata on
  `agent_activity`, mapping the corresponding TraeX and Pi records without
  exposing compaction summaries, prompts, paths, settings, or private
  reasoning. Show compact and model transitions in canonical timeline order,
  keep one stable lifecycle row per Subagent with its reported model, and keep
  the current main-Agent model in the mutable card identity. Preserve stable
  event identity across restart and exact-turn recovery, never patch frozen
  pages, and deploy the tolerant Swarm consumer before Core starts emitting the
  additive payloads.
- [ ] **P0 — Converge completed Goal state into the Feishu card.** Reproduce
  the case where the durable Goal is complete but the visible Answer/Main Card
  retains its previous Goal state. Correlate the exact Core `goal_changed`
  terminal event, persisted Goal projection, card view version, and Ring ACK;
  repair the missing invalidation or projection transition idempotently without
  replaying Agent Input or rewriting frozen Answer pages.
- [x] **P0 — Recover timeline content omitted by the historical double-cursor
  pagination bug.** Detect only pages with durable non-empty cursor coverage
  whose delivered CardKit payload contains no timeline elements, preserve the
  frozen cards and canonical JSONL order, and append idempotent recovery
  continuation cards for the proven missing intervals. Persist recovery
  identity so restart, duplicate scans, outbox retention, and late delivery
  cannot publish the same interval twice; never replay Agent Input or infer
  missing content from visible Lark text.
- [x] **P1 — Show the complete bounded canonical-safe Thinking body when
  expanded.** Keep the
  collapsible summary visible and collapsed by default, but make the expanded
  body contain the full normalized Thinking message whenever it is within the
  6,000-character presentation limit. Above that limit, retain the agreed
  3,000-character head and tail with an explicit omission marker. Herdr Core's
  security boundary intentionally exports only the safe reasoning heading and
  never the raw private chain-of-thought; Swarm must not bypass Core to read it
  from JSONL. Audit the
  canonical timeline reducer, page planner, and CardKit renderer so pagination
  or incremental updates cannot silently replace the expanded body with only a
  summary; preserve redaction, canonical cursors, frozen-page immutability, and
  restart-idempotent rendering.
- [x] **P1 — Mark every frozen Answer Card page as Completed.** In a
  multi-page Turn Card stream, transition each earlier page from Working to
  Completed when that page is durably frozen, instead of leaving every page
  except the final one visibly Working. Keep the final page tied to the whole
  Turn terminal state, preserve frozen-page immutability and page cursor
  coverage, and make rollover, retry, restart recovery, and late projection
  idempotent.
- [x] **P1 — Simplify the Turn Card title to `Project / Tab / Pane`.** Render
  the compact stable identity as, for example,
  `herdr-agent-swarm / a1j3 / 9e2u`, where the three values are the code
  project, Tab token, and Pane token. Remove the duplicated project label and
  the literal `Pane` prefix without changing generation-fenced callback or
  durable identity data.
- [x] **P1 — Show Tool activity that settles at `Waiting for command` in the
  Feishu card.** Reproduce the missing Tool call, including the reported
  `add todo: wait for command` case, from its canonical Core JSONL event and
  determine whether it is filtered during event normalization, Answer timeline
  projection, or CardKit rendering. Preserve both the Tool activity and its
  waiting/blocked status instead of collapsing them into a status-only line;
  do not expose hidden reasoning or rewrite canonical source offsets. Cover
  live streaming, terminal catch-up, pagination, and restart recovery with
  focused tests.
- [x] **P1 — Remove the Native Input Batch envelope from the current card's
  reply header.** When a card renders `Reply to 👤` for one Feishu message, show
  the original message summary without the synthetic `[Feishu message 1/1]`
  prefix. Keep the frozen batch execution body and multi-message boundaries
  unchanged; this is a presentation-only transform and must not rewrite Prompt
  or batch source state.
- [x] **P0 — Converge Feishu Task List from the current native Core plan.**
  Reproduce the reported stale Task List against exact Core event identity,
  compare the durable SQLite Run projection and pending CardKit intent, and
  repair the Core-event-to-card path without inferring plan identity from text
  or order, replaying Agent work, or mutating the live database.
- [x] **P0 — Converge Feishu Goal from the current native Core goal state.**
  Reproduce the reported missing Goal against exact Core event identity and
  determine whether Goal lifecycle events were durably projected before the
  Prompt owner was adopted. Repair the owner projection idempotently from
  exact session/turn/start-fenced durable evidence without replaying Prompt
  text, terminal lifecycle, or unrelated Answer/Tool output. The live incident
  contained no durable Goal event, so Core now normalizes only native TraeX
  `thread_goal_updated` records into typed `goal_changed` events; malformed
  identity/status/time data fails closed and generic tool text is never parsed.
  Exact historical recovery retains Goal events, while late owner adoption
  replays only the persisted Goal/Task List view state through the normal
  idempotent projection path. Deployment and live acceptance remain pending.
- [x] Define one compact information hierarchy for Primary Main, Answer, Worker
  Main, and Worker Task cards.
- [x] Apply the approved hierarchy without changing callback identity, delivery,
  pagination, or recovery semantics.
- [x] Fix tool commands that appear on later Answer Card pages but cannot be
  expanded. Verify page-boundary command-block recognition and generation of
  the corresponding CardKit collapsible panel without changing canonical source
  offsets or frozen-page behavior.
- [x] Increase the default Answer page limit from the inconsistent 9,000/4,000
  live/recovery split to one 10,500-character limit. Keep the 12,000-character
  CardKit payload budget and canonical source offsets unchanged.

## Herdr-originated messages

- [ ] **P0 — Recover Assistant output when a Feishu Prompt remains at “Core confirmed the native submission; observing execution without replay”.** Reproduce the Pane `ri14` incident by correlating the accepted native submission with the Core session-event stream, durable `core_event_inbox` lane/checkpoint, Prompt/Run Card projection, and Answer outbox delivery. Determine where the Assistant final message was lost, repair the responsible boundary idempotently, and prove recovery without TraeX replay or production-state inference from the visible card.
- [ ] **P1 — Make a Primary discovered from a Pane created directly in Herdr
  usable without the misleading Primary-tools warning.** Today `discover()`
  deliberately records no binding-scoped Primary tool capability, so the Main
  Card shows “当前 Pane 并非由 Bridge 使用 Primary 工具凭证启动” and points the
  operator to `/swarm reset` or `/swarm replace`. Define and implement a safe
  adoption or credential-provisioning path for an already-running TraeX Pane,
  preserving binding/generation fencing and never treating an unprovisioned
  runtime as tool-authorized. Cover direct-Pane discovery, restart recovery,
  stale credentials, and the resulting Main Card state with focused tests.
- [x] When a message or turn is initiated directly in Herdr rather than through
  Lark, observe its canonical transcript and converge both the owning Primary
  Main Card and the corresponding Answer Card. Preserve independent projection
  checkpoints, durable outbox ordering, exact turn ownership, and the no-replay
  guarantee; do not infer completion from rendered card state.
- [x] **P0 — Recover an already-projected exact Herdr turn whose owner is still
  unsettled.** Recover an exact Herdr-origin Prompt when its canonical Core events,
  including the terminal event, were already marked `projected` by a previous
  observer but the owning Prompt remains `running/detached`. Use persisted
  event identity and Prompt/binding/session/turn fences to perform one
  idempotent owner-scoped reprojection from the durable inbox. Do not rewind the
  shared lane checkpoint, reopen unrelated projected events, duplicate an
  already-successful Answer projection, infer an unknown outcome, or replay the
  Prompt.
- [x] **P1 — Repair startup Answer convergence idempotently.** When startup
  Answer view convergence encounters `outbound_idempotency_conflict`, identify
  the existing durable intent by its semantic effect and either reuse it or
  prove that a fenced replacement is required. Do not create a second delivery
  effect, mutate immutable Answer history, or replay Agent work. Startup now
  refuses to rebuild a frozen static page unless an unresolved `rebuild_answer`
  recovery is linked to exact Answer coverage; a historical live dead letter at
  the same Run/view version remains untouched and cannot collide with history
  convergence.
- [x] **P1 — Recover Herdr work that was processed but not synchronized to
  Feishu.** Detect durable Prompt/Core events whose owner transition succeeded
  but whose Main/Answer projection or delivery checkpoint is missing, and
  perform an idempotent owner-scoped reprojection from durable evidence. Keep
  canonical ordering and exact Prompt/Binding/turn identity, expose the gap in
  health/status until repaired, and isolate a failed message so it cannot block
  unrelated or newer Feishu updates. Never resend Prompt text or infer workflow
  state from the visible Feishu card. Startup now converges actionable Worker
  cards before quarantine recovery, reserves one versioned authoritative
  hydration snapshot, and releases an old content lane only when exact
  Gateway/turn/page/current-version evidence matches.
- [x] **P1 — Backfill historical Feishu messages left behind after live sync
  resumes.** A new Human Message can wake the observer and restore subsequent
  Feishu updates while older Main/Answer content remains missing. Detect that
  durable historical coverage gap, replay only the missing projection/delivery
  effects in canonical order, and deduplicate against already-successful Lark
  effects. Do not resend Prompt text, duplicate visible messages, or rely on a
  later Human Message as the recovery trigger. Primary Main/Answer startup
  convergence and exact projected-owner repair cover Primary history; Worker
  terminal cards use the same startup path without dispatching Agent work. On a
  production-database copy, all 105 actionable Worker cards converged without a
  per-card failure, 100 hydration snapshots became ready, and 87 of 92 terminal
  historical Worker content quarantines were linked to exact replacements; the
  remaining five nonterminal owners stayed quarantined.
- [x] **2026-09-30T15:17:05Z — Feishu cards stopped advancing again.** The
  operator reported a fresh recurrence after live synchronization had resumed.
  Correlate the affected Binding/Prompt with its last projected Core event,
  Run/Main view version, Answer page checkpoint, pending/dead-lettered outbox
  lane head, and Lark delivery receipt. Repair the missing projection or
  delivery effect idempotently and add a regression that proves periodic/startup
  recovery advances the card without waiting for another Human Message. Treat
  this as a distinct recurrence until durable evidence proves it has the same
  owner and cause as the earlier historical gap.
  - **Recurrence evidence, 2026-09-30T15:26:35Z:** the operator reported again
    that Feishu cards had not advanced. The live database had 32 pending
    outbound effects, all 32 classified as `waitingBehindLane`, with no
    claimable lane head. Preserve this occurrence as independent evidence until
    the exact blocked lanes, historical failed effects, and any durable
    replacement/supersession receipts have been correlated.
  - **Source fix verified on a live-database copy:** startup recovery now
    recognizes legacy `immutable` quarantine classifications only when an
    unclaimed same-owner card update exactly matches the current SQLite view.
    It also retires Lark-rejected (`300307`) Worker finalizers only after a
    current Worker card snapshot is either already delivered or durably queued.
    On a consistent copy of the production database this changed 32/32
    `waitingBehindLane` rows into 19 ready canonical snapshots and zero blocked
    pending rows. Keep this item open until deployment and live delivery are
    verified.
  - **Post-deployment recurrence isolated, 2026-10-01:** repeated startup
    created zero new `300307` finalizers. One independent Primary Answer lane
    remained blocked: an exact Feishu `surface.replace` rejection (`230001`)
    on a legacy `run-card:update` row had no snapshot projection key. The source
    fix now accepts only the immutable prepared Gateway plan plus exact
    Prompt/page/message fences as legacy recovery proof, releases that expired
    target, and rebuilds on a new static Answer Card. Keep this recurrence open
    until the new build is installed and its replacement ACK is observed.
  - **First live rollout follow-up, 2026-10-01:** startup correctly classified
    and froze the legacy `230001` target, but the local create-target validator
    rejected the new static page because the expired legacy page had no retained
    CardKit `card_id`. No Gateway request was issued and the Prompt remained at
    one dispatch attempt. The follow-up source fix validates the durable
    creating/frozen page pair instead, reconstructs the missing recovery link,
    and permits one startup retry only when both Gateway plan and checkpoint are
    absent.
  - **Live recovery verified, 2026-10-01:** build
    `sha256:6bf5e4c5e0405bb1cdbd2251e27ddc0c4375806e98d8c5654a6904d3a90e4fad`
    reopened the exact preflight-rejected replacement once
    (`auto_recovery_count=1`) and released its quarantine. Feishu ACKed the new
    static Answer card and the subsequent catch-up update; page 1 is `active`
    with new message/CardKit identities, all three linked expired-target
    recoveries are `recovered`, and the original Prompt remained at one Agent
    dispatch attempt. The live outbox drained to zero without replaying Agent
    work.
- [x] **P1 — Contain stale Lark Answer targets without blocking newer work.**
  Classify provider error `230001` for an obsolete `card_update` target as an
  exact-target failure, retain the failed effect and recovery evidence for
  audit, and release only a provably newer durable snapshot. Verify that the
  affected lane cannot block unrelated or newer Answer pages. The Feishu
  boundary now maps `230001` only for Primary Answer update operations to the
  existing `expired_view_target` protocol; other purposes and operations remain
  fail-closed.
- [x] **P1 — Bound exact-turn `recovery_not_found` handling.** After a finite,
  configured recovery budget, persist a terminal uncertain recovery outcome,
  stop retrying the missing Core turn, and safely release later FIFO work. Never
  infer completion, attach a different/native-newest turn, or replay the Prompt.
  The default budget is three attempts and is configurable through
  `runtime.recovery.externalTurnNotFoundMaxAttempts`; terminalization retains all
  exact identity fences and requires an `idle`/`done` observation later than the
  canonical turn start.
- [x] **P2 — Retire historical delivery and projection debt in bounded batches.**
  Add an auditable maintenance path that classifies old dead letters and open
  projection gaps, resolves only cases with durable replacement or supersession
  proof, and reports the remainder without keeping top-level health permanently
  degraded. Preserve current live failures and owner-scoped warnings. The
  retention maintainer now records terminal-owner or retention-aged debt in
  bounded, resumable batches; a newer failure invalidates the classification.
  Exact delivered-replacement evidence can settle its recovery, quarantine, and
  projection gap atomically, while unproved source rows remain untouched. A
  production-database copy classified 2,139 delivery recoveries and 148 gaps,
  compensated 3 exactly proven gaps, and reduced operationally current debt
  from 93 to 1 quarantines and from 162 to 11 gaps without mutating the live
  database.
- [ ] Repair Herdr-origin Prompt recovery when the exact Core-native
  `task_started.turn_id` exists in the canonical transcript but is missing from
  Core's `turn_index`. Herdr Core must safely backfill the historical index using
  fenced agent kind, session, transcript/file identity, native turn, canonical
  `started_at`, and checkpoints; Swarm consumes only the typed Core result. A
  missing, incomplete, or ambiguous result must fail closed as uncertain, stop the repeating
  `recover-turn` / `turn_not_found` observation loop, never replay the Prompt,
  and never block later FIFO messages. Verify with a regression test and a real
  Herdr-origin message whose Human Message, Agent output, tools, Goal, and Task
  List converge to the Feishu Answer Card.

## Operator attention notifications

- [x] **P1 — Mention the operator in Feishu when Herdr needs human input.**
  Detect only authoritative Herdr states that explicitly await local approval or
  interactive input, then emit one durable, deduplicated mention notification to
  the configured Feishu conversation with exact Pane/Binding/turn context.
  Clear or supersede the notification when that wait state ends. Preserve the
  local-only approval boundary: the notification must not add remote approve,
  deny, arbitrary terminal-input, process-kill, or pane-kill capabilities.
  Primary and Worker waits now reserve durable episode-scoped notifications;
  Primary recovery also repairs an already-blocked exact running Prompt and
  emits an ordered non-mentioning resolution card when the wait ends.

## Worker Session threads

- [x] Give each new Worker Session generation one independent group-root Thread
  whose root is its sole live Worker Main Card.
- [x] Route ordinary text, `/status`, `/steer <text>`, and `/stop` through an
  exact generation- and pane-fenced Worker Session identity.
- [x] Preserve existing Worker Main Card placement during upgrade and provide an
  idempotent, passive `/instances` entry card without creating a second live
  projection.

## Log monitor

- [x] **2026-09-30T16:08:36Z — SQLite `multiple_running_turns` recurrence**:
  `/status` reported one affected `prompt_jobs` Binding. A WAL-consistent,
  read-only backup identified old Herdr-origin Prompt
  `fb4eb3cb-3349-48aa-8659-6abc2c674ec1` as `running/detached` on exact turn
  `01a0f2a5-0e13-7832-8c5a-bdd6f976cab6` while newer bridge Prompt
  `6f199a7a-ede4-4b56-abe4-66ec7ddf63a4` owned exact turn
  `01a0f2fa-7232-7f80-947c-2eb0e603feb8` for the same Binding generation.
  Source prevention now atomically terminalizes only strictly older, exact,
  detached owners when a later exact Prompt owner is claimed; startup recovery
  applies the same generation- and identity-fenced rule to persisted rows. The
  older outcome remains explicitly uncertain, no Prompt identity is replaced,
  and no Prompt is replayed. On a consistent production-database copy the
  integrity count changed from 1 to 0, the full Prompt ID sequence was
  unchanged, the old exact turn was retained as `failed/completed`, and the
  newer exact Prompt remained the sole `running/detached` owner. Focused tests:
  `tests/sqlite-prompt-running-integrity.test.ts`.

- [x] **2026-09-30T04:31:23Z — SQLite write capacity failure**: Card projection
  updates for `main:c9d37370-f250-4d9e-93a7-5d673aaa7098` failed with
  `ERR_SQLITE_ERROR: database or disk is full` and were scheduled for retry.
  Evidence: `~/.local/state/herdr-agent-swarm/logs/service.log`, event
  `card-update-failed`. The live database is on the 99%-used root filesystem,
  while `/data00` had ample free space. The configured state now resolves to
  `/data00`; a read-only audit found an intact database, a bounded WAL, and
  reusable freelist pages while hourly retention continued to prune history.
  `swarm:doctor` now checks the filesystem containing the effective database
  path, fails for unavailable/unwritable or sub-1 GiB storage, and warns below
  10% available capacity. Operators must relocate the complete DB/WAL/SHM set
  offline rather than mutating a live database.

- [x] **2026-09-30T05:10:04Z — Card context rebuild loop**:
  `card-context-rebuild-failed` continues to report
  `outbound_idempotency_conflict`, preventing durable card-context convergence.
  Evidence: `~/.local/state/herdr-agent-swarm/logs/service.log`, repeated event
  through 05:10Z (no binding/prompt ID on these records). Trace the conflicting
  outbox/idempotency record and add a recovery path that preserves delivery
  idempotency; do not manually replay prompt work. Card-context convergence now
  reuses exact Worker-thread-entry effects and fences changed, immutable Primary
  Answer or Worker Main snapshots behind a new view-version key. Existing
  attempted rows remain unchanged, exact target mismatches still fail closed,
  and failure logs include the invalidation target identity.

- [ ] **2026-09-30T05:53:41Z — External turn recovery cannot find Core turn**:
  the observer repeatedly received `turn_not_found` from
  `herdr agent events recover-turn` for binding
  `6da2db47-07cc-409c-b81e-f8b1e64395de`, pane `wN:p4E`, turn
  `01a0f084-b16b-7302-85a6-10c7317d7c45`; observation remained deferred.
  Evidence: `service.log`, event `external-turn-observation-failed`. Confirm
  the canonical transcript contains this exact native turn, but Core's index
  covers only an older prefix because source identities rotated after
  `runtime_identity_changed`. Backfill/repair the Core-owned index and converge
  only from the authoritative Core API—do not replay the user prompt.

- [x] **2026-09-30T06:07:18Z — Core inbox cursor conflict disables structured
  answer output**: `traex-transcript-read-failed` reported `Core event inbox
  cursor conflict` for binding `fb1188e4-1ad2-4cee-b68c-45412a35bc96`, prompt
  `49468968-20f8-40d3-9b1d-8f102f4bc2ec`, pane `wN:p4P`; the turn continued
  with `structured_output_unavailable`. Evidence: `service.log`. Stale readers
  now receive a typed `stale_rebase` result, preserve the durable checkpoint,
  reject unseen opaque-cursor tails, and reread from Core without modifying
  Prompt delivery state or permanently disabling observation.

- [ ] **2026-10-02 — Native submission accepted but exact Core turn identity is
  still pending**: handle the state reported as `Native submission accepted;
  awaiting exact Core turn identity without replay`. Preserve the no-replay
  boundary while ensuring the accepted submission can durably acquire its exact
  Core turn identity or surface an actionable recovery outcome.

- [ ] **2026-10-02 — Monitor Feishu Delivery Ring buffer health**: expose
  bounded, content-free diagnostics for Delivery Ring capacity, current queued
  and active counts, saturation/backpressure, stale-reference skips, oldest
  queued age, and outbox rediscovery after crash or shutdown. Correlate by safe
  lane/outbox identifiers without logging card payloads or user message text;
  keep the durable outbox authoritative and keep `/ready` independent of normal
  transient ring occupancy.

- [ ] **2026-10-02 — Do not reject Feishu message bursts when the Prompt queue
  is full**: remove the user-visible `This topic's prompt queue is full`
  rejection for consecutive Feishu messages. Preserve the existing per-Binding
  ordering and bounded native-input batching/backpressure guarantees, but keep
  accepted messages durable and allow them to join the batching or queued-work
  convergence path instead of returning `⚠ 请求未执行`.

- [ ] **2026-10-03 — Repair notification delivery and the corresponding skill**:
  make the notification capability discoverable and usable from the active
  TraeCode skill catalog, then verify end-to-end delivery independently from
  scheduled-task execution. Audit the skill/plugin manifest, installation and
  catalog-refresh path; use one canonical `notification` name while returning
  a clear correction for the common `notificaiton` typo. Distinguish
  `skill_unavailable`, configuration/authentication failure, transport failure,
  and successful delivery instead of reporting every case as “cannot use”.
  Keep notification intent durable and idempotent, add bounded retry/backoff and
  duplicate suppression, and expose content-free health/error diagnostics.
  Add focused tests for discovery after restart, missing configuration,
  transient retry, permanent failure, duplicate requests, and one successful
  notification; document installation, configuration, supported channels, and
  a read-only diagnostic command. Prefer a narrow notification port plus a
  channel adapter so Feishu/system notification transports can evolve without
  coupling skill discovery to delivery mechanics.

- [ ] **2026-10-05 — Clarify Human Request card headers**: add a compact,
  readable provenance header for automatically injected or replayed content,
  such as `↪ Reply · Human Request`, and keep the original user message
  visually distinct from system/task-list injections without treating those
  injections as new Human Messages.

- [x] **2026-10-06 — Human Review completion actions from trace output**:
  when a trace reaches a terminal point that requires human review, invoke the
  canonical `herdr-choice-list` skill (the implemented name for the originally
  requested `herdr-button-list`), append a compact button list for the allowed
  next actions, and mention the responsible Feishu user only after that card
  revision is acknowledged. Keep the mention and buttons correlated to the
  exact turn/session and idempotent across replay;
  do not expose private reasoning or infer approval from a button render.
