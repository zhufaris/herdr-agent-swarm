# Worker Answer Startup Race Design

## Goal

Prevent a newly dispatched Worker turn from being completed with an empty
Answer while TraeX is starting and has not yet emitted the exact transcript
turn identity.

The fix must preserve the existing safety rule: a prompt that may have reached
TraeX is never replayed automatically.

## Observed failure

A Worker turn can follow this sequence:

1. the durable queue accepts the turn and creates its rich-text Answer post;
2. the driver confirms dispatch and changes the turn to `running`;
3. before TraeX emits `task_started`, Herdr still reports the pane as `idle`;
4. `InstanceTurnSupervisor` sees a running turn without `runtimeTurnId` and
   immediately commits `completed-without-output`;
5. the rich-text post is delivered correctly, but its canonical Answer is
   empty and later transcript output can no longer attach to the terminal turn.

The production instance reproduced this sequence: the affected turn reached
`completed` about five seconds after acceptance, had no runtime turn identity,
and stored neither result text nor Answer timeline items. Rich-text create and
update effects were both delivered successfully.

## Selected behavior

Treat `running` or `blocked` without an exact runtime turn identity as a
dispatch-observation gap, not proof of completion.

- While the turn is inside a bounded startup observation window, an `idle` or
  `done` pane leaves the turn non-terminal so the transcript watcher can bind
  `task_started`.
- Once `runtimeTurnId` and `runtimeTurnStartedAt` are stored, the existing exact
  transcript recovery path remains authoritative.
- If the window expires without an exact identity, transition the turn to
  `dispatch-uncertain`, retaining an explicit notice and never replaying the
  prompt.
- A pane reported as `working` or `blocked` continues to update the visible
  phase as it does today.
- Missing or mismatched pane identity continues to terminate the Worker session;
  this design does not weaken runtime fencing.

The observation window is 15 seconds and uses a named policy constant in the
Worker supervision domain rather than an operator configuration knob. It exists
to absorb a local handoff race, not to tune normal execution latency.

## Boundaries

`InstanceTurnSupervisor` owns the decision because it is the component that
combines durable turn state with the observed Herdr pane state. Transcript
parsing, rich-text rendering, outbox delivery, and SQLite Answer projection do
not change.

The supervisor derives elapsed time from the Worker card's durable `startedAt`
timestamp, which is set once when dispatch enters `running`, and an injected
clock. Tests can therefore exercise both sides of the window deterministically
without sleeping. If a legacy/headless turn has no Worker card or `startedAt`,
the existing conservative recovery behavior remains unchanged.

## Recovery and safety

- No prompt is submitted or replayed by the supervisor.
- A service restart does not reset the window because the timestamp is durable.
- An exact transcript identity always takes precedence over pane-idle inference.
- After expiry, `dispatch-uncertain` remains observable and recoverable without
  claiming that the Worker completed successfully.
- Existing Answer content is retained if output arrived before the observation
  gap.

## Verification

Add focused `InstanceTurnSupervisor` tests for:

1. a freshly running turn, no runtime identity, and an idle pane remains
   non-terminal during the startup window;
2. the same state transitions to `dispatch-uncertain` after the window;
3. a turn with an exact runtime identity still uses transcript recovery;
4. working, blocked, missing, and mismatched pane behavior remains unchanged;
5. the regression path does not enqueue or resubmit a prompt.

Then run the focused supervisor and Worker Answer tests, `npm run typecheck`,
`npm run build`, and the full Vitest suite because the change touches recovery
and shared Worker lifecycle behavior.
