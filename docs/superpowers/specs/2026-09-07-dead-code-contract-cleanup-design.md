# Dead Code and Empty Contract Cleanup Design

## Goal

Remove production code that has no reachable behavior and narrow interfaces that
currently advertise lifecycle capabilities they do not own. Preserve migration,
durability, and compatibility code that still interprets existing state.

## Evidence and options

Static reference inspection found three high-confidence candidates:

- `ModelSelectionWorkflow.shutdown()` is empty, but forces `InboundRouter` to own
  a model-selection dependency solely for shutdown.
- `isTerminalPaneControlState()` is exported but has no caller.
- `findNativeTaskFrame()` is exported but has no caller; only the private line
  parser is needed by `stripNativeTaskFrame()`.

The alternatives are to leave empty hooks for hypothetical future use, add
comments or deprecation wrappers, or remove them. Removal is selected because the
repository is the only supported package surface, there are no callers, and each
symbol can be reintroduced with an actual contract if a future use case appears.

## Changes

`ModelSelectionWorkflowPort` loses `shutdown()`. `InboundRouterOptions` no longer
contains `modelSelection`, composition and test helpers stop injecting it, and the
router shutdown sequence no longer invokes an empty method. Model selection remains
injected into its real consumers: the command gateway, card-action router, and pane
control workflow.

`isTerminalPaneControlState()` is deleted while `PaneControlOutcome` and
`paneControlOutcomeSources()` remain as active transition contracts.

The public `findNativeTaskFrame()` wrapper is deleted. The internal
`findNativeTaskFrameLines()` parser remains private and continues to support
`stripNativeTaskFrame()`, so answer sanitization behavior is unchanged.

## Boundaries

This cleanup does not remove schema migrations, persisted legacy enum values,
outbox payload fallbacks, archived documentation, store aggregate methods, or
barrel type exports. Those require compatibility or package-boundary evidence
beyond a simple in-repository reference count.

## Verification

Add an architecture assertion preventing the empty model shutdown contract from
returning. Run focused router and rendering tests, TypeScript unused checks, the
full test suite, typecheck, build, documentation audit, architecture check, and
`git diff --check`.
