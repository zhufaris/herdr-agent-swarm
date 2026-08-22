# TraeX approval lifecycle design

## Goal

When a bridge-managed TraeX turn requires terminal approval, Lark must show the
blocked state promptly without allowing Lark to approve or bypass the action.
The current prompt remains active, and later prompts for the same binding remain
queued until the approval is resolved and the active turn finishes.

## Current failure

The bridge submits prompts by writing into the TraeX pane, then infers turn
completion from terminal text. That polling path does not inspect Herdr's
structured `agent_status`. A pane can therefore report `blocked` while the
bridge continues waiting until `TURN_TIMEOUT_MS`, eventually reporting a
timeout instead of an approval request.

Returning immediately from `runPrompt()` on `blocked` is also unsafe with the
current FIFO worker. The worker would finish the prompt and send the next
queued text while TraeX still displays its approval interface.

## Design

### Adapter contract

`HerdrPort.runPrompt()` accepts an optional state observer for intermediate
agent-state changes. The adapter continues to own the whole turn from prompt
submission through its terminal state.

During each polling cycle, the CLI adapter reads both:

- the pane's structured `agent_status`; and
- recent terminal output used for completion and answer extraction.

When the structured state changes to `working` or `blocked`, the adapter invokes
the observer once for that transition. A `blocked` state is intermediate: the
method does not return and does not submit more input. It keeps polling until
the same TraeX turn resumes and reaches `done` or `idle`. The method then returns
`done`. If the deadline expires while blocked or working, it throws the existing
turn-timeout error.

The terminal working marker remains a compatibility fallback when Herdr reports
`unknown`, but structured state takes precedence.

### Coordinator behavior

The coordinator passes an observer to `runPrompt()`. Each observed transition
updates the binding and publishes `AgentStateChanged`. A blocked event therefore
projects the existing orange approval card to Lark immediately.

The worker continues awaiting the same `runPrompt()` promise while approval is
pending. Because each binding has one drain worker, later prompts stay queued and
cannot be typed into the approval interface. Once the active turn completes, the
coordinator publishes the answer and proceeds with the FIFO normally.

The old branch that treats a returned `blocked` value as a completed failed job
is removed. `blocked` is not a terminal prompt outcome.

### Safety boundary

- TraeX continues to start with `--permission-mode auto`.
- Lark receives status only; it gains no approval action.
- `bypass_permissions`, `danger-full-access`, and similar modes remain prohibited.
- Approval is performed only in the corresponding Herdr pane.
- A turn that is never approved is bounded by `TURN_TIMEOUT_MS` and fails without
  sending later queued prompts into the pane.

## Failure and recovery behavior

- A transient pane-status read failure does not falsely complete the turn; the
  adapter can continue using terminal evidence until the next poll.
- A missing pane or command failure follows the existing turn failure path.
- If the bridge process restarts during an approval, the running prompt follows
  the existing restart policy and is marked failed rather than replayed. The
  user must resend it after inspecting the pane. Durable mid-turn recovery is
  outside this change.
- Agent-state observations are deduplicated so polling does not produce repeated
  blocked card updates.

## Tests and acceptance criteria

Automated coverage must demonstrate:

1. The CLI adapter observes structured `blocked` state before the timeout and
   does not resolve the turn at that point.
2. After a simulated approval changes the pane from `blocked` to `working` and
   then `done` or `idle`, the original `runPrompt()` resolves successfully.
3. The coordinator publishes the blocked state and the rendered Lark card tells
   the user to approve in Herdr.
4. A second prompt for the same binding remains queued while the first turn is
   blocked and runs only after the first turn finishes.
5. A blocked turn that exceeds `TURN_TIMEOUT_MS` fails without dispatching the
   next queued prompt during the blocked interval.
6. Normal turns without approval retain their existing behavior.

Live validation must retain a healthy bridge (`/health`) and ready Lark/Herdr
dependencies (`/ready`). A real high-risk operation is not required for automated
verification and must not be approved remotely.
