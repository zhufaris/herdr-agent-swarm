# Per-pane identity, shared tabs, and Delivery Rings

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Herdr Agent Swarm currently gives each managed Worker a dedicated tab while its
user-visible deliveries are ordered in the parent Primary Pane Delivery Scope.
That produces two mismatches:

- pane and tab labels do not show a stable Primary/Worker role hierarchy;
- a slow, retrying, or blocked Worker delivery can delay later Primary delivery
  because both use the same parent-Pane Ring.

The approved design changes the topology to one Primary tab containing its
Primary pane and Worker panes, and changes delivery ordering to one Ring per
actual pane identity. A pane created directly through Herdr and later adopted by
Swarm is a default Primary in its own tab, not a Worker and not a member of
another Primary's group.

Live evidence before planning showed an empty Ring hot path (`pending=0`,
`waitingBehindScope=0`, `uncertainBlocked=0`) but a normal Feishu delivery still
takes about 0.75 seconds at p50 and 1.67 seconds at p95. Serializing unrelated
Worker and Primary effects therefore creates avoidable head-of-line latency even
when no failure exists.

## Solution

Introduce one canonical Pane Identity derived from Herdr's authoritative pane
token and role:

- managed Primary: `<group-token>-main`;
- managed Worker: `<parent-group-token>-<worker-name>`;
- Herdr-created default Primary: `<own-token>-default-main`;
- tab label: the owning Primary/default Primary group token.

Managed Workers are created by splitting the exact parent Primary pane, so they
start in the same tab. Existing managed Workers are moved into that tab only
through a durable, identity-fenced topology operation and only while their
runtime has no active or uncertain turn. Pane moves preserve the terminal and
Agent session; a changed Pane ID from Herdr is adopted only from the exact move
receipt or an exact post-effect observation.

Delivery Scope becomes the actual effect owner's pane. Primary effects remain
in the Primary pane scope. Worker effects use the Worker's current, verified
runtime pane scope while retaining an explicit durable parent-Pane fence. Old
Worker Outbox Entries remain in their original parent-Pane scopes until they
settle; they are never rewritten, re-claimed under a new scope, or replayed.

## User Stories

### SCN-1: A managed Primary gets a role-bearing identity

When Swarm creates or reconciles a managed Primary, the actual Herdr pane token
becomes its group token, the tab label is that token, and the pane label is
`<token>-main`. The pane ID, terminal identity, and Agent session remain runtime
authority; display labels never replace those fences.

### SCN-2: A Worker starts in its Primary tab

When an operator starts a Worker, Swarm splits the exact current Primary pane
instead of creating a dedicated tab. The resulting pane is verified in the
same workspace and tab, its label is `<primary-token>-<worker-name>`, and its
own Herdr pane token remains unique.

### SCN-3: A directly created Herdr pane becomes a default Primary

When reconciliation adopts a supported Agent pane created directly through
Herdr, Swarm uses that pane's own token as its group token, labels the tab with
the token, and labels the pane `<token>-default-main`. It receives its own
Primary Pane Delivery Ring and never borrows another Binding's group token.

### SCN-4: An existing Worker converges into the Primary tab

When an existing managed Worker is idle and its Worker, parent Binding, pane,
terminal, and Agent-session fences all match, Swarm persists a Pane Topology
Intent before asking Herdr to move it into the current Primary tab. A matching
receipt or exact observation settles the intent. An active/uncertain Worker is
deferred without terminal input, interruption, or process replacement.

### SCN-5: Primary and Worker delivery progress independently

A Worker Outbox Entry reserved after cutover uses the Worker's actual pane ID
as its Delivery Scope. A Primary entry uses the Primary pane ID. The Ring
scheduler may execute them independently subject to its existing global permit
limit and Feishu-wide cooldown, while each individual pane remains serial.

### SCN-6: Historical Worker delivery remains no-replay compatible

An Outbox Entry created before cutover keeps its original parent-Pane scope and
prepared effect. Startup and safety refill continue to claim and settle it with
the original idempotency, checkpoint, and owner fences. No migration changes
its Delivery Scope or fabricates provider-effect evidence.

### SCN-7: Missing runtime identity fails closed

If a Worker has no exact current runtime pane, or its parent Binding/Panes no
longer match, new Worker delivery reservation and topology mutation are rejected
or deferred. Neither path falls back to the parent Primary Ring or Global Ring.

## Implementation Decisions

### INV-1: Group Token is display identity, not runtime authority

The **Group Token** is the actual authoritative Herdr token of a Primary or
default Primary pane. The **Pane Identity** is the immutable display tuple
`(groupToken, role)` used to derive labels. Roles are `main`, a validated Worker
name, or `default-main`. A Worker's own Herdr token remains distinct and is
retained for runtime lookup and UI display where needed. Pane ID, terminal ID,
Agent session, Binding/Worker generation, and session generation remain the
behavioral fences.

References: SCN-1, SCN-2, SCN-3

### INV-2: One Primary group owns one tab

The Primary/default Primary tab label equals its Group Token. A managed Worker
must be in the same tab as its current parent Primary. Creating a Worker splits
the exact parent pane; it must not select the first workspace pane and must not
create a dedicated tab. Layout direction and ratio remain presentation choices
inside the Herdr adapter and do not affect identity.

References: SCN-1, SCN-2, SCN-3, SCN-4

### INV-3: Pane topology effects are durable and observable

SQLite owns a **Pane Topology Intent** before any rename or move that changes a
managed runtime's visible identity or tab membership. The intent freezes the
owner/generation, expected workspace, pane, terminal and Agent session, desired
tab/anchor and labels, and lifecycle state. Application coordination may offer
that intent to Herdr; only the Herdr adapter translates it to CLI/socket
operations.

After a success receipt, or after an error followed by an exact observation
that proves the target topology, SQLite settles the intent and adopts any
receipt-provided Pane ID. If exact observation proves the old topology still
exists, the same intent may retry. Ambiguous, missing, or multiply matching
runtime evidence stays deferred/uncertain and is not replayed automatically.
Topology-intent recovery runs before ordinary Instance Runtime missing-pane
termination. While an intent is active, one workspace snapshot may locate the
moved runtime only by an exact unique terminal and Agent-session match; no pane
label, token, cwd, sidebar position, or partial match can establish adoption.

References: SCN-4, SCN-7

### INV-4: Delivery Scope is the physical effect-owner pane

Every pane-owned new Delivery Intent uses
`["pane", workspaceId, actualOwnerPaneId]` as its Delivery Scope. Primary
delivery uses the Binding pane. Worker delivery uses the exact attached Worker
runtime pane. Global effects remain in the sole Global scope. Each scope has
one process-local Ring and one derived Delivery Ring Checkpoint; SQLite remains
the delivery authority and refill source.

References: SCN-5, SCN-7

### INV-5: Worker scope and parent ownership are separate fences

A Worker delivery freezes both its Worker pane scope and the owning Primary
pane identity. The Outbox schema adds an immutable nullable
`delivery_parent_pane_id`: it is required for new Worker rows, null for Primary
and Global rows, and backfilled from the old Worker `scope_pane_id` during
migration. Worker claim/target checks require:

- the Worker ID, runtime generation, Worker-session generation, workspace, and
  current runtime pane to match the Worker scope;
- the parent Binding ID, generation, session generation, workspace, and pane to
  match the frozen parent-pane fence;
- the Worker's recorded parent identity to match that same Binding fence.

Target-specific Worker Thread and alias checks use the parent-pane fence rather
than assuming `scope_pane_id` is the parent.

References: SCN-5, SCN-6, SCN-7

### INV-6: Historical scope is immutable and remains claimable

Existing Worker Outbox Entries are backfilled with
`delivery_parent_pane_id = scope_pane_id` but their scope, scope key, delivery
order, payload/Presentation Snapshot, prepared plan, attempt evidence, and
checkpoints do not change. Compatibility claim logic accepts that legacy shape
when the frozen parent and current generation/session fences still match. All
new reservations route through the Worker runtime pane; there is no new writer
path that produces the legacy shape.

References: SCN-6, SCN-7

### INV-7: Cross-pane order is explicit

Moving Worker effects to their own Ring removes implicit parent-scope FIFO.
Ordering that is semantically required—create before update, thread activation
before dependent presentation, or a recovery successor after its failed
effect—must remain represented by existing durable prerequisites, projection
revision checks, conflict keys, and owner fences. Unrelated Primary and Worker
effects have no artificial ordering edge.

References: SCN-5, SCN-6

### ARCH-1: Identity policy is a pure domain module

The Pane Identity module validates Group Tokens and Worker names and returns
desired tab/pane labels for managed Primary, Worker, and default Primary roles.
It imports no Herdr, SQLite, CardKit, or composition types. Provisioning,
reconciliation, cards, and tests consume this one interface instead of parsing
legacy `lark_` labels independently. Legacy label parsing remains a bounded
compatibility input, not the source of new identity.

References: SCN-1, SCN-2, SCN-3

### ARCH-2: Topology coordination remains application-owned

Primary provisioning, direct-pane discovery, and Worker runtime reconciliation
decide when an identity/topology change is eligible. They call a narrow
PaneHost/Herdr interface with frozen expected and desired topology data. The
adapter owns `pane split`, exact `pane move`, pane rename, tab rename, response
normalization, and post-call observation. Coordinators never assemble raw CLI
arguments; the adapter never decides Binding/Worker eligibility.

The topology reconciler consumes unresolved Pane Topology Intents before the
ordinary Instance Runtime reconciler may terminalize a missing old pane. It
supplies any exact adopted Pane ID back through the existing instance-store
generation CAS; the ordinary reconciler then resumes from that current runtime
reference. Existing close/control operation stores remain unchanged because
their actors, states, and recovery meanings do not represent topology intent.

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-7

### ARCH-3: Delivery routing owns the per-pane seam

The delivery-scope domain function accepts a Worker runtime workspace/pane and
its separate parent fence, returning one scope plus one owner fence. The Outbox
reservation adapter obtains those facts from current SQLite projections and
fails closed when any fact is missing. Prepared Delivery consumes only the
frozen route and validates it atomically at claim/ACK/recovery boundaries.

References: SCN-5, SCN-6, SCN-7

### ARCH-4: Migration expands before route cutover

Schema migration first adds/backfills the parent-pane column and validation
indexes/triggers while old routing remains readable. New Worker routing then
switches to the physical pane. Compatibility predicates retain old rows until
terminal. Contraction of legacy parent-scope compatibility is not part of this
change and requires separate evidence that no actionable legacy Worker rows
remain.

References: SCN-5, SCN-6

### ARCH-5: Operational evidence distinguishes scope and topology lag

Status/logging reports bounded counts of pending/uncertain Pane Topology
Intents, legacy parent-scoped Worker entries, per-pane Ring scopes, and
waiting-behind-scope work without exposing prompts, card payloads, actor IDs,
or terminal content. Deployment verification compares Primary and Worker scope
keys and measures Primary latency during Worker delivery.

References: SCN-4, SCN-5, SCN-6

### SCN-8: A delivered prior Turn Card explains same-turn input coalescing

Given a canonical Human Message already has a delivered Working Turn Card with
visible commentary or Tool activity but no final assistant event, when a later
canonical Human Message closes that Conversation Segment while the Agent's
active Turn continues, the prior card receives one exact terminal update. The
update preserves the visible activity, uses the grey `已并入后续输入` state,
and states that no independent final reply was produced and the later input
continues in the current Turn. It does not fabricate a final answer.

The update remains eligible only while its exact page, pending reply, owner,
revision, message target, and generated finish idempotency key still match.
An ordinary snapshot or any other stale closed-page update remains dismissible
before Gateway execution. Existing possible-effect evidence remains immutable
and is never replayed.

References: INV-8, ARCH-6

### INV-8: Closing presentation is explicit without weakening delivery fences

Closing a Conversation Segment because a later Human Message arrived is not a
successful independent completion. Presentation must distinguish this outcome
from `completed`, while Prepared Delivery may claim only the exact terminal
finish update reserved for the authoritative delivered page. Closed-segment
state alone never makes an arbitrary pending update current.

References: SCN-8

### ARCH-6: Rendering and delivery retain separate ownership

Turn Card presentation owns the label, colour, explanatory notice, and terminal
summary for a closed Segment. Prepared Delivery owns the atomic exact-target
predicate and recognizes the terminal update by the same deterministic finish
key generated by Conversation Segment persistence. Segment closure and active
Turn steer/coalescing remain unchanged.

References: SCN-8, INV-8

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, SCN-8, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-5, ARCH-6

- Pure domain tests cover every Pane Identity role, invalid token/name input,
  canonical labels, and legacy-label compatibility without external commands.
- Herdr adapter tests assert exact parent-pane split, exact move target, exact
  pane/tab labels, normalized receipts, changed Pane IDs, and post-error
  observation without executing a live mutation.
- Worker topology integration tests use a fake PaneHost and real SQLite to
  prove durable intent-before-effect, active-turn deferral, exact receipt
  adoption, restart recovery, uncertain observation, no duplicate move, and
  exact terminal/session relocation before missing-pane termination. Ambiguous
  or duplicate relocation candidates remain uncertain and preserve the Worker.
- Delivery-scope tests prove Primary, Worker, default Primary, missing-runtime,
  and Global routing. SQLite migration tests round-trip historical Worker rows
  and preserve their original scope/plan/effect evidence.
- Prepared Delivery and Ring integration tests prove Primary and two Workers
  occupy three independent Rings, same-pane effects remain serial, the global
  permit still bounds concurrency, cross-pane prerequisites still block, old
  parent-scoped Worker rows remain claimable, and stale owner/pane fences fail
  closed.
- Architecture checks prove domain modules do not import adapters/SQLite and
  coordinators depend on PaneHost/delivery interfaces rather than raw Herdr
  command execution.
- Delivery verification runs the affected suites, typecheck, build,
  architecture and docs checks, then the full applicable test suite with the
  repository's SQLite-safe worker limit. Live E2E observes topology and Ring
  scopes before authorizing any production move.
- Coalesced-message integration proves first Human -> delivered Working card ->
  visible commentary -> second Human before final -> explicit merged terminal
  update. A Prepared Delivery counterexample proves an ordinary closed-page
  snapshot is still dismissed.

## Out of Scope

- Rewriting or replaying any existing Outbox Entry, provider effect, Gateway
  plan, Delivery Scope, or Delivery Ring Checkpoint.
- Moving a Worker with active or uncertain work, interrupting Agents, replacing
  terminals/sessions, or killing panes.
- Changing Feishu thread ownership, card identity, global cooldown, the Ring
  scheduler's global permit count, or the three-attempt delivery policy.
- Contracting legacy parent-scoped Worker compatibility in this change.
- The separately observed no-op `worker.runtime-observed` invalidation churn,
  orphan-warning rate limiting, Core-ingestion wake latency, and metric naming;
  those remain later optimization tickets.
- Force restart, push, pull request, or external issue publication.

## Further Notes

Gate 1 selected the per-physical-pane approach with in-place, identity-fenced
existing-Worker convergence. The direct-Herdr-pane suffix was clarified as
`default-main` before Gate 1 approval.

Workspace mode: isolated existing Git worktree at
`/tmp/herdr-agent-swarm-delivery-95ab57b0`, branch
`feat/per-pane-delivery-rings`, starting revision
`95ab57b09fe455e363ea1aa800802ccb852d9e6d`. Isolation is required because the
original `main` worktree contains five user-staged files, including
`src/store/sqlite/prepared-delivery-store.ts`, which overlaps this design. Those
files remain untouched.

Dependency preparation: Node `v24.14.1`, npm `11.11.0`, Python `3.11.15`, and
`npm ls --depth=0` exited 0 against the locked dependency set. Fresh baseline
evidence for request `goal-per-pane-rings-20261013-gate2`:

- `bf5a762e82c841a9b6bec99f5ed073ce`: 180/180 focused pane, Herdr adapter,
  Worker topology, delivery-scope, and Ring hot-path tests passed.
- `34f4513fb28f491782ed4f319980cba9`: `npm run typecheck` exited 0.
- `cdd6638dd6b840ea97f7a7d9b1dbdfaa`: `npm run build` exited 0.
- `394ee64fae324d8ab90dcf80efd7804e`: `npm run architecture:check` exited 0
  with 536 source files checked.

An earlier broader baseline record `99bbd9a540754093a3c44ede6cebc014`
failed only because an unrelated semantic-preparation test still expects the
pre-policy first-failure dead-letter behavior. It is not used as green evidence
and remains visible for delivery review; no assertion was weakened or edited
before Gate 2.

No load-bearing design question remains open. Gate 2 approval authorizes ticket
decomposition only; it does not authorize implementation, live pane movement,
deployment, push, or restart.

Gate 2 was approved interactively by user choice `A` at
`2026-10-13T13:35:24Z` for this specification revision.
