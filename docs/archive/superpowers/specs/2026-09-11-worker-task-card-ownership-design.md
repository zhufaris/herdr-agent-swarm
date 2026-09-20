# Worker Task Card Ownership Design

## Goal

Authorize Worker Task Card actions against the exact task card that emitted the
callback. Running tasks must accept exact-turn supplements, and terminal
historical tasks must accept explicit follow-up creation even after Worker Main
has moved to another current task.

## Decision

`WorkerCardActions.resolveTask()` uses `decideWorkerTaskCardOwnership`, the
existing task-specific domain policy. It supplies the persisted Instance turn,
Worker Turn Card view, Worker instance, parent Binding, callback message ID,
source-card message ID, and both generation fences.

Task actions do not load or depend on `WorkerMainView`. The source identity
returned to the instruction form is the Task Card view's own `messageId`. Worker
Main ownership remains unchanged for independent new-task actions.

## Required fences

An action is accepted only when all of these facts agree:

- callback message ID and payload source ID equal the durable Task Card message;
- turn, Task Card view, and Worker instance share the same instance identity;
- instance and Task Card generations match the callback generation;
- Worker session generations match;
- the parent Binding is active, attached, on the expected pane and generation,
  and belongs to the same chat.

The current task shown by Worker Main is intentionally irrelevant.

## Verification

Integration tests obtain callback values from `renderWorkerTurnCard()` and
cover running steer, terminal follow-up, phase change between opening and
submitting a form, stale Task Card message identity, stale instance/session
generation, and stale parent Binding. Existing Worker Main new-task behavior
must remain unchanged.

The final gate is focused ownership/routing tests, typecheck, build, architecture
checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Changing ordinary replies to Task Cards; they still route to Primary.
- Changing callback payload shapes or Worker Main ownership.
- Adding new Worker controls or weakening exact-turn fences.
