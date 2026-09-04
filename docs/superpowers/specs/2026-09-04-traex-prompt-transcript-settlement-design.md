# TraeX Prompt Transcript Settlement Design

## Problem

Herdr 0.8.2 fixes TraeX prompt input corruption by sending pasted text and
Enter separately. A very short TraeX turn can nevertheless finish between
Herdr lifecycle observations. In that case, `herdr agent prompt --wait` sees
the same non-working state and `state_change_seq` for five seconds and returns
`agent_prompt_stalled`, even though TraeX accepted the prompt and produced a
complete answer.

Agent Swarm already treats this error as possibly dispatched and recovers the
answer from the exact TraeX transcript without replaying the prompt. Direct
callers of the installed TraeX shim still receive a false failure. This design
corrects that command result without weakening no-replay behavior or changing
ordinary Herdr/Codex commands.

## Decision

The installed shim will intercept the exact `agent prompt` command only when
the target is a shim-managed TraeX agent. It will delegate prompt submission to
the official Herdr binary exactly once. If Herdr succeeds, or returns an
explicit pre-dispatch error, the shim returns that result unchanged.

When official Herdr returns `agent_prompt_stalled`, the shim will use the
target's exact canonical TraeX session and a transcript cursor opened before
dispatch to determine whether a new turn belonging to this submission started.
It will never send the prompt again.

- A matching completed turn becomes a normal successful prompt result.
- A matching active turn is observed for the caller's remaining timeout and
  becomes successful only after it reaches a settled state.
- Missing, stale, malformed, ambiguous, or conflicting evidence preserves the
  original `agent_prompt_stalled` response.

This is a command-settlement adapter, not a second lifecycle authority. The
reporter continues to own only initial identity/metadata and does not parse
terminal output or synthesize working/idle transitions.

## Command Routing

The shim recognizes the existing Herdr grammar for:

```text
herdr agent prompt <target> <text> [--wait] [--until <state> ...] [--timeout <ms>]
```

Routing is fail-closed:

1. Resolve the target through official `agent get`.
2. Project it through the existing shim projection.
3. Use transcript settlement only when `display_agent=traex` and the projected
   session is `source=herdr-traex-shim`, `agent=traex`, `kind=id`.
4. Delegate native Codex, other agent kinds, unknown targets, malformed forms,
   global routing forms, and prompt calls without `--wait` unchanged.

The command parser retains the prompt text only long enough to delegate it.
Errors and logs must not expose it.

## Transcript Fence

Before invoking the mutating official command, the shim resolves exactly one
JSONL transcript for the canonical session ID, validates its `session_meta`
identity, and records an EOF byte cursor plus wall-clock dispatch boundary. If
that preparation is unavailable, the shim still delegates once but cannot
upgrade a later stalled result.

After `agent_prompt_stalled`, only complete newline-terminated records appended
after that cursor are considered. Settlement requires a fresh turn with:

- a canonical turn ID;
- a start timestamp at or after the bounded dispatch boundary;
- lifecycle records attributable to that same turn; and
- no competing fresh turn that makes ownership ambiguous.

The existing transcript parsing vocabulary is reused rather than introducing a
second interpretation of TraeX JSONL. Terminal scrollback, visible composer
text, answer text equality, and Lark state are never proof of delivery.

## Result Semantics

For a proven turn, the shim emits the same JSON envelope shape as a successful
official `agent prompt --wait`, with the projected TraeX agent identity and the
settled agent status. The result must remain consumable by `HerdrCliAdapter` and
ordinary CLI users.

The shim respects the original timeout budget. The five seconds already spent
inside official Herdr count against that budget. If no caller timeout was
provided, transcript observation follows Herdr's unbounded settled-state wait
semantics after a fresh active turn has been proven. Abort, process exit,
session change, transcript replacement, or malformed records fail closed to the
original stalled result.

`--until` remains authoritative. A completed transcript turn can settle the
default idle/done wait. If the caller requested a state that transcript
completion cannot faithfully represent, the shim preserves the stalled result
rather than manufacturing a match. Blocked-state settlement remains owned by
Herdr's structured lifecycle.

## Failure and Replay Safety

- The official prompt command is invoked at most once.
- No transcript outcome makes a failed submission eligible for automatic retry.
- Explicit `agent_not_found`, `agent_not_ready`, and `agent_blocked` errors pass
  through unchanged.
- Transport failures and errors other than `agent_prompt_stalled` pass through
  unchanged because delivery may already be uncertain.
- A session identity change invalidates settlement evidence.
- Old transcript turns cannot satisfy a new command.
- If the shim process exits during settlement, Agent Swarm's existing
  dispatched/detached recovery remains the durable safety net.

## Code Boundaries

- `src/runtime/herdr-traex-shim.ts` owns exact command parsing, routing, and the
  pure settlement decision.
- A focused runtime module reuses the existing transcript parser/cursor
  contracts to open and observe one exact session without depending on SQLite.
- `src/cli/herdr-traex-shim.ts` performs official Herdr invocation and bounded
  filesystem observation.
- The command wrapper continues to delegate all unrelated commands.
- `HerdrCliAdapter` and coordinator no-replay behavior remain unchanged.
- The reporter remains process-fenced identity/metadata infrastructure and is
  not expanded into a lifecycle polling loop.

## Verification

Add a deterministic shim-level regression harness that invokes one fake
official Herdr prompt and appends controlled transcript records. It must prove:

- a fresh completed short turn converts stalled to success;
- a fresh active turn followed by completion converts stalled to success;
- no fresh turn preserves stalled;
- an old, malformed, ambiguous, or wrong-session turn preserves stalled;
- explicit pre-dispatch and unrelated errors are unchanged;
- prompt submission occurs exactly once in every case;
- native Codex and non-wait prompt commands remain delegated unchanged; and
- prompt text is absent from emitted errors and diagnostic output.

Run the focused shim and transcript tests, `npm run typecheck`, `npm run build`,
and the full Vitest suite. Install the resulting immutable shim release, then
perform an isolated live smoke in a newly created disposable pane. A short
fixed-answer TraeX turn must return success from `herdr agent prompt --wait`,
produce the expected transcript answer, contain no terminal control-sequence
pollution, and be submitted only once. Close only that disposable pane after
verification.
