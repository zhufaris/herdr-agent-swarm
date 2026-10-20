# Pane-Only Completion Choice Eligibility

Status: Revised Gate 1 design and revised Gate 2 specification approved.

## Problem Statement

The installed `herdr-choice-list` plugin currently asks the local Swarm
eligibility socket whether a TraeX turn may emit a trace-end Human Review
choice. Although Herdr already supplies the stable Pane identity, the Hook also
requires three Bridge-specific environment variables:
`HERDR_BRIDGE_BINDING_ID`, `HERDR_BRIDGE_GENERATION`, and `HERDR_PROJECT_ID`.

A TraeX process that existed before `/swarm attach`, or was otherwise started
without Bridge-owned environment injection, cannot acquire those variables
without replacing the process. The Hook therefore fails open and contributes
no inline Choice instruction. Its final Core message has no
`completion_choice`, so the Answer Card has no buttons. An attached Binding
created by discovery can additionally have no `creator_open_id`, leaving no
fallback Feishu user for the post-delivery mention.

The current Pane `wN:p6D` demonstrates both conditions: Herdr reports a live
TraeX agent and SQLite reports an active attached Binding, but the process has
none of the three Bridge identity variables and the Binding has no creator.
The focused Hook test confirms that missing Bridge identity currently returns
an empty Hook response.

## Solution

Make the stable Herdr Pane ID the Hook's only owner locator. The Hook sends
`{ paneId }` over the existing private Unix socket. Swarm resolves the unique
current Primary or Worker owner, generation, project, workspace, active work,
and stored Agent session from durable state, then verifies that identity
against a fresh Herdr Pane observation before returning a boolean eligibility
decision.

The client no longer reads or trusts `HERDR_BRIDGE_BINDING_ID`,
`HERDR_BRIDGE_GENERATION`, or `HERDR_PROJECT_ID`. The server may accept those
fields temporarily as ignored compatibility input, but they cannot influence
owner selection or eligibility.

For trace-end action authorization and mention routing, retain the existing
preference for the Feishu actor who submitted the owning Prompt or Worker Turn.
When `/swarm attach`
creates or reuses an owner-less Binding, record the attaching Feishu actor as
the fallback review owner through a generation-fenced, set-if-empty write.
Never replace an existing owner. Existing rows are not backfilled or rewritten
by migration; an idempotent later attach may fill an empty owner.

Choice buttons and the post-delivery mention share that trusted actor. If no
trusted actor exists after the fallback lookup, the Answer still completes but
neither an interactive Choice action set nor a mention is created. The system
does not invent a weaker callback authorization rule.

## User Stories

- **SCN-1 — Attached existing Primary:** A TraeX process started without Bridge
  identity variables is attached to a Feishu thread. On a later Swarm-owned
  Prompt, the Hook supplies the inline Choice instruction using only its Pane
  ID, and a valid final Choice appears on the Answer Card.
- **SCN-2 — Managed Primary compatibility:** A Bridge-created Primary with the
  old environment variables remains eligible, but changing those variables
  cannot select a different Binding, project, or generation.
- **SCN-3 — Worker resolution:** A live Worker Pane resolves to its exact active
  Worker generation and active Worker Turn; its parent Binding remains valid,
  and its Choice appears on the Worker Task Card.
- **SCN-4 — Ambiguous or stale Pane:** No candidate, multiple candidates, an
  inactive owner, stale generation/session, wrong workspace, non-TraeX agent,
  or absent active work returns ineligible and the Hook fails open.
- **SCN-5 — Review ownership:** A Feishu-origin Prompt or Worker Turn mentions
  its own actor after the Choice-bearing card is delivered. If that actor is
  unavailable, an owner-less Binding may acquire the actor from an idempotent
  `/swarm attach`; an existing fallback owner is never overwritten. If neither
  source supplies a trusted actor, the Answer completes without Choice actions
  or mention.
- **SCN-6 — Unavailable service:** A missing socket, timeout, malformed input,
  or shutdown race does not block TraeX from completing and creates no
  protocol-only continuation.

## Implementation Decisions

### Domain Model

Completion Choice eligibility belongs to the Agent Runtime integration context.
The **Pane ID** is an immutable locator supplied by Herdr, not proof of current
workflow ownership. The **Completion Choice Owner** is a server-resolved value
representing exactly one current Primary Binding or Worker instance together
with the generation, project/workspace, stored Agent session, and active
Prompt/Turn needed to interpret a final Choice.

The following invariants are authoritative:

- **INV-1 — Server-owned identity:** Owner ID, generation, project, workspace,
  and session are derived from SQLite and Herdr, never accepted from the Hook.
- **INV-2 — Unique current owner:** Exactly one eligible current owner may
  resolve for a Pane. Zero or multiple candidates fail closed.
- **INV-3 — Durable/live agreement:** The candidate's Pane, workspace, Agent
  kind, generation, and active work must be current. A durable Agent session
  identity is required and must agree with a fresh Herdr observation.
- **INV-4 — No lifecycle widening:** Only active, attached TraeX Primary
  Bindings and active TraeX Workers with their valid parent Binding can qualify.
- **INV-5 — Fail-open execution:** Eligibility failure removes optional Choice
  context but never prevents or extends the Agent response.
- **INV-6 — Review actor ownership:** A Feishu-origin work actor is the
  preferred Choice callback and mention target. An attach actor is only a
  set-if-empty fallback and cannot overwrite established ownership. Without a
  trusted actor, neither the action set nor mention may be created.
- **INV-7 — One final response:** The existing same-final-message Choice
  protocol and absence of protocol-only Stop continuations remain unchanged.

The existing Binding and Worker aggregates remain authoritative for lifecycle
and generation. No new aggregate is introduced. Owner resolution is a policy
over existing durable identities plus a live Pane observation.

### Architecture

The Hook module reduces its environment-derived request to a validated
`paneId`. Its interface remains bounded and asynchronous:

```ts
type CompletionChoiceEligibilityRequest = Readonly<{ paneId: string }>;

interface CompletionChoiceEligibilityPort {
  isEligible(request: CompletionChoiceEligibilityRequest):
    boolean | Promise<boolean>;
}
```

`CompletionChoiceEligibility` owns the policy. A consumer-shaped store seam
resolves zero, one, or ambiguous durable candidates by Pane ID without exposing
SQLite rows. Existing Binding/Instance lookup capabilities may implement the
seam when they can prove uniqueness; otherwise the SQLite adapter supplies one
bounded indexed query. The policy validates the candidate and calls the
existing `PaneHost.inspectPane` interface for live evidence.

`CompletionChoiceEligibilityGateway` remains the private Unix-socket adapter.
It validates size and shape, enforces timeouts and connection limits, and
returns only `{ eligible: boolean }`. The Hook learns no internal owner data.
The socket remains mode `0600`; local possession of a Pane ID is not sufficient
when durable/live checks fail.

The attachment workflow owns fallback review-owner adoption because it has the
authenticated Feishu actor and exact Binding generation. SQLite performs one
conditional update equivalent to “set creator only when currently null and the
Binding generation/Panes still match.” Completion action projection continues
to prefer the owning work item's Feishu actor over this fallback.

Source dependencies remain inward: the Hook and socket adapter depend on the
domain request/port; the eligibility policy depends on consumer-owned store and
Pane interfaces; SQLite and Herdr adapters implement those interfaces; the
composition root wires concrete implementations.

### Behavior & Failure Modes

On `UserPromptSubmit`, the Hook validates `HERDR_ENV=1` and the bounded
`HERDR_PANE_ID`, sends the Pane-only request, and emits the existing constant
inline context only for `eligible=true`. The Stop Hook uses the same request and
continues its existing non-blocking validation behavior.

The server takes one durable owner snapshot before the bounded Herdr read. It
accepts only one exact candidate with current active work and a persisted Agent
session identity. After the read it compares Pane ID, workspace, Agent kind,
and session identity. Any missing, stale, ambiguous, malformed, timed-out, or
conflicting evidence returns false. A late Herdr result after timeout cannot
mutate SQLite.

Duplicate Hook calls are read-only and idempotent. Duplicate attach commands
perform the same conditional owner adoption and cannot change a non-null owner.
Choice persistence, card rendering, post-delivery notification ordering, and
ordinary Agent Input idempotency are unchanged. The existing security invariant
is explicit: the same trusted actor authorizes callbacks and receives the
mention, so absence suppresses both optional surfaces.

### Compatibility & Migration

- No database schema or historical-data migration is required.
- The three Bridge environment variables may remain present in managed Pane
  processes, but the Choice Hook ignores them.
- The socket decoder may temporarily accept the three legacy fields as unknown
  compatibility input; tests prove they cannot alter the result.
- Existing owner-less Bindings remain unchanged until a later authenticated
  attach supplies a fallback review owner.
- The Core `completion_choice` schema and event identity are unchanged.

## Testing Decisions

- Hook unit tests assert that `HERDR_ENV + HERDR_PANE_ID` is sufficient, the
  outbound request contains only `paneId`, missing/invalid Pane identity fails
  open, and legacy Bridge variables cannot influence the request.
- Eligibility policy tests cover Primary and Worker success; no candidate;
  ambiguous candidates; inactive/unattached/wrong-kind owners; absent active
  Prompt/Turn; parent mismatch; Pane/workspace/session mismatch; and bounded
  Herdr failure.
- Gateway integration tests cover Pane-only decoding, ignored legacy fields,
  malformed requests, timeout, connection bounds, and boolean-only responses.
- Attach integration/store tests cover set-if-empty fallback ownership,
  generation/Pane fencing, duplicate attach, and non-overwrite behavior.
- Completion Choice integration tests prove a Pane without Bridge identity
  variables produces one Choice-bearing final card and that delivery releases
  one mention to the Prompt/Turn actor or fallback owner. A missing trusted
  actor leaves the Answer intact but produces neither action state nor mention.
- Run the focused Hook, eligibility, gateway, attach, Primary completion and
  Worker completion suites, followed by `npm run typecheck`,
  `npm run architecture:check`, `npm run build`, and the full test suite.

## Out of Scope

- Ring/checkpoint refactoring, which remains a separately approved discovery
  thread and resumes after this fix.
- Enabling Choice for unbound or inactive TraeX Panes.
- Changing Core's Choice protocol, adding a second protocol message, or
  inferring choices from visible prose.
- Remote approval or denial of high-risk native Agent actions.
- Historical Binding owner backfill, production installation, service restart,
  or live database mutation.
- A new anonymous, group-wide, or first-click-wins authorization policy for
  Choice buttons.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place, because tracked files were clean and all existing untracked
  paths are unrelated and can remain untouched.
- Branch and starting revision: `main` at `689ea283` (`origin/main` plus 52
  local commits).
- Preserved initial untracked paths: `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh preflight: `npx vitest run --maxWorkers=4` passed 286 files and 4,111
  tests; `npm run typecheck`, `npm run architecture:check`, and
  `npm run build` passed. A prior fully parallel run hit the existing
  five-second timeout in `answer-page-recovery.integration.test.ts`; its focused
  rerun passed 1/1 in 1.58 seconds before the bounded full-suite rerun passed.
- Gate 1 approved option A: Pane-only Hook request with server-side owner
  resolution and set-if-empty attach fallback ownership.
- Reopened Gate 1 approved the existing authorization boundary: without a
  trusted actor, both Choice actions and mention are omitted while the Answer
  completes normally.
