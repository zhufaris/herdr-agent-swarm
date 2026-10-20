# Multi-Agent Session Activity Compatibility

## Problem Statement

The current Primary session can create and control child agents through the
structured `multi_agent_v1` tool family, but those children do not appear in
the Feishu `Subagents` section.

Production evidence from native session
`01a124cc-6b1e-73f1-99e6-1625782edd5e` shows successful
`multi_agent_v1__spawn_agent` calls and results containing stable `agent_id`
and `nickname` values. Wait and close calls also carry structured target and
status data. Core persists these records as ordinary `tool_call` and
`tool_result` events. It does not emit `agent_activity`,
`sub_agent_activity`, or `collab_close_end` for this protocol. Consequently,
the matching SQLite Session Activity scope contains Tool items but no Agent
items, and the pure card renderer correctly omits the empty `Subagents`
section.

This is a compatibility gap between a new external multi-agent tool protocol
and the existing Session Activity projection. It is not a Herdr Pane-session
identity problem, a CardKit rendering defect, or a stale-card problem.

## Solution

Add a strict Swarm-side translation at the structured Core-event projection
boundary. For a bounded allowlist of `multi_agent_v1` tools, correlate an exact
`tool_call` and `tool_result` by Agent session and `call_id`, validate their
JSON shapes, and derive internal Subagent lifecycle mutations keyed by the
returned or targeted `agent_id`.

The existing Session Activity store remains the authority for the latest
visible Subagent state. It applies the derived mutations using its current
identity fences, metadata preservation, terminal monotonicity, bounded item
rules, presentation fingerprint, and card invalidation path. The original Tool
events continue through the Answer Timeline unchanged.

The same translator supports a bounded reconciliation pass over retained
Core inbox evidence for the active Primary session. This recovers sessions
whose multi-agent Tool events were durably ingested before this compatibility
projection existed, without rewinding a Core checkpoint, manufacturing a
canonical Core event, or repeating Tool history.

## User Stories

### SCN-1: A successful spawn becomes visible

Given an exact `multi_agent_v1__spawn_agent` call and successful result in one
active Primary Agent session, when the result supplies a nonempty stable
`agent_id` and `nickname`, Session Activity creates or updates one Agent item.
The Feishu card displays that child under `Subagents` in the `started` state.

### SCN-2: Structured wait evidence advances lifecycle

When a correlated `multi_agent_v1__wait_agent` result reports a target in its
structured pending execution state, the same Agent item advances to the
corresponding nonterminal state. Queue/local-capacity/provider-queue evidence
maps to `started`, active model execution maps to `running`, and explicit
approval/dependency waiting maps to `blocked`. A structured terminal status
maps to the corresponding completed or failed terminal state.

### SCN-3: Close converges the targeted child

When a correlated `multi_agent_v1__close_agent` result identifies its target
through the exact call arguments, a previously completed or failed status
remains that terminal outcome. Closing an otherwise active child produces
`interrupted`. The transition targets only that stable `agent_id`.

### SCN-4: Tool history and Subagent state remain distinct

Every supported multi-agent call and result retains its existing Tool
projection in the Answer Timeline. The compatibility translation additionally
updates only the latest Subagent state in Session Activity. It does not hide,
replace, or duplicate Tool history.

### SCN-5: Malformed or ambiguous evidence fails closed

An unknown tool name, truncated call or result, malformed JSON, missing
`agent_id`, missing exact call correlation, unsupported status, or conflicting
identity creates no Agent mutation. Existing Session Activity remains
unchanged and ordinary Tool projection continues.

### SCN-6: Duplicate and out-of-order evidence converges

Repeated results and repeated reconciliation converge on one item per
`agent_id`. A terminal Agent item cannot regress to queue, running, or blocked
from older or later nonterminal evidence. Missing optional name or model does
not erase previously known metadata.

### SCN-7: Retained historical evidence is recovered

Given an active Primary session with retained, already settled multi-agent Tool
pairs but no Agent items, startup or ordinary bounded convergence reconstructs
the latest supported state and schedules a card update only when the visible
Session Activity fingerprint changes. Repeating recovery produces no new item,
Core replay, Agent input, or redundant card delivery.

## Implementation Decisions

### Domain Model

The affected contexts are Core Event Ingestion and Conversation Projection.
The external `multi_agent_v1` protocol belongs to the ingestion adapter. The
internal **Subagent lifecycle mutation** belongs to Conversation Projection
and contains only stable identity and bounded presentation facts:

- `agentId`;
- optional `displayName` and `model`;
- one supported lifecycle state;
- terminality;
- exact source event and lane position used for convergence.

These Subagents are TraeX collaboration children. They are not Swarm Worker
Runtime instances and do not change Worker generations, Worker Threads, or
Worker Task ownership.

INV-1: Only exact, schema-valid, correlated structured Tool evidence from the
supported `multi_agent_v1` allowlist may create a compatibility lifecycle
mutation. UI messages, Pane text, task prompts, assistant prose, tool-result
prose, timing, and parent Turn completion are not lifecycle evidence.

INV-2: Agent identity is the stable `agent_id` returned by spawn or named as an
exact tool target. Nicknames and models are presentation metadata, never
identity.

INV-3: A terminal Agent item is monotonic and cannot regress from later
nonterminal compatibility evidence. Omitted optional metadata preserves the
last known nonempty values.

INV-4: Tool events remain Answer Timeline facts. Compatibility-derived Agent
mutations remain Session Activity facts. Deriving the latter never suppresses
the former.

INV-5: Reconciliation consumes only retained durable Core inbox evidence for
the exact active owner/session fence. It does not alter canonical Core event
identity, lane checkpoints, or settlement state.

No new business aggregate is introduced. The existing Session Activity
snapshot/item consistency boundary and active Binding/session fence remain
authoritative.

### Architecture

ARCH-1: Introduce one deep external-protocol translation module with a small
interface that accepts a correlated Tool call/result pair and returns zero or
more bounded Subagent lifecycle mutations. The module owns the exact tool-name
allowlist, Zod validation, external-to-internal state mapping, truncation and
unknown-version rejection, and removal of all task/result content.

ARCH-2: Correlation uses the same Agent kind, native session ID, and `call_id`.
The call must precede the result and be the unique matching retained call. The
translator never correlates across sessions or by tool name, timestamp, text,
or array position.

ARCH-3: Supported behavior is deliberately narrow:

- successful `multi_agent_v1__spawn_agent` result: create `started` using the
  result's `agent_id` and `nickname`, plus a bounded model from call arguments
  when supplied;
- `multi_agent_v1__wait_agent`: use exact targets from call arguments and
  structured `pending.items` or terminal `status` entries;
- `multi_agent_v1__close_agent`: use the exact call target and structured
  `previous_status` to retain completed/failed or mark active work
  `interrupted`;
- `send_input`, inspect, list, resume, steer, and unknown tools produce no
  lifecycle mutation unless a later approved protocol revision defines one.

ARCH-4: The Session Activity store applies derived mutations through one
internal method that reuses the existing Agent-item upsert semantics,
generation/session fencing, source sequence comparison, label preservation,
terminal monotonicity, pruning, presentation fingerprint, and card projection.
Renderers receive only the existing `SessionActivityView` and remain unaware
of `multi_agent_v1`.

ARCH-5: The live path derives compatibility mutations while projecting the
correlated Tool result. The recovery path queries a bounded ordered set of
retained Tool pairs for only the current active Primary session, runs the same
pure translator, reduces to the latest per-agent mutations, and applies them
idempotently. Recovery does not call the Agent or Lark directly; ordinary view
invalidation and outbox delivery remain responsible for visible updates.

ARCH-6: Source dependencies point inward. External JSON schemas and tool names
stay in the adapter/translation module; its output is a simple internal data
shape consumed by the SQLite projection implementation. Domain display types
and card renderers do not import Host protocol schemas.

### Behavior & Failure Modes

- A successful spawn result is the first authoritative point at which the
  stable child ID exists; the call alone does not create a placeholder Agent.
- A result marked `is_error`, a truncated record, invalid JSON, oversized
  bounded fields, or a mismatched target is ignored for compatibility
  lifecycle purposes.
- Queue-like pending phases remain `started`; model execution is `running`;
  explicit approval or dependency waits are `blocked`. Unknown phases retain
  the current state rather than guessing.
- A close result with structured completed or failed previous status retains
  that outcome. A successful close of nonterminal work becomes `interrupted`.
- Multiple agents in one wait result update independently by stable ID.
- Session Activity's current terminal guard resolves stale nonterminal
  evidence. Exact source lane sequence and source event ID preserve duplicate
  and ordering behavior.
- Recovery is bounded by configured/internal batch limits. When retained
  evidence is incomplete, it projects only fully correlated pairs and can retry
  later without partial invented states.
- Visible fingerprint equality suppresses redundant Main/Answer Card work.

### Compatibility & Migration

No SQLite schema or public Core-event schema change is required. Existing
`agent_activity` remains preferred canonical evidence and continues through
the current projection path. Compatibility-derived evidence updates the same
stable Agent item and obeys terminal monotonicity, so the two sources converge
rather than create parallel rows.

Historical rows and cards remain valid. Recent active sessions can be rebuilt
from retained Core inbox Tool evidence. Compacted or no-longer-retained Tool
payloads are not guessed or reconstructed. No direct production SQLite edit or
bulk historical backfill is performed.

This design revises the earlier assumption that Session Activity consumes only
canonical `agent_activity`. It permits an adapter-owned compatibility
translation for the exact `multi_agent_v1` structured protocol while retaining
the prohibition on lifecycle inference from messages and arbitrary Tool prose.

## Testing Decisions

- **Protocol translator:** use production-shaped fixtures captured from the
  current session for spawn, wait, and close. Prove exact state mapping,
  multi-target wait handling, bounds, malformed/truncated rejection, unknown
  tool/phase rejection, and absence of task/result content in output.
- **Live projection:** ingest correlated Core inbox Tool pairs with an active
  Primary Session Activity context. Prove one stable Agent item appears and
  advances through nonterminal and terminal states while the Tool timeline
  remains present.
- **Projection invariants:** prove duplicate input, out-of-order nonterminal
  evidence after terminal, missing metadata, conflicting sessions, wrong
  targets, and ordinary `agent_activity` convergence.
- **Recovery:** create a reopened database containing settled retained Tool
  pairs but no Agent item. Run bounded convergence twice. The first pass
  creates the expected Subagents view and one visible invalidation; the second
  is byte/behavior idempotent and reserves no duplicate delivery.
- **Card acceptance:** prove the production-shaped path renders the existing
  `Subagents` section and launching/running/blocked/terminal labels without
  adding a second Subagent card or exposing prompt/result content.
- **Architecture evidence:** retain the import-boundary check and verify card
  and domain modules do not import the external tool-protocol translator or
  schema library.
- Run focused translator, Session Activity, Core inbox, Conversation Segment,
  Main/Answer Card, restart/recovery and event-projector suites, followed by
  `npm run typecheck`, `npm run architecture:check`, `npm run build`, and the
  full `npm test` suite.

## Out of Scope

- Displaying Herdr native Agent-session IDs or treating Worker Session
  generation as this feature.
- Parsing `<agent-activity>` UI messages, Pane output, assistant prose, task
  prompts, final answers, or arbitrary Tool-result text.
- Changing Core, TraeX, Herdr, multi-agent scheduling, tool definitions,
  Worker Runtime, Worker Threads, or Worker Task ownership.
- Removing multi-agent Tool calls/results from the Answer Timeline.
- Guessing missing history after Core payload compaction or rebuilding all
  historical sessions.
- Repairing the independently stale `smoke:headless-multi-agent` scheduler
  script in this change.
- Installation, service restart, production SQLite mutation, live Feishu
  smoke, push, pull request, or deployment without separate authorization.

## Further Notes

Gate 1 approved the Swarm structured-translation approach after production
evidence showed that current `multi_agent_v1` activity arrives only as
correlatable Tool call/result events. This replaces the initial mistaken
diagnosis about Herdr native Agent-session identity and reopens the earlier
Session Activity design assumption without changing its public card layout.

The prepared workspace is in-place at
`<repo>`, branch `main`, starting
revision `6c9441d460da96d5fe9bb5c2006aed2f35c2f7b2`. In-place work is safe because
the task owns a new specification path and proposed projection/translator/card
test paths, while initial user changes are confined to modified `AGENTS.md`,
`src/store/sqlite/prepared-delivery-store.ts`,
`tests/prepared-delivery-store.test.ts`, and untracked `.tmp-build/`,
`docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
`docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
`handoff.md`. Those paths are preserved and excluded from task commits.

Dependencies are present. Fresh baseline evidence at this revision is:

- `npm test`: 298 files and 4,436 tests passed;
- `npm run typecheck`: passed;
- `npm run build`: passed and generated build identity
  `sha256:190136aec5bc346fa97e610341b79db3c3593e78d87a17c643ea6c85d8e30a41`.

The separate `npm run smoke:headless-multi-agent` command currently fails at
module loading because it imports the intentionally removed
`src/events/instance-work-scheduler.js`. This pre-existing script defect is not
part of the green project baseline or the approved design. The in-scope
production-shaped durable-event integration test is the acceptance seam for
this repair.

There are no unresolved design decisions or local implementation blockers.
Gate 2 approval authorizes ticket decomposition only. It does not authorize
implementation, commits, installation, restart, production mutation, push, or
pull-request work.
