# Primary Runtime State Port Design

## Purpose

Reduce coupling to `PromptRunWorkflow` by giving read-only consumers a small
domain interface for current Primary execution state. Preserve the existing
single in-memory registry and all Prompt execution behavior.

## Problem

`PromptRunWorkflowPort` currently combines lifecycle control, scheduling,
recovery commands, detached-Prompt mutation, diagnostics, and two read-only
queries: `activeTurn(bindingId)` and `isBindingBusy(bindingId)`. Several modules
need only one of those queries, but composition passes closures tied to the
concrete `PromptRunWorkflow`. Other coordinators accept ad-hoc function fields
with equivalent semantics.

The implementation remains a deep module, but its consumers lack a named seam
for the stable runtime-state concept. This spreads vocabulary and makes it easy
for future callers to depend on the full workflow when they need only a read.

## Considered Approaches

### 1. Read-only domain port implemented by PromptRunWorkflow (selected)

Move `ActiveTurnSnapshot` into `src/domain/ports/primary-runtime-state.ts` and
define `PrimaryRuntimeStatePort` with `activeTurn` and `isBindingBusy`. The
existing workflow implements it structurally. Composition passes the port to
consumers, which use either the interface or the narrow method they need.

This preserves one source of truth and gives consumers minimum authority.

### 2. Separate state service around PromptRunRegistry

Expose the registry through a new runtime object. This adds lifecycle and wiring
for no new behavior and risks two owners of current-turn state. Rejected.

### 3. Keep ad-hoc closures

The closures are mechanically simple, but each caller names the concept
differently and composition remains responsible for adapting the same two
queries repeatedly. Rejected.

## Design

Add the domain types:

```ts
interface ActiveTurnSnapshot {
  promptId: string;
  paneId: string;
  state: Binding["lastAgentState"];
}

interface PrimaryRuntimeStatePort {
  activeTurn(bindingId: string): ActiveTurnSnapshot | null;
  isBindingBusy(bindingId: string): boolean;
}
```

`PromptRunWorkflowPort` extends this port and `PromptRunWorkflow` remains its
only production implementation. The state still comes directly from its private
`PromptRunRegistry`. No snapshots are persisted or cached elsewhere.

Composition names the returned read-only view `primaryState` and passes it to
the following consumers:

- model selection;
- pane control;
- command-context resolution;
- session administration;
- pane closure;
- pane retention;
- Primary binding reconciliation;
- inbound prompt lineage capture.

Consumers that need the full Prompt workflow for commands such as `awake`,
`skipDetached`, lifecycle start/stop, or queue wake-up retain the full port. This
slice does not force unrelated methods behind the state interface.

Where an existing coordinator option is a single function, it may remain a
single function if that is its smallest natural interface. Composition obtains
that function from `primaryState`, not from a concrete workflow. Consumers that
already need both queries should accept `PrimaryRuntimeStatePort` directly.

## Dependency Rule

The runtime-state vocabulary belongs to `domain/ports`. Coordinator modules may
implement or consume it. Composition connects the implementation. No domain
module imports `PromptRunWorkflow`, `PromptRunRegistry`, or composition code.

## Behavior and Safety

- No registry ownership, scheduling, queue, or lifecycle behavior changes.
- `activeTurn` and `isBindingBusy` preserve their exact current return values.
- No SQLite, Herdr, TraeX, Gateway, card, or outbox changes.
- No new asynchronous boundary or cache is introduced.
- Existing no-replay and exact-turn behavior remains inside PromptRunWorkflow.

## Verification

Architecture tests require the domain port, require `PromptRunWorkflowPort` to
extend it, and ensure composition uses the named `primaryState` seam for
read-only wiring. Existing Prompt workflow, command, pane, reconciliation, and
inbound-routing tests remain the behavior suite. Run focused tests, typecheck,
build, and the full suite.

## Non-goals

- No decomposition of Prompt execution internals.
- No persistence of process-local active-turn state.
- No changes to lifecycle control or diagnostics ports.
- No service install, restart, configuration change, or push.
