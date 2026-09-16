# Ticket: Prefer Herdr Native Session State

## Problem

The bridge currently uses Herdr's structured snapshot for Pane identity and agent
state, but several hot paths still poll and parse terminal text to infer lifecycle.
This couples workflow correctness to TraeX screen rendering and causes unnecessary
`pane read` calls. the then-supported Herdr release already exposes native Pane/Agent state, output
revision events, and optional native agent-session references.

## Outcome

The bridge consumes Herdr Socket API lifecycle/Agent events plus the existing
plugin output-change hook and reconciles both against fresh snapshots. Structured
Herdr state is authoritative whenever it is known. Terminal text remains a content
source for answer streaming, final answer extraction, TraeX selectors, and a
bounded fallback when Herdr reports `unknown`.

Native `agent_session` references are represented separately from terminal
identity. They identify a resumable agent conversation when an official Herdr
integration reports one; they are not treated as conversation history or proof
that a particular Lark prompt completed.

## Acceptance Criteria

1. The managed service receives the current Herdr socket path without hardcoding
   the default session path.
2. A reconnecting Socket API subscriber listens for supported Pane and Agent
   lifecycle events and routes them into targeted reconciliation; the plugin hook
   remains the output-change wake-up source on the then-supported Herdr release.
3. Socket loss never stops the bridge. Startup and periodic snapshot
   reconciliation remain the convergence path.
4. Snapshot parsing retains `agent_session` as an optional, typed reference
   distinct from `terminal_id`.
5. Known structured state never gets overridden by terminal heuristics.
6. Turn observation reads terminal content only when output revision changes, at
   final-answer extraction, for an interactive TraeX selector, or while structured
   state is `unknown`.
7. Existing no-replay, FIFO, steering, durable-outbox, and local-approval
   invariants remain unchanged.
8. Socket framing, reconnect, targeted event routing, snapshot/session parsing,
   unknown fallback, and output-read suppression have focused tests.
9. Full tests, typecheck, build, diff check, plugin restart, readiness, and bounded
   log inspection pass.

## Out of Scope

- Reading full agent conversation history from Herdr. Herdr exposes a resumable
  session reference, not a transcript API.
- Replacing SQLite prompt and delivery state with Herdr session state.
- Removing terminal parsing needed for answer content, `/model`, Mode selection,
  or approval-screen classification.
- Requiring experimental Pane history.
