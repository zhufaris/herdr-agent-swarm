# Herdr Lark Bridge Engineering Architecture Document Design

## Decision

Replace `docs/system-architecture.html` in full. The deliverable is a formal engineering architecture and design document packaged as one directly openable HTML file. It is not a landing page, product tour, simulated dashboard, or architecture “atlas.” The current HTML layout, content hierarchy, and interaction model are not retained as a design foundation.

The document combines C4-style system decomposition with implementation-level diagrams for workflows, persistence, delivery lanes, recovery, and operations. Every diagram must answer four questions: what participates, what crosses each edge, who owns the resulting state, and what happens when the edge fails.

## Deliverable and constraints

- Deliver exactly one reader-facing artifact: `docs/system-architecture.html`.
- Embed all HTML, CSS, SVG, diagrams, and JavaScript in that file.
- Open correctly from `file://` with no build step and no network access.
- Use no third-party libraries, remote fonts, external images, analytics, or live service calls.
- Do not expose credentials, configured tenant identifiers, live database paths, or environment values.
- Do not change application source files or generated `dist/` files.
- Render as a linear, complete engineering document without JavaScript; JavaScript may add navigation, diagram inspection, and view controls.
- Preserve keyboard access, visible focus, reduced motion, mobile readability, and a useful print layout.

## Audience

The document is written for engineers changing the bridge, reviewers validating a design, and operators diagnosing failures. It assumes general distributed-systems knowledge but no prior knowledge of this repository.

After reading it, a new engineer must be able to explain:

1. why the bridge is a durable coordinator rather than a relay;
2. which system owns runtime, workflow, presentation, and process-lifecycle truth;
3. how concrete modules are composed and communicate;
4. how an inbound message becomes a TraeX turn and then Lark projections;
5. how prompt FIFO differs from steering;
6. how outbound lane keys are derived and scheduled;
7. why failure in one lane does not block independent lanes;
8. why uncertain TraeX work is observed rather than replayed;
9. how startup, reconciliation, delivery recovery, and shutdown converge;
10. where a proposed code change belongs and which invariants it may affect.

## Document structure

### 1. Executive summary

State the system purpose, its durable-coordinator model, the one-topic-to-one-pane binding, and the central safety property: workflow intent is persisted before fallible effects, while live process truth is re-observed from Herdr. Include a compact metadata block for runtime, persistence, delivery surface, service owner, and source authority.

### 2. Goals and non-goals

Goals include durable inbound acceptance, per-binding serialization, explicit steering, observable TraeX execution, deterministic card projection, ordered delivery, restart convergence, and bounded operational diagnostics.

Non-goals include remote high-risk approval, treating Lark cards as workflow truth, replaying uncertain prompts, using in-memory events as a durable ledger, exposing the health server publicly, and acting as a generic multi-agent scheduler.

### 3. System context diagram

Show the human user, Lark platform, bridge service, SQLite database, Herdr workspace/pane, TraeX process, user systemd, and Herdr plugin. Label every edge with protocol or interaction:

- user ↔ Lark: topic messages and card actions;
- Lark → bridge: long-connection events;
- bridge → Lark: CardKit API;
- bridge ↔ SQLite: transactional state and lease;
- bridge → Herdr: CLI commands and targeted observation;
- Herdr → bridge: snapshots, socket hints, and plugin event hints;
- Herdr pane → TraeX: native agent prompt/control;
- systemd → bridge: process lifecycle;
- plugin → systemd/bridge: supported operator actions.

Visually distinguish synchronous calls, asynchronous hints, durable writes, and process ownership. Place source-of-truth ownership directly on the relevant system boundaries.

### 4. Container and component architecture

Show the actual layers and dependency direction:

- composition root: `src/main.ts`;
- boundary adapters and infrastructure;
- application coordinators;
- event, scheduling, projection, and delivery components;
- domain types, ports, lifecycle transitions, reducers, and planners;
- SQLite implementation of capability-focused store ports;
- pure CardKit renderers and health reporting.

The component diagram must include concrete production modules rather than directory-only boxes: `LarkSdkAdapter`, `HerdrCliAdapter`, `InboundRouter`, `BindingProvisioningWorkflow`, `PromptRunWorkflow`, `TurnSupervisor`, `HerdrRuntimeReconciler`, `CardInteractionWorkflow`, pane/session/model workflows, `BridgeEventBus`, `PromptWorkScheduler`, `ConversationViewProjector`, `AnswerPageWorkflow`, `MainCardWorkflow`, `OutboundIntentWriter`, `LarkOutboxDispatcher`, `SqliteBindingStore`, runtime resilience components, and `startHealthServer`.

Edges must name the exchanged contract: normalized inbound event, capability port call, prompt work hint, lifecycle event, projection state, outbound intent, delivery checkpoint, or runtime observation.

### 5. Composition and module responsibility map

Explain how `main.ts` constructs concrete implementations, injects narrow ports into workflows, connects dispatcher checkpoints back to schedulers/card convergence, takes the fenced lease, starts diagnostics, and owns graceful shutdown.

Provide a source-code map table with module, responsibility, inputs, outputs, durable effects, principal collaborators, and source path. Clicking a diagram component may focus the matching table row, but the complete table must be visible in static and print modes.

### 6. Inbound request sequence

Provide a sequence diagram from Lark event through normalization, durable inbound recording, routing, prompt acceptance, scheduler wake, durable claim, Herdr prompt submission, observation, lifecycle event, projection, outbox reservation, and Lark delivery.

Mark transaction boundaries and the irreversible prompt-dispatch boundary. Explain that the event bus and notifier are low-latency hints; durable scans recover lost hints.

### 7. Prompt scheduling and steering

Show a per-binding ordinary prompt FIFO and a separate explicit steering path:

- at most one ordinary active turn per binding;
- later ordinary prompts remain queued in creation order;
- ordinary text is never auto-promoted to steering;
- `/swarm steer` targets a captured active parent and bypasses ordinary FIFO;
- `/swarm stop` is a local pane control, not a prompt job;
- stale binding generation or parent identity prevents misdirected control;
- uncertain dispatch changes observation handling, not prompt eligibility for replay.

### 8. Outbound lane architecture

This is a primary engineering diagram, not a footnote. Show the complete producer-to-consumer path:

`workflow/projector → transactional SQLite enqueue → OutboundWorkNotifier hint → LarkOutboxDispatcher scan → outbox_lane_heads → bounded parallel handlers → LarkPort → transactional delivery checkpoint → checkpoint subscribers`

Document the exact lane-key rules from `src/store/outbox-lanes.ts`:

1. `card_role = answer` and `prompt_id != null` → `answer:<promptId>`;
2. otherwise `stream_content` or `stream_finish` → `stream:<rootMessageId>`;
3. otherwise → `message:<rootMessageId>`.

Show at least three simultaneous lanes and multiple rows in each lane. Explain:

- every row receives durable `delivery_order`;
- `outbox_lane_heads` exposes only the earliest pending row in each non-quarantined lane;
- only one row per lane can be in a dispatcher batch;
- the dispatcher runs at most four independent lane handlers concurrently;
- delivery or dismissal advances that lane's head;
- a future-due or failed head blocks only its own lane;
- retry scheduling uses the earliest due lane head;
- `stream_card_create`, `stream_content`, `stream_finish`, `card_update`, `card_reply`, and `text` have different Lark effects and checkpoints.

Include a failure branch showing transient backoff, permanent/exhausted dead letter, lane classification, quarantine, and recovery action. Explain all lane classes:

- `answer_stream`;
- `main_card`;
- `replaceable_card`;
- `immutable`.

For Answer stream failure, later unsafe content/finish rows cannot skip the failed head. Recovery uses canonical `RunCardView` content, page source offsets, and sequence state. For replaceable snapshots, only a newer durable view may advance. Immutable work remains blocked until explicit retry or dismissal.

Show checkpoint feedback:

- successful Answer card creation/content/finish notifies Answer convergence;
- successful main-card delivery advances `deliveredVersion`;
- successful task/Answer card creation may wake the prompt scheduler once the required visible target exists;
- delivery retry never invokes TraeX.

### 9. Persistence model and transaction boundaries

Document conceptual aggregates and the actual durable relationships among project selection, binding, prompt job, control/interaction records, run-card view, topic view, Answer page, outbound reply, lane head, lane quarantine, audit, and instance lease.

Do not invent exact column-level ER semantics unnecessarily. Do name the fields required to explain correctness: binding generation, prompt dispatch kind and observation state, view/delivered version, page index/source start/sequence/state, idempotency key, lane key, delivery order, retry timestamp, failure class, and fencing token.

Call out atomic transitions that couple workflow state, projection changes, Answer-page reservation, and outbox intent.

### 10. State machines

Include explicit state diagrams for:

- binding lifecycle and attachment;
- provisioning checkpoints;
- prompt state plus orthogonal observation state;
- pane-control operations;
- Answer page state;
- outbound reply and lane quarantine state.

Each transition must name its trigger and explain whether it is reversible, retryable, or terminal.

### 11. Reconciliation and recovery

Contrast the hint path and convergence path. Document startup order, lease fencing, integrity audit, inbound recovery, view convergence, pane-control recovery, delivery recovery, fresh Herdr observation, scheduler scans, and activation of live event subscriptions.

Include failure narratives for bridge termination during prompt submission, bridge termination during observation, missing/replaced pane, missed Herdr event, failed CardKit target, stale stream operation, database integrity failure, and lease loss.

### 12. Answer projection and pagination

Explain canonical Answer content, sanitized runtime observations, Answer page source offsets, ordered element sequence, active/frozen/finished pages, continuation creation, delivery checkpointing, and restart reconstruction. Explicitly state that frozen pages are immutable and rendering transformations do not rewrite canonical offsets.

### 13. Operations, health, and security

Differentiate `/health`, `/ready`, and `/status`. Describe structured correlation identifiers, build identity, circuit breaker, snapshot cache, integrity diagnostics, outbox backlog/quarantine signals, retention, and bounded shutdown.

Document security boundaries: configured-chat/user allowlists, project registry validation, command argument redaction, terminal sanitization, credential redaction, loopback-only health/event listeners, and local-only high-risk approval.

### 14. Failure matrix and architectural invariants

Provide a matrix with failure, authoritative evidence, durable response, retry owner, user-visible effect, and prohibited recovery. Close with the non-negotiable invariants from `AGENTS.md` and `docs/architecture.md`.

## Visual and interaction design

Use a restrained engineering-document aesthetic: light drafting-paper background, dark ink, one cyan interaction accent, amber durable-state accent, red failure accent, fine grid/rule lines, compact captions, and high-density but readable diagrams. Avoid oversized marketing typography, decorative hero sections, glass panels, fake live indicators, and dashboard simulation.

The desktop layout uses a narrow table-of-contents rail and a wide document column. Diagrams may use their full column width. Dense diagrams expose a `Fit / 100%` control and a dedicated horizontal pan area rather than shrinking labels until unreadable. Mobile uses a compact top navigation and horizontally scrollable diagram canvases. Print removes controls, expands details, preserves diagram legends, and uses page-break-aware sections.

Allowed interactions are documentation-oriented:

- table-of-contents section tracking;
- diagram zoom-to-fit and 100% controls;
- node selection that focuses the corresponding responsibility detail;
- lane scenario toggles for normal, retry, and quarantine states;
- collapse/expand for supporting details;
- module table search.

No timed autoplay, animated storytelling, fake telemetry, or simulated live status is included.

## Source authority

The implementation must be checked against current source, principally:

- `docs/architecture.md`;
- `docs/feishu-group-usage.md`;
- `src/main.ts`;
- `src/store/outbox-lanes.ts`;
- `src/store/sqlite-store.ts`;
- `src/events/lark-outbox-dispatcher.ts`;
- `src/events/outbound-intent-writer.ts`;
- `src/events/conversation-view-projector.ts`;
- `src/events/prompt-work-scheduler.ts`;
- `src/coordinator/prompt-run-workflow.ts`;
- `src/coordinator/herdr-runtime-reconciler.ts`;
- `src/coordinator/answer-page-workflow.ts`;
- `src/coordinator/main-card-workflow.ts`;
- `src/domain/ports.ts`, `types.ts`, and view reducers/planners.

Historical design files are context only and never override current source or `docs/architecture.md`.

## Validation

1. Confirm one self-contained HTML file with no external resources or network calls.
2. Check unique IDs, internal links, semantic landmarks, accessible control names, and static readability without JavaScript.
3. Verify every required diagram, module, state machine, lane rule, failure class, and architectural invariant is present.
4. Exercise table-of-contents tracking, diagram controls, node-to-module focus, lane scenarios, search, and disclosures in Chromium.
5. Inspect desktop, narrow mobile, reduced-motion, and print rendering.
6. Cross-check every lane rule and recovery statement against current source.
7. Confirm no application source or unrelated worktree file was changed.
