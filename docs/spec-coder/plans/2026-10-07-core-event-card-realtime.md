# Core Event Card Realtime Implementation Plan

Specification:
[`docs/spec-coder/specs/2026-10-07-core-event-card-realtime.md`](../specs/2026-10-07-core-event-card-realtime.md)

## Workspace and Baseline

- Swarm workspace:
  `/workspace/herdr-agent-swarm`, in-place on `main`, starting
  revision `1dc9df1cfd04364916593b6baa901204901d8772`.
- Approved specification commit: `d4a4f957`.
- Core workspace:
  `/workspace/herdr-core-conversation-activity-events`,
  branch `feat/core-conversation-activity-events`, starting revision
  `71432baa93b49a15707a9a05767a2f27697f4be4`.
- Preserve the three user-owned untracked Swarm files listed in the
  specification. `.tmp-build/` is task-created, ignored from every commit, and
  retained only for the isolated Zig/Cargo test toolchain until final cleanup.
- Swarm baseline: `npm test` passed 286 files and 4,056 tests.
- Core affected baseline: `cargo test --locked agent_events::` passed 73 tests.
  The complete Core suite compiles but its pre-existing host-sensitive CLI
  group stops on six Pi-vs-Codex detection failures; these remain explicit
  environmental debt and are not an allowed regression waiver for affected
  tests.
- Gate 1 design and Gate 2 specification were approved on 2026-10-07.
- Gate 3 implementation authorization is pending.

## Tickets

- [x] **T1: Accept and project canonical conversation-activity events in
  Swarm**

  **What to build:** Extend the Swarm Core-event adapter and persisted codec to
  accept `model_changed`, `context_compacted`, and optional
  `agent_activity.model`. Make future unknown additive payload variants skip at
  event granularity while preserving the trusted batch cursor. Project model,
  compact, and Subagent lifecycle/model facts into the mutable Conversation
  Segment and current Main/Turn views. Render the approved compact timeline
  labels without exposing source-private fields or changing frozen pages.

  **Spec references:** SCN-2, SCN-3, SCN-4, SCN-5; INV-3, INV-4, INV-5,
  INV-6, INV-7; Swarm Core-event adapter; Conversation projection and delivery;
  Compatibility and Migration.

  **Ownership and implementation path:** Conversation Projection owns visible
  model and timeline state. The Herdr adapter converts external snake-case JSON
  into source-neutral domain values; the Core event projector assigns stable
  timeline identities; the SQLite Conversation Segment transaction persists
  canonical positions and view revisions; pure card renderers display them.
  Unknown-event compatibility belongs only at the adapter boundary and may not
  reinterpret malformed known events.

  **Acceptance criteria and verification:** Red tests demonstrate all three
  payload forms currently fail or disappear. Green tests cover adapter and
  persisted-codec round trips, unknown-event isolation, model transition
  rendering, one stable Subagent row with model through terminal state,
  context-compaction placement, inactive/frozen behavior, Primary and Worker
  ownership, redaction, and restart round trip. Run affected Vitest files,
  `npm run typecheck`, `npm run architecture:check`, and `npm run build`.

  **Blocked by:** None.

- [x] **T2: Deliver Core event updates through an exact-owner low-latency path**

  **What to build:** Subscribe the existing Herdr socket to
  `session.events.available`, carry its bounded source identity separately from
  Pane/runtime hints, and let Core Session ingestion schedule the exact Primary
  or Worker owner. Unknown source mappings trigger one coalesced discovery pass.
  Immediately reschedule owners when an ingestion or observation page reports
  more work. Route Conversation Segment convergence through one keyed scheduler
  with immediate first/boundary updates and true 250ms trailing-edge burst
  coalescing.

  **Spec references:** SCN-1, SCN-5; INV-5, INV-6, INV-7, INV-8; Session
  ingestion; Conversation projection and delivery; Dependency Direction.

  **Ownership and implementation path:** Delivery and Operations owns volatile
  scheduling; Core inbox and Conversation Projection retain durable state.
  Extend the existing Herdr socket/event-router and ingestion interfaces instead
  of adding a second socket client or a persistent debounce table. The source
  map is bounded process state rebuilt by normal attach/reconciliation. The
  existing two-second scan remains fallback.

  **Acceptance criteria and verification:** Fake-clock Red-Green tests cover
  exact-source wake, concurrent duplicate coalescing, unknown-source fallback,
  `>8` observation continuation, Core batch continuation, `t=0/t=200/t=450`
  trailing-edge behavior, immediate pending/in-flight promotion, and distinct
  card-key independence. Integration tests prove SQLite commit precedes
  scheduling, restart recovers without a durable timer, Worker work uses the
  parent Pane Ring, and the deterministic normal-path budget is under one
  second. Run affected Vitest files plus the same Swarm gates as T1.

  **Blocked by:** T1.

- [x] **T3: Publish model, compaction, and model-aware Agent activity from
  Herdr Core**

  **What to build:** In the isolated Core worktree, extend `ReplyPayload` and
  the TraeX/Pi codecs with the approved source-neutral facts. Persist defaulted
  decoder state for model deduplication, occurrence identity, and bounded
  Subagent model inheritance. Preserve journal transaction, Event Ring,
  recovery, retention, and API schema-version behavior. Update only next-version
  generated API documentation required by the repository.

  **Spec references:** SCN-2, SCN-3, SCN-4, SCN-5; INV-1, INV-2, INV-3,
  INV-4, INV-8; Herdr Core adapter and event journal; Compatibility and
  Migration.

  **Ownership and implementation path:** Core owns source decoding, canonical
  payload meaning, stable identity and checkpoint state. TraeX and Pi formats
  remain adapter details. Event Journal commit atomically advances decoder state
  and stores emitted facts. No Swarm or Feishu type enters Core.

  **Acceptance criteria and verification:** Red-Green codec tests cover TraeX
  and Pi mapping, same-model suppression, `A -> B -> A`, consecutive compact,
  malformed/oversized values, safe compact payload, and Subagent model cache.
  Journal tests cover old-checkpoint restoration, commit retry, live/recovery
  event-ID equality, repeated occurrences and Ring snapshot restore. API tests
  cover new/old JSON shapes. Run `cargo test --locked agent_events::`, relevant
  API schema tests, formatting/checks supported by the isolated toolchain, and
  record the known unrelated full-suite environment failures separately.

  **Blocked by:** T1 supplies the compatible consumer contract. Core deployment
  remains blocked until the T1/T2 Swarm release is installed.

- [x] **T4: Remove the persistent Primary-tools warning from healthy Main
  Cards**

  **What to build:** Stop rendering the orange Primary-tools-unavailable
  callout on otherwise healthy Main Cards for directly created, discovered, or
  attached Herdr Panes. Preserve the stored generation-scoped capability fact,
  provisioning behavior, Primary tool gateway authorization, and contextual
  operation failure guidance. Do not issue capabilities, reset, replace, or
  restart a Pane as part of this presentation change.

  **Spec references:** SCN-7; INV-9; Primary capability presentation; Out of
  Scope.

  **Ownership and implementation path:** Conversation Projection may retain
  capability diagnostics for operator and authorization use. The pure Main
  Card renderer owns omission of the persistent warning. The Primary tool
  gateway and capability store remain authoritative and unchanged.

  **Acceptance criteria and verification:** A Red-Green card test proves a
  healthy direct/attached Pane with `primaryToolsAvailable=false` no longer
  renders the warning or reset/replace advice. Existing integration tests prove
  the state remains false, and a tool-gateway test proves an invalid or missing
  capability is still rejected. Run affected card, attachment/provisioning and
  Primary-tool tests plus typecheck, architecture check, and build.

  **Blocked by:** None.

- [ ] **T5: Roll out consumer first and prove live Feishu behavior**

  **What to build:** Install and restart the completed Swarm release first;
  verify readiness, zero new event-decode gaps, and healthy Delivery Rings.
  Then install/restart the completed Core release using its supported handoff
  path and verify the same live Pane sessions remain attached. Exercise a long
  turn with multiple complete Assistant events, a model transition, context
  compaction, and Subagent lifecycle. Finally create a new Swarm-managed TraeX
  Primary to verify global Choice Hook availability and Answer-card ACK before
  exactly one mention.

  **Spec references:** All scenarios and invariants; Compatibility and
  Migration; Choice Hook availability.

  **Ownership and implementation path:** Swarm lifecycle commands own its
  release activation; Core's supported build/install/handoff owns its binary
  activation; SQLite and Core Event Ring evidence, not visible card text alone,
  establish correctness. Existing active TraeX processes are preserved. The
  Choice test uses `/swarm new ... --agent traex` because only a new process can
  load the globally installed Hook.

  **Acceptance criteria and verification:** Confirm deployed build identities
  and ready state; ordinary committed events appear within one second; burst
  updates converge without duplicate or regressing revisions; boundary events
  flush immediately; model/compact/Subagent items render correctly; retries do
  not replay Agent Input; Choice Specification count is one, Action Set is
  available, card ACK precedes one mention, and repeated convergence creates no
  duplicate. No production data is deleted.

  **Blocked by:** T2, T3, and T4.

  **Deployment repair checkpoint (2026-10-07):** The first consumer-first
  rollout exposed two compatibility hazards before live acceptance. Swarm now
  runs the existing safe supersession predicate before claiming a Ring head, so
  a never-attempted replaceable snapshot can advance directly to its newest
  durable successor instead of replaying every historical revision. Core now
  emits `agent-v2:<native-event-id>` identities whenever `agent_activity`
  includes explicit or checkpoint-restored model metadata, while model-less
  legacy activity retains `agent:<native-event-id>`. Both repairs have focused
  Red-Green coverage. The live retry also exposed duplicate retained Ring
  events being projected again after their lane items had already settled;
  settled, unchanged events now advance the source cursor without re-entering
  Conversation Projection, while pending/quarantined work and changed canonical
  Human submission evidence still replay. Deployment and live Feishu acceptance
  remain part of T5.

## Final Delivery Checks

- Review both repositories against the approved specification and dependency
  rules.
- Verify every ticket-owned commit contains no unrelated paths and no AI
  co-author trailer.
- Run the complete Swarm suite, typecheck, build, architecture check,
  documentation audit, public audit, and diff check.
- Run Core affected tests and `just check` in an environment that satisfies the
  repository's Zig and Agent-detection requirements; if the six known baseline
  CLI failures remain, demonstrate that their exact signatures are unchanged
  and that every affected event/API test is green.
- Verify consumer-first deployment and live CardKit order from durable Core,
  SQLite, Prepared Delivery and Ring evidence.
- Preserve the three pre-existing user-owned untracked files, remove only the
  task-created `.tmp-build/` artifacts after verification, and do not push or
  open a pull request without separate authorization.
