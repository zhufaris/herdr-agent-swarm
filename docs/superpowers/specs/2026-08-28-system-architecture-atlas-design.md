# Herdr Lark Bridge Interactive Architecture Atlas Design

## Purpose

Create one self-contained interactive HTML document that lets engineers, operators, and reviewers understand Herdr Lark Bridge without first reading the entire repository. The page must explain both the static module architecture and the dynamic behavior of a request, including persistence, scheduling, reconciliation, recovery, and Lark delivery.

The artifact will live at `docs/system-architecture.html`. It must open directly from disk, require no build step or network connection, and keep all CSS, SVG, content, and JavaScript in the same file.

## Audience and success criteria

The primary audiences are:

- engineers learning where a change belongs;
- operators diagnosing a live or recovering bridge;
- reviewers checking that a change preserves durability and safety boundaries.

The page succeeds when a reader can use it to answer these questions:

1. Which system owns each kind of truth?
2. What happens from a Lark message to a completed Answer Card?
3. Which source modules participate at each stage?
4. Where are durable checkpoints and retry boundaries?
5. How do ordinary turns, steering, restarts, and delivery retries differ?
6. Why do wake-up events not replace reconciliation?
7. How do health, readiness, leases, outbox state, and quarantines affect operations?

## Chosen experience

The page is an **Interactive Architecture Atlas** with the narrative playback of an architecture storyboard. It uses an industrial control-room visual language: deep ink background, warm paper text, cyan signal paths, amber durable boundaries, green healthy states, and coral fault states. Fine grid lines, restrained glow, and compact technical labels make it feel like an instrument built for this system rather than a generic dashboard.

The experience has three persistent regions on wide screens:

- a left rail for section navigation and scenario selection;
- a central canvas for the current architecture, timeline, or state view;
- a right inspector for contextual details about the selected module or step.

On narrow screens the rail becomes a horizontal section selector and the inspector becomes an inline expandable panel. The content remains fully usable with keyboard navigation and reduced-motion preferences.

## Information architecture

### 1. Orientation

The opening section states the bridge's role in one sentence: it is a durable workflow coordinator connecting Lark topics to TraeX processes running in real Herdr panes. A compact system boundary diagram introduces Lark, the bridge process, SQLite, Herdr, TraeX, and user systemd.

A source-of-truth matrix makes ownership explicit:

| Concern | Authority | Bridge behavior |
| --- | --- | --- |
| Pane, terminal, foreground process, agent state | Herdr | Observe and reconcile from a fresh snapshot |
| Binding lifecycle, prompt FIFO, projections, outbox, audit, lease | SQLite | Persist before effects and transition atomically |
| Visible cards and messages | Lark | Treat as delivery surfaces, never workflow truth |
| Service process lifecycle | user systemd | Start, stop, restart, and report process state |

### 2. Request journey

The central diagram presents the canonical path:

`Lark message or card action → Lark adapter → InboundRouter → SQLite acceptance → PromptWorkScheduler → PromptRunWorkflow → Herdr and TraeX → lifecycle events → ConversationViewProjector → SQLite outbox → LarkOutboxDispatcher → Lark cards`

Users can play, pause, restart, or step through the flow. Only one step is active at a time. The active edge animates, relevant modules brighten, and the inspector explains:

- what enters the step;
- what it decides or transforms;
- which durable record changes;
- what can fail;
- how retry or reconciliation proceeds;
- which source files implement the behavior.

Durable checkpoints use amber markers. Side effects use cyan markers. Uncertain dispatch is called out explicitly: once a prompt may have reached TraeX, it is observed again and never automatically replayed.

### 3. Scenario laboratory

The same diagram supports four scenario lenses:

- **Normal turn:** durable acceptance, FIFO scheduling, one active ordinary turn per binding, observation, projection, and delivery.
- **Steering:** an eligible message targets the active turn instead of becoming another ordinary concurrent turn.
- **Restart recovery:** startup restores projections, detaches uncertain observers safely, snapshots Herdr, and converges without replaying a possibly dispatched prompt.
- **Delivery retry:** an already-persisted outbox intent is retried or dead-lettered without repeating the TraeX work.

Changing scenario updates the numbered path, explanation, failure notes, and highlighted persistence boundaries. Scenario controls do not simulate live service state; they are deterministic educational views backed by data embedded in the page.

### 4. Module atlas

The module explorer groups source code by architectural role:

- `src/main.ts`: composition root and lifecycle wiring;
- `src/adapters/`: Herdr CLI and Lark SDK normalization;
- `src/coordinator/`: inbound, provisioning, prompt, steering, reconciliation, cards, and operational workflows;
- `src/domain/`: ports, commands, events, lifecycle rules, types, and deterministic view planning;
- `src/events/`: event bus, projectors, schedulers, and outbox dispatch;
- `src/runtime/`: parsing, streams, event hints, caches, lease, shutdown, integrity, and bounded operational mechanics;
- `src/store/`: SQLite schema, records, transactions, queues, projections, and outbox lanes;
- `src/cards/`: pure CardKit rendering;
- `src/health/`: loopback health, readiness, and status reporting.

Each clickable module card exposes its responsibility, important collaborators, source path, and the scenarios in which it participates. A search field matches module names, paths, responsibilities, and concepts such as `lease`, `steering`, `outbox`, or `reconcile`. Category chips filter without hiding the current selection unexpectedly.

### 5. Durable state and state machines

This section explains SQLite as the workflow memory rather than a passive cache. It visualizes the relationships among projects, bindings, inbound records, prompts, answer pages, main-card projections, outbox items, audit records, and the instance lease at a conceptual level. It avoids inventing literal table or column names where the page does not need them.

Three small state views cover:

- prompt lifecycle from queued through active observation to a terminal or recoverable state;
- outbox lifecycle from pending through delivery, retry, or dead letter;
- Answer pagination from active page to frozen immutable page and continuation page.

The views emphasize transitions and invariants rather than presenting a misleading database administration diagram.

### 6. Reconciliation and recovery

A split timeline contrasts fast hints with authoritative convergence:

- Herdr socket/plugin events invalidate caches and wake reconciliation;
- `SessionReconciler` or the current runtime reconciler path takes a fresh Herdr snapshot;
- observed runtime truth is compared with durable SQLite intent;
- bridge events update projections and enqueue delivery intent.

Recovery callouts cover startup, shutdown detachment, stale events, uncertain dispatch, missing visible cards, and failed Lark delivery. The copy must never imply that card text is authoritative or that a prompt is replayed to repair display state.

### 7. Operations and safety

An operations panel distinguishes `/health`, `/ready`, and `/status`:

- health means the process responds;
- readiness requires the lease, configured projects, Herdr, and Lark to be usable;
- status explains degraded components and durable backlog or quarantine signals.

It also explains build identity, fenced instance lease, SQLite integrity audit, bounded logs, correlation identifiers, outbox retention, and graceful shutdown. The final invariant wall summarizes:

- one ordinary active turn per binding;
- FIFO for later ordinary work;
- steering is explicit;
- never replay uncertain TraeX dispatch;
- persist delivery intent before sending to Lark;
- preserve ordered CardKit stream sequence;
- frozen Answer pages are immutable;
- high-risk approval remains local to Herdr.

## Interaction design

All controls use semantic HTML buttons, links, inputs, and landmarks. The page provides:

- sticky section navigation with active-section tracking;
- scenario tabs and play/pause/previous/next controls;
- selectable SVG or HTML diagram nodes with keyboard focus;
- a contextual inspector that updates without navigation;
- module search and category filters;
- expandable definitions for bridge-specific terminology;
- a reduced-motion mode derived from `prefers-reduced-motion`;
- a print stylesheet that expands essential details and removes controls.

JavaScript progressively enhances the document. Core explanations remain present and readable if scripting is unavailable. Deep-link hashes identify major sections, but the page does not require routing or local storage.

## Content model and implementation boundary

The HTML contains small JavaScript data structures for modules and scenarios. Rendering functions derive diagram highlighting, inspector content, search results, and step counters from this data. Content is not duplicated across hidden DOM fragments.

The artifact must not:

- import fonts, libraries, icons, analytics, or remote assets;
- call the live bridge, Lark, Herdr, or SQLite;
- expose secrets, live IDs, database paths, or environment values;
- claim to be a live operations dashboard;
- depend on generated `dist/` output or a documentation build system.

Icons and diagrams use inline SVG. Typography uses a deliberate local font stack with a condensed technical display face fallback and a readable serif/sans body pairing.

## Accuracy sources

The implementation must derive behavior from these current repository sources:

- `docs/architecture.md` for durability, authority boundaries, lifecycle, and recovery;
- `docs/feishu-group-usage.md` for user-visible commands and interaction behavior;
- `src/main.ts` for actual composition and startup wiring;
- the relevant `src/adapters`, `src/coordinator`, `src/domain`, `src/events`, `src/runtime`, `src/store`, `src/cards`, and `src/health` entry points for module descriptions.

Historical design documents are not behavioral authority. The implementation must avoid overwriting or incorporating unrelated uncommitted CardKit and recovery work.

## Validation

Validation is proportional to a static documentation artifact:

1. Confirm exactly one HTML artifact contains no external `src`, stylesheet, font, or network dependencies.
2. Parse the file with an available local HTML parser or browser engine and check for duplicate IDs and unresolved internal section links.
3. Exercise scenario stepping, play/pause, module selection, search, filters, and keyboard focus using a local browser automation tool when available.
4. Check responsive layouts at desktop and mobile widths and verify reduced-motion behavior.
5. Compare page statements against `docs/architecture.md` and `src/main.ts`.
6. Run the repository's existing documentation-neutral typecheck or build only if implementation work does not overlap ongoing source changes; the HTML itself must require neither command.

## Deliverable

One new implementation artifact: `docs/system-architecture.html`. The design and implementation-plan documents remain separate process records; the user-facing architecture experience itself is a single portable HTML file.
