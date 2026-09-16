# TraeX Native Herdr Agent Prompt

## Problem

The bridge currently has two prompt-submission mechanisms. `runPrompt` prefers
Herdr's Agent surface but falls back to raw Pane input, while `runManagedPrompt`
always sends text through the Pane and confirms it by parsing the TraeX
composer. Runtime drivers prefer `runManagedPrompt`, so even Agents created and
recognized by Herdr bypass `herdr agent prompt`.

That makes the bridge responsible for interpreting prompt markers, wrapped
composer lines, status separators, existing drafts, and Enter behavior. These
details belong to Herdr's Agent integration. A false terminal interpretation can
cross the durable dispatch boundary even though the requested prompt was not
submitted.

the then-supported Herdr release does not accept `herdr agent start --kind traex`; the supported kind
list has no `traex` value. It can, however, recognize the installed TraeX TUI as
a Codex-compatible Agent after TraeX is launched with `herdr pane run`. This
mapping is already represented by `matchesHerdrAgentKind("traex", "codex")`.

## Decision

Use a strict native Agent path for prompt submission.

- Continue launching TraeX with the configured `TRAEX_BIN` through `herdr pane
  run`; do not substitute the separate `codex` executable.
- Treat a TraeX runtime as ready only after Herdr reports the same Pane as
  `agent="codex"` or a future native `agent="traex"`, with state `idle` or
  `done`.
- Submit ordinary turns only through `herdr agent prompt`.
- Do not fall back from `agent_not_found` or `agent_not_ready` to `pane
  send-text` or `pane send-keys`.
- If Herdr does not detect the launched TraeX process before the startup
  deadline, keep the instance unavailable and surface a bounded degraded or
  not-ready reason. No prompt is sent.
- Preserve `agent_prompt_stalled` as potentially dispatched. The durable turn
  observer detaches and the prompt is never replayed automatically.

The bridge's product-level Agent kind remains `traex`. `codex` is only the
Herdr compatibility identity used to validate and address the running process.
No synthetic Herdr kind or local patch to the Herdr binary is introduced.

## Submission and lifecycle flow

```text
allocate Pane
  -> pane run TRAEX_BIN ...
  -> wait for Herdr snapshot: same Pane + compatible Agent kind + idle/done
  -> mark runtime ready
  -> herdr agent prompt <pane> <text>
  -> persist dispatch receipt
  -> observe structured Agent state and state_change_seq
  -> read the validated TraeX JSONL transcript for Answer content
```

Herdr owns terminal input encoding, bracketed paste, blocked-state validation,
Enter submission, and Agent lifecycle classification. SQLite remains the source
of truth for prompt ownership, dispatch checkpointing, no-replay recovery, and
visible projections. The validated TraeX transcript remains the only Answer
content source.

## Failure semantics

The adapter maps submission outcomes without retrying a mutating operation:

| Herdr outcome | Bridge outcome | Replay policy |
| --- | --- | --- |
| Prompt command returns success | dispatched | never replay automatically |
| `agent_prompt_stalled` | delivery uncertain | detach and observe; never replay |
| `agent_not_found` | not delivered; runtime degraded/not ready | eligible only after a later explicit dispatch claim following recovery |
| `agent_not_ready` or `agent_blocked` before input | not delivered | retain or fail according to the owning workflow; do not use Pane input |
| transport failure after command start | delivery uncertain | detach and observe; never replay |
| transport failure before command start | not delivered | normal durable retry rules may apply |

The command runner's `onStarted` callback is a conservative uncertainty
boundary, not proof that Herdr accepted the prompt. After the CLI process starts,
an unknown timeout, signal, or transport failure is treated as potentially
dispatched. Only Herdr's explicit pre-input rejections (`agent_not_found`,
`agent_not_ready`, or `agent_blocked`) remain safely not delivered. Error
classification must not turn any other command that may have started into a safe
retry.

## Steering and interactive controls

Raw terminal steering is disabled as part of this change. the then-supported Herdr release has no
separate structured steering transaction, and using `agent prompt` while an
Agent is already working does not identify which turn receives the input. The
runtime reports steering as unsupported until Herdr exposes an operation with
explicit delivery semantics. Existing durable steering requests fail visibly and
are never converted into ordinary queued turns.

Interactive `/model` selection and local approval handling are outside this
change. Their existing terminal UI controls may remain temporarily because they
are explicit control operations rather than ordinary or steering prompt
dispatch. They must not be used as a fallback for a failed Agent prompt.

## Code boundaries

- `HerdrCliAdapter.startTraex` launches the configured executable and waits for
  compatible Herdr Agent detection instead of terminal composer readiness.
- `HerdrCliAdapter.runPrompt` is the only ordinary prompt-submission path and
  never calls `submitPromptText`.
- `TraexDriver` and `TerminalAgentDriver` call `runPrompt` directly;
  `runManagedPrompt` is removed from `HerdrPort` and its wrappers.
- Prompt-specific composer parsing, echo waits, and raw dispatch helpers are
  removed when no remaining control operation consumes them. Shared terminal
  parsing required by model selection or bounded diagnostics stays scoped to
  those operations.
- Driver capabilities report steering as `unsupported` wherever delivery would
  otherwise require raw Pane prompt injection.

## Compatibility and rollout

This change intentionally narrows compatibility. A Pane that runs TraeX but is
not recognized by Herdr is not dispatchable. Existing attached bindings and
instances may therefore become degraded until detection recovers or the Pane is
explicitly replaced/reset. The bridge does not mutate or restart such a Pane
automatically.

Before service restart, inspect active turns, queued prompts, instance turns, and
outbox state. Restart only through the supported plugin lifecycle after building
the committed revision. After restart, require readiness, matching build
identity, no unexpected prompt replay, and successful detection of a newly
started TraeX runtime as the Codex-compatible Herdr Agent.

## Testing

Adapter and driver tests must prove:

- TraeX startup waits for compatible `codex` detection and accepts `idle` or
  `done`;
- startup times out safely when only a TraeX foreground process is visible;
- ordinary TraeX, Codex, Claude, and Pi submissions call `agent prompt`;
- `agent_not_found`, `agent_not_ready`, and `agent_blocked` never invoke Pane
  text or key commands;
- `agent_prompt_stalled` and failures after process start are delivery-uncertain
  and never replayed;
- no runtime driver selects `runManagedPrompt`;
- TraeX steering reports unsupported and emits no terminal input;
- model-selection tests continue to cover the separately retained interactive
  control path.

Run the affected adapter, driver, instance-control, messaging, steering, and
model tests, followed by the full Vitest suite, `npm run typecheck`, and `npm run
build`. A configured non-mutating smoke must confirm Herdr detection before any
real prompt test is authorized.
