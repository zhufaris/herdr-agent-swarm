# TraeX Composer Readiness Design

## Problem

A newly created Herdr pane can report a foreground `traex` process before the TraeX terminal UI is ready. The bridge currently treats that process observation as successful runtime startup, activates the binding, and accepts the first prompt. Agent reconciliation then correctly keeps the binding at `unknown`, while the fail-closed queue worker refuses to dispatch. The prompt remains `queued/not_started` indefinitely.

The live reproduction is pane `wH:p1C`: Herdr reports `agent_status=unknown`, `process-info` reports the exact `traex` executable, terminal output is empty, and the first prompt remains at queue position 1.

## Decision

Provisioning uses a strict two-part readiness gate. A TraeX runtime is ready only when:

1. the exact foreground executable is `traex`; and
2. bounded terminal evidence shows the TraeX composer prompt.

Process existence alone means only that launch has started. It must not advance the binding from `pane_created` to `runtime_started`.

## Adapter Contract

`HerdrCliAdapter.startTraex()` keeps its current command responsibility but changes its completion condition:

- If TraeX is not running, launch it once.
- Poll both process metadata and the recent terminal tail.
- Return only when `isTraexComposerReady()` succeeds for an exact TraeX process.
- If the configured command timeout expires, throw a readiness-specific error naming the pane.
- Do not launch a second TraeX process merely because the first process has not rendered its composer yet.

Structured Herdr agent state remains useful for later turn observation, but it does not replace the startup gate. Startup always requires both the exact TraeX process and composer evidence. Empty or ambiguous terminal output fails closed.

## Provisioning and Recovery

The existing durable checkpoints remain unchanged:

- `pane_created`: Pane identity is persisted; TraeX readiness is not yet proven.
- `runtime_started`: Strict readiness has passed.
- `thread_created`: Lark topic exists.
- `activated`: Binding can consume prompts.

If readiness times out, provisioning stays at `pane_created`. Project-selection provisioning remains recoverable and can retry the same Pane without duplicating it or its topic. Direct `/herdr new` provisioning reports failure instead of activating a broken binding.

For an already activated legacy binding such as `wH:p1C`, reconciliation continues to probe only the bound Pane. If composer evidence later appears, it changes `unknown` to `idle` and wakes the queued FIFO. If the terminal stays empty, the bridge does not replay or dispatch the prompt. Operational recovery may restart that Pane's TraeX runtime once, after which the existing binding/topic and queued prompt are reused.

## Queue Safety

The existing worker guard remains authoritative: `working`, `blocked`, and `unknown` bindings cannot claim queued prompts. This design fixes the producer-side readiness boundary instead of weakening the guard. Already-dispatched prompts are never replayed automatically.

## Tests

Regression coverage must prove:

- an exact TraeX process with an empty terminal does not satisfy `startTraex()`;
- a running TraeX process is not launched twice while waiting for composer evidence;
- composer evidence completes startup;
- timeout produces a clear readiness error;
- provisioning does not transition beyond `pane_created` when readiness fails;
- retrying recoverable provisioning reuses the existing Pane and succeeds once composer evidence appears;
- once the recovered binding becomes `idle`, its queued FIFO is scheduled without replaying an already-dispatched prompt.

## Acceptance Criteria

- A newly created session cannot become active solely because a `traex` PID exists.
- A healthy new session reaches `idle` and dispatches its first queued prompt normally.
- A failed startup is explicit and recoverable rather than an indefinitely queued card.
- `wH:p1C` is recovered using its existing binding/topic, and its current queued job either starts exactly once or remains safely queued with an explicit readiness failure.
