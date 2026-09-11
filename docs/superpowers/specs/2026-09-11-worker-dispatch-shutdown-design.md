# Worker Dispatch Shutdown Design

## Goal

Make Worker dispatch shutdown prove that the Agent driver call and its exact-turn
transcript watcher have both settled before SQLite ownership can be released. A
shutdown deadline may detach observation safely, but it cannot make outstanding
writer code disappear by declaration.

## Decision

Extend `AgentRuntimeDriver.submit` with an optional `AbortSignal`. The TraeX and
terminal Agent drivers pass it to the existing abort-aware Herdr prompt path.
`InstanceWorkScheduler` owns one `AbortController` per in-flight turn alongside
its turn/generation fence.

During normal shutdown the scheduler first allows active drains to finish within
the shared deadline. When that deadline expires, it atomically marks each still
active turn `dispatch-uncertain`, records the no-replay notice, and aborts its
driver wait. It then continues awaiting the drain. The drain's existing detached
guard prevents a late receipt from changing the terminalized uncertainty and
stops/drains the local transcript watch before settling.

If a custom driver ignores cancellation, scheduler stop remains pending. The
outer `BridgeRuntimeShutdown` final allowance then returns `ownership_retained`
and keeps the write fence, lease, and SQLite connection owned.

## Safety properties

- Abort cancels Bridge-side waiting; it does not submit a new prompt or issue a
  remote Agent interrupt.
- A prompt that may have reached an Agent is marked uncertain and never replayed.
- The local transcript watcher is part of the same drain lifetime, including its
  final store access.
- A late driver receipt cannot overwrite the durable uncertain state.
- Cleanly cancellable drivers allow ordinary shutdown to complete.

## Verification

Tests use a structured driver blocked on the supplied signal and a watcher whose
`stop()` touches the store. They assert cancellation is delivered, uncertainty is
persisted before ownership release, watcher cleanup finishes before scheduler
stop returns, and no later store access occurs. A separate unabortable driver test
integrates with `BridgeRuntimeShutdown` and asserts `ownership_retained`. Existing
driver receipt, no-replay, and observer tests remain green.

The final gate is focused Agent-driver, instance-scheduler, and runtime-shutdown
suites, typecheck, build, architecture checks, full Vitest, and `git diff --check`.

## Non-goals

- Sending Escape or another destructive control to the Agent during shutdown.
- Treating cancellation as proof the prompt never started.
- Changing normal turn timeout values.
- Installing or restarting the service.
