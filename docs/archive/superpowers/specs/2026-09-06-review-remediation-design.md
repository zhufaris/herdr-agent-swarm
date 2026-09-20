# Review Remediation Design

## Status

Approved for implementation on 2026-09-06.

## Goal

Resolve the standards and specification gaps found in the `origin/main...HEAD`
review without weakening durable execution, runtime identity fencing, or local
approval boundaries.

## Exact-turn remote stop boundary

The bridge may expose a remote stop only for one exact active turn. Every stop
must be authorized and fenced by the current actor, instance or binding
generation, pane identity, native Agent session, and runtime turn ID. The
durable effect intent is recorded before the external command and an uncertain
interrupt is never replayed automatically. Blocked approval or question states
reject stop.

Remote approval, denial, arbitrary terminal input, process killing, and pane
killing remain prohibited. High-risk approval stays local to Herdr. The
repository guide must describe this narrower boundary rather than claiming that
all remote stop actions are prohibited.

## Pane-close result accuracy

The parent-pane close cascade keeps each child close result durable. The final
operator card reports total, succeeded, and uncertain Worker pane counts. A
result containing an uncertain child is rendered as a warning/partial result
and must not claim that every Worker pane closed. The Primary pane may still be
closed and archived after all child effects have been attempted, as required by
the ordered cascade.

## Worker interaction availability

A blocked TraeX turn does not advertise steering because the current driver and
turn-control path reject protected blocked states. Its card directs the operator
to the Herdr pane without exposing a mutating task action.

Worker Main exposes `发起新任务` only when the runtime is usable for submission:
the session is not frozen, the runtime is idle, working, or blocked, a card
message ID exists, and the callback path can still validate the attached runtime
and active parent. Rendering and callback validation share the same domain
predicate so they cannot drift.

## Boundary validation and domain ownership

All shim `--agent-session` JSON is parsed through shared Zod schemas. A generic
schema covers exact steering input; a stricter managed-TraeX schema covers model
operations. Existing error messages remain bounded and never include the input.

`TraexModelSummary` becomes a domain model-selection contract. Runtime protocol
code and external ports depend on that domain type, eliminating the domain to
runtime import.

## Verification

Add focused tests for partial pane-close cards, blocked task actions, unusable
Worker Main states, and session-schema rejection. Run `npm run typecheck`, the
full Vitest suite, `npm run build`, and `git diff --check`.
