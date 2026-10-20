# Unified Core Session Event Stream Implementation Plan

Specification: [../specs/2026-10-02-unified-core-session-event-stream.md](../specs/2026-10-02-unified-core-session-event-stream.md)

Approval status: Gate 1 design, Gate 2 specification, and Gate 3 tickets and implementation authorization approved on 2026-10-02.

## Workspace and baseline

- Swarm worktree: `/workspace/herdr-agent-swarm/.trae/worktrees/unified-session-events`
  - branch: `worktree-unified-session-events`
  - starting revision: `e5fb6f11dba0340032ed1ca35465e685ea809799`
  - baseline: `npm run typecheck`, `npm run build`, and the full Vitest suite passed (530 suites, 3,561 tests).
- Core worktree: `/tmp/herdr-core-unified-session-events`
  - branch: `feat/unified-session-events`
  - starting revision: `dc666042e74a4a655145b706a63746d81a57b070`
  - baseline: Linux format/clippy, 3,374 nextest tests, maintenance, UI architecture, integration-asset, and documentation-contract tests passed.
  - known environment limitation: Windows cross-lint cannot compile bundled SQLite because this host lacks a compatible MSVC C toolchain and standard headers.
- The original Swarm and Core checkouts contain unrelated user work. Tickets may modify and commit only their isolated-worktree paths. No install, restart, deployment, push, PR, or main-branch merge is part of this plan.
- Each completed ticket receives one path-scoped atomic Conventional Commit in the repository it changes. Cross-repository dependencies use frozen contract fixtures rather than uncommitted file copying.

## Tickets

### - [x] T1: Return durable Core PTY submission receipts without transcript evidence

| Field | Content |
| --- | --- |
| What to build | Extend Core's managed prompt submission so caller submission IDs have durable `prepared -> accepted/rejected/uncertain` receipts and a queryable public lookup. Persist the no-replay boundary before PTY work may begin; report accepted only after text plus Enter crosses the Core submission boundary. Duplicate identical requests return the same receipt and conflicting reuse fails closed. |
| Spec references | US2; Submission Receipt; Prompt Execution responsibilities; Behavior & Failure Modes for pre-boundary rejection, post-boundary uncertainty, response loss, and no replay. |
| Ownership and implementation path | Core owns receipt identity and state in its Agent-event journal/persistence boundary. The PTY actor reports a typed completion receipt to the API application seam; API schema/server translate it without exposing internal paths. Receipt transitions and immutable request identity are one durable consistency boundary. JSONL/Human Message/turn metadata cannot decide submission success. |
| Acceptance criteria and verification | Red-Green Core tests cover accepted, deterministic pre-boundary rejection, post-boundary close/crash uncertainty, lost client response followed by lookup, identical duplicate submission, conflicting duplicate ID, and reopen durability. Run focused journal/API/PTY tests, `cargo fmt --check`, and relevant clippy targets. |
| Blocked by | None |

### - [x] T2: Persist cursor-safe Core session event history

| Field | Content |
| --- | --- |
| What to build | Deepen the existing Core Agent-event journal into a durable per-session-epoch event history with stable event IDs, opaque ordered cursors, earliest/latest bounds, bounded reads, retention gaps, and explicit source/session epoch transitions. Preserve incomplete-record and reread deduplication behavior. |
| Spec references | US4, US6, US7; Core Session Event Stream; Session Event Cursor; Core journal atomicity and retention behavior. |
| Ownership and implementation path | Core journal remains the ordering authority. Cursor advancement and event insertion are atomic; the journal validates stream/epoch cursor use and reports typed expiration instead of silently skipping. JSONL file/path identity stays internal source metadata. Reconstitution after restart restores cursor, deduplication, and source epoch without replaying external work. |
| Acceptance criteria and verification | Red-Green journal/source tests cover ordered append/read, duplicate reread, restart round trip, partial record, truncation/rotation/session replacement, cross-stream cursor refusal, retention expiry, and bounded/redacted payloads. Run focused Core journal/source tests, format, and relevant clippy. |
| Blocked by | None |

### - [x] T3: Expose the path-free Core Session Event Stream contract

| Field | Content |
| --- | --- |
| What to build | Add the capability-advertised v2 API/CLI contract that opens a session stream from `pane_id`, resolves and validates Agent source/session identity inside Core, and returns bounded historical reads after an opaque cursor. Leave existing `events.*` and `agent.events.*` request/response shapes unchanged. |
| Spec references | US3, US7, US9; Herdr Core responsibilities; Compatibility & Migration. |
| Ownership and implementation path | API schema owns transport validation; the Core session-event service owns Pane/terminal/Agent/session validation and source discovery; journal interfaces from T2 own cursor history. Boundary responses expose stream/session epoch and cursor data but never transcript paths. Capability negotiation is additive and fail-closed on unsupported method shapes. |
| Acceptance criteria and verification | Red-Green schema/server/CLI tests prove Pane-only open, stale Pane/session refusal, no path fields, read-after-cursor, cursor-expired response, capability advertisement, and byte-for-byte preservation of legacy API contracts. Freeze representative open/read/gap fixtures. Run focused API/CLI tests, documentation-contract tests, format, and relevant clippy. |
| Blocked by | T2 |

### - [x] T4: Publish selected Core-native facts into the unified durable stream

| Field | Content |
| --- | --- |
| What to build | Add submission receipt and selected Pane/session/runtime facts to the same durable session order as Agent-derived events, then publish a lightweight existing-EventHub wake-up/reference after commit. Add bounded subscribe/follow behavior whose recovery always reads the durable cursor history. |
| Spec references | US4-US8; Core Event Stream architecture; EventHub wake-up-loss behavior; managed/direct Human coexistence. |
| Ownership and implementation path | Core event normalization translates selected native facts into the session envelope; the journal transaction assigns authoritative cursor/event identity; EventHub remains volatile fan-out only. Receipt events reference T1 submission IDs. High-volume presentation-only EventHub events remain excluded. |
| Acceptance criteria and verification | Red-Green tests prove common ordering across Agent/native events, commit-before-wake, lost/coalesced wake recovery, existing 512-entry EventHub behavior, bounded subscribe frames, stable deduplication, and no persistence of excluded UI events. Extend frozen receipt/event fixtures. Run focused journal/EventHub/API tests, format, clippy, and relevant maintenance tests. |
| Blocked by | T1, T3 |

### - [x] T5: Submit clean Native Input Batch execution bodies

| Field | Content |
| --- | --- |
| What to build | In Swarm, expose `executionBody` on a dispatch claim by reconstructing immutable `prompt_inputs` in ordinal order. Keep the existing formatted batch body for cards/audit, and submit only the execution body for Primary and bootstrap dispatch paths. |
| Spec references | US1; Native Input Batch execution body; Prompt Execution responsibilities; compatibility requirement preserving display data. |
| Ownership and implementation path | SQLite prompt-dispatch transaction/store owns the ordered member reconstruction and refuses missing/duplicate/inconsistent membership. Coordinators consume the explicit execution field and never regex-strip presentation markers. Ordinary prompts retain their body unchanged. |
| Acceptance criteria and verification | Red first at store and dispatcher public seams for one/two/three-member batches, reopen persistence, literal `[Feishu message 1/1]` user text, missing/duplicate member refusal before submission, and ordinary prompt compatibility. Run focused native-batching/dispatch tests, `npm run typecheck`, and `npm run build`. |
| Blocked by | None |

### - [x] T6: Consume the capability-gated Core v2 stream without transcript paths

| Field | Content |
| --- | --- |
| What to build | Extend the Swarm Core adapter with v2 capability detection, Pane-only stream open/read/subscribe, typed cursor-gap and receipt lookup results, and shared contract fixtures. Select v2 only when advertised; preserve explicit legacy `events`, `jsonl`, and `shadow` modes. |
| Spec references | US3, US7, US9; Swarm infrastructure responsibilities; Cross-repository contract. |
| Ownership and implementation path | The adapter translates Core protocol data into internally owned normalized envelopes/results. Default v2 coordinators receive no path/JSONL representation. Composition chooses v2 vs legacy from capability/configuration; legacy parsing stays isolated and cannot silently satisfy a v2 request. |
| Acceptance criteria and verification | Red-Green adapter/composition tests use frozen Core fixtures for capability, open, read, receipt, cursor gap, unsupported method, legacy fallback, and absence of transcript paths in requests/persistence/logs. Run focused adapter/config/composition tests, typecheck, and build. |
| Blocked by | T3, T4 |

### - [x] T7: Backpressure Core events through a bounded Swarm ingestion ring

| Field | Content |
| --- | --- |
| What to build | Add the 512-event `CoreEventIngress` process-local ring between the v2 socket reader and `core_event_inbox`, with one ordered producer/drain per stream epoch, no overwrite, transactional inbox event/cursor commits, reconnect from the last committed cursor, and periodic debt rediscovery. |
| Spec references | US4-US7; Swarm Ingestion Ring; Durable Core Event Inbox; Swarm infrastructure and saturation/recovery behavior. |
| Ownership and implementation path | Runtime ring owns only bounded volatile buffering/backpressure. `CoreEventInboxStore` remains durable authority for event dedupe, cursor advancement, projection debt, and restart recovery. Full capacity pauses/closes upstream intake; it never advances the seen cursor. Recovery Supervisor/reader resumes from the store's committed cursor. |
| Acceptance criteria and verification | Red-Green reader/ring/store integration tests cover order, duplicate wake/batch, full-ring backpressure, no overwrite, crash before and after inbox commit, reconnect, restart/reopen, stale cursor, one loop per epoch, and no TraeX replay. Run focused runtime/store/recovery tests, typecheck, and build. |
| Blocked by | T6 |

### - [x] T8: Converge Prompt execution from Core receipts without exact turn identity

| Field | Content |
| --- | --- |
| What to build | Replace the interim awaiting-exact-turn state with immediate accepted/no-replay observation from the Core receipt. Recover lost responses by receipt lookup; handle uncertain and rejected states conservatively; make native turn ID/start time optional correlation metadata rather than required Prompt ownership. |
| Spec references | US2, US6-US8; Submission Receipt; Observation Epoch; Prompt Execution responsibilities; no-replay invariant. |
| Ownership and implementation path | Prompt dispatcher/recovery workflows coordinate store transitions through existing atomic prompt/run-card/outbox seams. Core receipt identity fences the managed submission. Observation starts at the receipt/stream position under Binding generation and active-turn invariants. No path may resubmit an accepted or uncertain prompt. |
| Acceptance criteria and verification | Red-Green dispatcher/recovery/store tests cover immediate accepted UI/state, uncertain escalation without replay, rejected pre-boundary outcome, response-loss lookup, process reopen, duplicate recovery hints, optional later turn enrichment, and absence of the old waiting string. Run focused prompt/turn/recovery tests, typecheck, and build. |
| Blocked by | T1, T6 |

### - [x] T9: Project unified events with conservative managed/direct correlation

| Field | Content |
| --- | --- |
| What to build | Route v2 inbox events through the existing reducers/projectors and Recovery Supervisor, preserving ordered best-effort managed Prompt observation while representing direct Herdr Human input under existing external-prompt policy. Ambiguous ownership must become uncertain/`needs_human` and cannot steal output or authorize replay. |
| Spec references | US4, US6-US8; Observation Epoch; projection and ambiguity failure modes. |
| Ownership and implementation path | Durable inbox projection owns event checkpointing; coordinator/recovery owns Binding-generation and active-turn decisions; domain reducers own user-visible Prompt/Run Card transitions. Optional turn metadata strengthens fencing only when present. Existing `needs_human` precedence and no-replay recovery rules remain authoritative. |
| Acceptance criteria and verification | Red-Green projection/recovery integration tests cover managed output without exact turn ID, later enrichment, direct Human input, ambiguous interleaving, duplicate/stale events, projector crash/retry, restart, `needs_human` precedence, and no output theft/replay. Run focused event/coordinator/store tests, typecheck, and build. |
| Blocked by | T7, T8 |

### - [x] T10: Buffer Feishu delivery through a bounded lane-aware ring

| Field | Content |
| --- | --- |
| What to build | Insert a process-local Delivery Ring between durable outbox lane-head selection and `OutboundDeliveryExecutor`. Bound it to 100 references, retain at most four active sends, allow at most one queued/active reference per lane, preserve live/history fairness, and stop selection when full. |
| Spec references | US10; Feishu Delivery Ring; outbound Swarm infrastructure responsibilities; Delivery Ring failure modes. |
| Ownership and implementation path | Durable outbox remains authoritative for payload, lane order, retry/cooldown, idempotency, claim/checkpoint, and quarantine. The ring stores only rediscoverable references. The executor atomically revalidates/claims immediately before provider delivery. Dispatcher shutdown stops intake/new sends, boundedly drains/checkpoints active calls, and leaves unstarted rows pending. |
| Acceptance criteria and verification | Red-Green drain/dispatcher/executor/store tests cover full capacity/no overwrite, four-active maximum, 100-work scan bound, one lane reference, live/history fairness, stale/superseded/cooled-down references, claim-at-send, provider uncertainty, retry refill without busy-loop, crash rediscovery, and orderly shutdown. Run focused outbound/publisher/restart-safety tests, typecheck, and build. |
| Blocked by | None |

### - [x] T11: Complete cross-repository compatibility, architecture, and end-to-end verification

| Field | Content |
| --- | --- |
| What to build | Assemble the approved Core/Swarm v2 path, update current architecture/domain/operator documentation, validate frozen fixtures in both repositories, and prove the supported legacy fallback. Remove only obsolete exact-turn requirements from the new default path; retain explicitly approved rollback modes. |
| Spec references | All user stories; Compatibility & Migration; Cross-repository contract; Out of Scope. |
| Ownership and implementation path | Core remains the source of session-event and receipt truth; Swarm inbox/outbox remain workflow/delivery truth; rings remain bounded volatile adapters. Composition roots assemble concrete implementations without importing JSONL/path concerns into coordinators. Documentation uses these same domain boundaries and names. |
| Acceptance criteria and verification | Run built-Core/Swarm integration scenarios for accepted submission, disconnect/reconnect, duplicate event delivery, session replacement, ring recovery, and legacy capability absence. Run full Core native checks and full Swarm `npm test`, `npm run typecheck`, and `npm run build`; audit docs/architecture and dependency directions; inspect both Git logs/statuses and commit messages. Attempt Windows cross-lint only if a compatible toolchain exists, otherwise retain the explicit environment limitation. |
| Blocked by | T4, T5, T9, T10 |

### - [x] T12: Preserve terminal Core receipts across repeated journal reopen

| Field | Content |
| --- | --- |
| What to build | Repair Core journal initialization so opening a current v2 database never retags it as v1 or reruns the destructive v1 receipt migration on a later restart. |
| Spec references | US2, US6; Submission Receipt; no-replay invariant; delivery review finding. |
| Ownership and implementation path | Core journal schema initialization owns `user_version`; only a new version-0 journal may establish the legacy v1 bootstrap before the existing v1-to-v2 migration. Current databases remain unchanged on reopen. |
| Acceptance criteria and verification | Red-Green journal test proves accepted and rejected receipts retain their exact terminal state through two consecutive reopens. Run focused receipt tests, Core native checks, and commit the repair atomically. |
| Blocked by | T11 |

### - [x] T13: Converge cursor gaps and ambiguous correlation to durable needs-human

| Field | Content |
| --- | --- |
| What to build | Repair Swarm recovery so an expired Core session cursor and ambiguous managed/direct projected-turn evidence stop retrying as detached work and instead durably become an explicit uncertain/`needs_human` outcome without replay. |
| Spec references | US7-US8; Observation Epoch; Prompt Execution responsibilities; no-replay and explicit ambiguity failure modes; delivery review findings. |
| Ownership and implementation path | The Prompt recovery store owns one generation-, Pane-, session-, and Prompt-fenced atomic transition across Prompt state, Run Card projection, recovery-attempt cleanup, audit, and rediscoverable outbox intent. The detached observer recognizes Core's typed cursor gap, refreshes Core runtime evidence, and invokes that transition; projected-turn correlation invokes the same transition when multiple managed/direct candidates make ownership ambiguous. |
| Acceptance criteria and verification | Red-Green public-seam tests prove an exact-turn cursor gap uses durable accepted/no-replay identity plus a fresh matching Core runtime observation to reach `needs_human`, and duplicate Human/start/terminal evidence atomically reaches the same state instead of remaining `recovering`. Tests also prove no TraeX submission/replay, stale fences fail closed, and recovery diagnostics expose the outcome. Run focused observer/workflow/store/recovery tests, `npm run typecheck`, and `npm run build`. |
| Blocked by | T9, T12 |

### - [x] T14: Migrate the previously deployed rich journal v2 into the unified receipt schema

| Field | Content |
| --- | --- |
| What to build | Make the unified Core journal reopen the already deployed rich v2 `pending_submissions` schema instead of failing with `journal_unavailable`, while preserving the conservative no-replay boundary for every legacy receipt. |
| Spec references | US2, US6; Submission Receipt; Compatibility & Migration; no-replay invariant; deployment evidence from the live v2 journal. |
| Ownership and implementation path | Core journal schema initialization owns schema-shape detection and one transactional migration to a new unique journal version. Legacy `observed`/`terminal` receipts become accepted, legacy `cancelled` becomes rejected, and legacy `prepared`/`legacy_unavailable` become uncertain. Current unified v2 receipts retain their exact state. Obsolete exact-turn columns are not exposed by the v2 API. |
| Acceptance criteria and verification | Red-Green journal reopen tests construct the deployed rich v2 schema and prove the conservative state mapping, identity preservation, current-v2 preservation, idempotent reopen, and upgraded version. Run focused journal tests, format, clippy, release build, then validate the real journal through the public `herdr agent events sources` seam after live handoff. |
| Blocked by | T13 |

### - [x] T15: Keep bounded Core reads compatible and drain newer session work during exact recovery backoff

| Field | Content |
| --- | --- |
| What to build | Repair the Swarm v2 transport boundary so valid bounded Core session-event pages fit the socket frame budget, and ensure an older exact-turn recovery failure or durable backoff does not prevent the current session stream from being opened and drained for a newer accepted native submission. |
| Spec references | US2, US4, US6, US8; Swarm Ingestion Ring; Observation Epoch; no-replay and bounded transport invariants; production recovery evidence. |
| Ownership and implementation path | The v2 adapter owns a smaller count-bounded read request while the socket subscriber retains a finite frame ceiling compatible with Core's public wire contract. `ExternalTurnObserver` treats exact-turn recovery and current-stream ingestion as independent convergence lanes: exact recovery remains ordered and fenced, but its backoff or transport failure cannot return before current-stream ingestion. Durable inbox cursors and prompt receipts remain authoritative; no path resubmits TraeX input. |
| Acceptance criteria and verification | Red-Green public-seam tests prove v2 read/subscribe use the compatible bounded page size and accept the measured valid response class, and prove a failing/backed-off older exact prompt cannot starve a newer correlated native turn's current-stream projection. Tests assert no prompt submission/replay and idempotent repeated observation. Run focused adapter/socket/observer tests, `npm run typecheck`, `npm run build`, then full `npm test` and delivery review. |
| Blocked by | T14 |

## Dependency map and execution order

```text
Core:   T1 -----------+
                       +--> T4 --------+
        T2 --> T3 ----+                |
                                        +--> T6 --> T7 --> T9 --+
Swarm:  T5 -----------------------------------------------------+--> T11
                                                                |
        T1 + T6 --> T8 ---------------------------> T9 ----------+
                                                                |
        T10 -----------------------------------------------------+
```

Safe parallelism exists only across isolated ticket ownership: T1, T2, T5, and T10 are initially unblocked. The default implementation order is T1, T2, T3, T4, T6, T7, T8, T9, with T5 and T10 scheduled at non-overlapping Swarm file boundaries, then T11. No ticket may copy uncommitted changes from the dirty original Core checkout.

## Final delivery checks

- [x] Every US1-US10 scenario and each no-replay, path-free, cursor, ring, outbox, lane, retry, and compatibility invariant maps to a passing test named in its responsible ticket.
- [x] Core and Swarm frozen contract fixtures agree and no v2 Swarm request/persistence contains a transcript path.
- [x] Accepted/uncertain native submissions never require JSONL or exact turn identity and never replay TraeX input.
- [x] Native Input Batch execution preserves literal user text while excluding generated display markers.
- [x] Both rings are bounded, non-authoritative, no-overwrite, restart-recoverable through their durable owner, and independently tested under saturation/crash/shutdown.
- [x] Full Core native checks and full Swarm tests/typecheck/build pass freshly; Windows cross-lint is either green or reported with exact current toolchain evidence.
- [ ] Dual Standards/Spec review finds no blocking issue.
- [ ] Both isolated worktrees have audited logs/statuses and no `Trae CLI co-author attribution` trailer in task commits.
- [x] No installation, restart, deployment, push, PR, main merge, or mutation of the original dirty worktrees occurred.
- [x] T15 bounded-page and independent-current-stream recovery regressions pass without TraeX replay.
