# Workflow Worker Architecture Implementation Plan

## Slice 1: introduce wake-up vocabulary and capability port

1. Add a typed `WorkflowWakeupBus` with non-blocking publication and scoped
   prompt, steering, detached-observer, and runtime-change signals.
2. Add unit tests for subscription, duplicate publication safety, and stop-time
   unsubscription.
3. Define `PromptExecutionStore` as the narrow structural subset required by
   prompt execution. Keep `SqliteBindingStore` unchanged as its implementation.

## Slice 2: extract prompt execution

1. Add `PromptExecutionWorkflow`.
2. Move ordinary workers, steering workers, detached observation,
   `TurnSupervisor`, queue-position refresh, event publication, and graceful
   observer detachment from `SyncCoordinator`.
3. Expose only `start`, `wake`, `stop`, `isBindingBusy`, and `activeTurn`.
4. Preserve existing prompt claim and dispatch checkpoint transitions.
5. Add focused workflow tests for wake-up coalescing and durable recovery.

## Slice 3: wire producers and convergence

1. Compose the wake-up bus and prompt workflow inside `SyncCoordinator` to keep
   its public constructor stable during this slice.
2. Make prompt acceptance publish wake-ups only after `acceptPrompt` returns.
3. Translate successful Answer-card delivery into `prompt-ready`.
4. Replace `SessionReconciler` scheduling callbacks with wake-up publication and
   durable scans.
5. Route resume and startup recovery through wake-ups.
6. Remove prompt worker maps, scheduling methods, detached observers, and
   `TurnSupervisor` from `SyncCoordinator`.

## Slice 4: verification and documentation

1. Run wake-up, workflow, steering, concurrency, lifecycle, publisher, and
   reconciler focused tests.
2. Run `npm run typecheck`.
3. Run `npm test`.
4. Run `npm run build`.
5. Update `docs/architecture.md` to describe the implemented workflow boundary.
6. Review the final diff for accidental schema, CardKit, or public behavior
   changes, then commit implementation and docs as separate thematic commits.
