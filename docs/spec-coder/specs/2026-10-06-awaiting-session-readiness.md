# Awaiting Session Readiness

## Problem Statement

An active Primary Binding can exist briefly before Herdr exposes its first exact native session identity. The Core session ingestion supervisor currently classifies every unresolved route as lagging and records `route_unavailable`, even when no durable Agent Input requires that route. This makes a normal lazy-session startup window look like an ingestion failure and can unnecessarily lower operator confidence in readiness diagnostics.

## Solution

Represent an active Primary Binding that has no persisted exact native session and no durable ingestion obligation as `awaiting_session`. Awaiting Bindings are observable but are neither lagging nor required failures. Once Herdr publishes and reconciliation persists an exact session, ordinary Core ingestion begins. If a pending durable Input requires ingestion while the exact route is absent, the same Binding remains fail-closed as `route_unavailable` and lowers readiness.

## User Stories

- **SCN-1 — Lazy first session:** after a Binding becomes active but before its first native session exists, operators see `awaiting_session`; Agent Input readiness remains ready when no durable Input is pending.
- **SCN-2 — Required route missing:** if durable pending Input exists for that owner and generation, a missing exact route is lagging, reports `route_unavailable`, and makes Agent Input readiness not ready.
- **SCN-3 — Session convergence:** when the exact session later becomes available, the supervisor removes the Binding from awaiting state and ingests the session normally.

## Implementation Decisions

### Domain Model

Core Session Ingestion owns route-readiness classification. `awaiting_session` means the first exact native session has not yet been persisted for an active Primary Binding and the Submission Intent projection has no pending Input Card for that exact owner generation. It is a normal transitional state, not a failure. `hasPendingInputCards(ownerKind, ownerId, generation)` remains the authoritative durable ingestion-obligation predicate.

**INV-1:** absence of a persisted exact session is harmless only while no durable ingestion obligation exists.

**INV-2:** an existing exact session whose live route cannot be resolved is not `awaiting_session`; it remains a route problem and retains lag diagnostics.

**INV-3:** input admission and prompt submission continue to require exact native identity; this change does not guess a session, submit input, replay uncertain work, or weaken fail-closed routing.

### Architecture

`CoreSessionIngestionSupervisor` classifies an unresolved Primary route using the persisted Binding identity plus the existing `requiresIngestion` port. It owns in-memory awaiting/lag sets and publishes bounded diagnostics through `CoreSessionIngestionDiagnostics`. The composition root continues to supply `SqliteBindingStore.agentInputs.hasPendingInputCards` as the requirement predicate; no persistence schema or admission workflow changes are needed.

The existing runtime `state` diagnostic gains the stable value `awaiting_session` when the supervisor is idle and one or more owners are waiting for their first session. `awaitingSessions` exposes the bounded count. Running and stopped lifecycle states retain precedence.

### Behavior & Failure Modes

- A sessionless, non-required Binding clears stale lag/retry/required-failure state and enters the awaiting set without overwriting last-failure metadata.
- A sessionless Binding that becomes required leaves awaiting state, enters lag, and records `route_unavailable`.
- An exact route leaves awaiting state before ingestion. A failed exact-route ingestion remains a real lag/retry condition even when not currently required.
- Bindings that leave the active owner set are removed from awaiting, lag, retry, and required-failure tracking.

### Compatibility & Migration

The diagnostics contract adds `awaiting_session` to `state` and adds `awaitingSessions`. Existing readiness consumers continue to use `ready` and `requiredFailures`. No database migration is required.

## Testing Decisions

At the existing `CoreSessionIngestionSupervisor` public seam:

- prove a sessionless active Binding with no pending obligation reports `state: "awaiting_session"`, `awaitingSessions: 1`, no lag, no required failure, and no failure code;
- prove the same owner becomes fail-closed when the requirement predicate turns true;
- prove later exact-source convergence clears awaiting state and runs ingestion;
- preserve the existing pending-Primary-Input test as the rejection/fail-closed guard;
- run the focused ingestion tests, health diagnostics tests, typecheck, build, and the full suite.

## Out of Scope

- Changing Feishu Agent Input admission or guessing a session identity.
- Replaying uncertain inputs or altering Submission Intent semantics.
- Changing sessionless Worker enumeration; this slice addresses the observed active Primary Binding window.
- Resolving historical `recovery_ambiguous` or SQLite integrity debt.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`, in-place on `main`.
- Starting revision: `15d5b9271406b5ab3f164e52fe8e4ddb1c27766a`.
- Pre-existing user changes preserved: modified `TODO.md`; untracked `docs/research/2026-10-02-session-message-jsonl-dependencies.md`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`.
- Baseline at the starting revision: 274 files / 3,959 tests passed; `npm run typecheck` passed; `npm run build` passed.
- The user explicitly approved the `awaiting_session` semantics and previously authorized autonomous implementation, verification, commit, installation, restart, and live verification within this task list.
