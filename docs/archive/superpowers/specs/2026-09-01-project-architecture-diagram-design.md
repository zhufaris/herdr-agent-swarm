# Project Architecture Diagram Design

## Goal and audience

Create a self-contained HTML and inline-SVG architecture diagram for engineers
taking ownership of Herdr Agent Swarm or diagnosing a production request. The
diagram must let a reader quickly answer three questions: where a request is
currently blocked, which system is authoritative for the disputed state, and
which recovery mechanism should converge it.

The artifact will be written to `docs/herdr-agent-swarm-architecture.html`. It
documents the current standalone service only; the retired compatibility plugin
is outside its scope.

## Chosen information architecture

Use a runtime-loop overview as the main diagram, supplemented by authority and
recovery annotations. This is more useful for the target audience than either a
pure source-directory diagram or a recovery-only state diagram: it preserves a
single end-to-end request path while retaining the facts needed during an
incident.

The main reading direction is left to right:

1. Lark message or CardKit action;
2. durable inbound acceptance in SQLite;
3. inbound routing and application workflows;
4. FIFO prompt execution through the Herdr adapter into a real Herdr pane and
   TraeX process;
5. transcript and runtime observation;
6. durable lifecycle result, conversation projection, and outbox intent;
7. ordered CardKit delivery back to Lark.

The central application area shows the important current seams without listing
every source file: `InboundRouter`, `PromptRunWorkflow`,
`HerdrRuntimeReconciler`, `ConversationViewProjector`, and
`LarkOutboxDispatcher`. A smaller domain strip beneath them communicates that
workflows depend on domain contracts and capability-focused ports. Adapters and
runtime mechanisms remain visually outside that core.

## Authority and durability model

Four authority callouts sit above the request loop:

- Herdr owns pane identity, terminal identity, foreground process, and agent
  runtime state.
- The exactly identified TraeX JSONL transcript owns typed active-turn output,
  status, plan, and token observations.
- SQLite owns bindings, inbound records, prompt FIFO, durable projections,
  outbox intent, audit data, and the fenced instance lease.
- User systemd owns the standalone service process lifecycle.

Lark is presented as the visible delivery surface, not a workflow authority. A
prominent note says that card text must never be used to repair SQLite and that
runtime disagreement converges through a fresh Herdr observation.

SQLite is expanded into six compact durable areas: inbound records,
topic-pane bindings, prompt FIFO and dispatch checkpoints, Run/Topic/Answer
views, Lark outbox and retry state, and the instance lease. This makes the
durable-before-delivery rule visible without turning the diagram into a table
schema.

## Flows and visual grammar

Solid directional lines represent persisted business flow or authoritative
observation. Orange dashed lines represent bounded, best-effort wake-up hints.
Rose dashed lines represent trust and control boundaries. A legend outside all
boundary boxes defines these meanings.

The diagram distinguishes two event roles:

- lifecycle outcomes feed deterministic conversation projections and durable
  outbound intent;
- socket events and work notifications only wake a consumer, which reloads
  authoritative state before acting.

The recovery loop is placed on the right side of the application boundary and
contains periodic Herdr reconciliation, detached-turn observation, startup view
convergence, and outbox retry/dead-letter handling. It reconnects to SQLite and
the Herdr observation path rather than bypassing either authority.

## Operational guidance

Three summary cards below the SVG provide a compact incident index:

1. **When state disagrees** — trust Herdr for panes/runtime, the exact transcript
   for active-turn output, SQLite for workflow intent, and systemd for process
   lifecycle.
2. **When a request is stuck** — correlate `eventId`, `bindingId`, `promptId`,
   `paneId`, or `replyId`; inspect inbound, prompt, projection, and outbox state;
   then compare against a fresh Herdr snapshot.
3. **Invariants to preserve** — one ordinary turn per binding, FIFO ordinary
   prompts, no automatic replay after uncertain dispatch, durable intent before
   Lark delivery, ordered CardKit streams, immutable frozen answer pages, and no
   remote high-risk approval.

The footer identifies `docs/architecture.md` and the current implementation as
the factual sources and labels the artifact as an engineer onboarding and
production diagnosis view.

## Presentation and interaction

Use the architecture-diagram dark visual system: a slate grid background,
semantic cyan/emerald/violet/orange/rose component colors, JetBrains Mono,
rounded opaque-backed component boxes, and arrows painted behind components.
The layout must remain legible without zooming at a typical desktop width and
must avoid crossings through labels.

The header includes the collapsed export menu required by the diagram template.
Copy, PNG, and PDF actions share the same high-DPI capture path. All CSS and SVG
are inline; only Google Fonts and the pinned, integrity-checked html2canvas and
jsPDF scripts are external. The page must still render as a complete diagram
when those external resources are unavailable; only font loading and export
actions may degrade.

## Verification

Verify the artifact structurally and visually:

- check that the HTML contains one inline SVG, no external images, the required
  report container, toolbar, pinned scripts, and three export functions;
- parse the document sufficiently to catch malformed HTML/SVG structure;
- serve or open it in a browser and inspect a screenshot at desktop width;
- confirm that labels do not overlap, connectors remain behind component boxes,
  and the legend is outside all architecture boundaries;
- compare every authority and request-flow claim against `docs/architecture.md`
  and the current module names under `src/`;
- run the repository documentation audit if it applies to standalone HTML
  artifacts.

## Acceptance criteria

- A new maintainer can trace one request from Lark acceptance through TraeX and
  back to durable CardKit delivery without consulting another diagram.
- A production operator can identify the authoritative system and next durable
  checkpoint for a stuck request.
- Wake-up hints cannot be mistaken for durable state or a second event log.
- Recovery paths do not imply prompt replay or Lark-driven state repair.
- The HTML opens directly in a modern browser, remains readable without export
  dependencies, and exports the complete dark-themed artifact when the pinned
  scripts are available.
