# TraeX Herdr Socket RPC Design

## Status

Approved. The bridge must continue to launch and control the configured `traex`
executable. TraeX is compatible with Herdr's Codex Agent detection protocol, but
the bridge must not replace it with the separate `codex` executable.

## Goals

- Keep `TRAEX_BIN` and `pane run <pane> <traex> --permission-mode ...` as the
  process-launch authority.
- Reuse one Herdr Unix Socket connection for native request/response operations
  and event subscriptions, with the CLI adapter as a compatibility fallback.
- Drive normal Agent lifecycle observation from native state and output revision,
  while retaining bounded terminal reads for answer content and TraeX-only UI.
- Preserve FIFO, steering, uncertain-dispatch/no-replay, local approval, SQLite
  durability, and periodic snapshot convergence.

## Non-goals

- Do not launch the official `codex` executable through `agent start --kind codex`.
- Do not treat `agent_session` as a transcript or message API.
- Do not remove terminal parsing for answers, model/mode selectors, prompt echo,
  approval details, or unknown-state recovery.
- Do not make Socket availability a readiness requirement.

## Architecture

Replace the event-only Socket subscriber with a process-owned `HerdrSocketClient`.
It owns one persistent newline-delimited event connection plus one short-lived
connection per RPC and dispatches validated subscription events. The Herdr
adapter receives an optional native client and prefers it for supported
operations.

```text
workflows -> HerdrPort -> Herdr adapter -> HerdrSocketClient -> Herdr server
                                  \----> CLI command runner (fallback)

HerdrSocketClient events -> coalesced reconciliation -> authoritative snapshot
```

This phase enables `session.snapshot`, `agent.read`, `pane.process_info`, and
`pane.wait_for_output`. Prompt submission and topology/control commands remain
CLI-backed until they have an independently tested migration. The client owns a persistent event-stream connection and one
short-lived connection per RPC because Herdr 0.7.5 dedicates a connection after
`events.subscribe` and closes an RPC connection after one response. Request IDs
remain opaque correlation keys and responses are never interpreted as events.

## Connection and fallback semantics

The client validates protocol frames, bounds buffered bytes and frames processed
per tick, coalesces event delivery, and reconnects with exponential backoff. Each
pending request has a timeout and is rejected when its connection closes. A new
connection resubscribes and requests reconciliation before being considered
converged.

Read-only operations fall back to the CLI when the Socket is absent, disconnected,
unsupported, or fails before a response. Mutating operations have stricter rules:

- before the request bytes are written, CLI fallback is safe;
- after `agent.prompt` bytes are written, disconnect or timeout is potentially
  dispatched and must enter the existing detached/no-replay path;
- no automatic CLI retry may follow an uncertain native prompt submission.

`pane run` remains the only TraeX startup path. After launch, the adapter waits for
Herdr's Codex-compatible detection and structured ready state.

## Runtime observation

`session.snapshot` remains the convergence source. `pane.agent_status_changed` is
an immediate wake-up, while periodic reconciliation repairs missed events. The
observer tracks `{terminalId, stateChangeSeq, outputRevision}` per Pane:

- a new terminal identity resets both sequence baselines;
- an equal or lower non-null `stateChangeSeq` cannot regress a projected state;
- terminal content is read only when `outputRevision` changes, structured state is
  unknown, or a final answer must be captured;
- a revision is consumed only after the corresponding read/projection succeeds.

`agent.wait` may provide an efficient wake-up for startup and detached observers,
but it does not own turn identity and cannot replace durable dispatch checkpoints.
The observer must see an active state for the submitted turn before accepting a
settled state, except in the existing explicitly safe unknown-state fallback.

Snapshot parsing also preserves `foreground_cwd`. Project discovery continues to
require the registered workspace and canonical Pane cwd. `foreground_cwd` is only
supporting evidence and diagnostics; disagreement never broadens routing.

## Terminal-content operations

For a detected Agent, reads prefer `agent.read`; `agent_not_found` falls back to
`pane.read`. Both remain bounded terminal snapshots and pass through the existing
redaction and parsing pipeline.

Known UI waits use native `pane.wait_for_output` before a bounded read:

- model selector marker;
- mode selector marker;
- fallback prompt echo.

Timeout, unsupported-method, or unknown UI behavior falls back to the current
bounded polling implementation. Dynamic prompt text must not be logged or exposed
in errors. Approval continues to be local-only.

## Compatibility and rollout

When `HERDR_SOCKET_PATH` is absent, the existing CLI behavior remains available.
When the installed schema lacks a method, the adapter records that capability as
unsupported for the current connection and uses the CLI path. Runtime health
reports Socket connectivity and fallback counts, but readiness depends on whether
Herdr is usable through either transport.

The migration remains incremental: this phase provides snapshot, Agent read,
process-info, event wake-ups, and output-match waits. Existing CLI behavior stays
behind the same `HerdrPort`, so workflows do not depend on transport details.

## Testing and acceptance

- Socket unit tests cover fragmented and batched frames, response correlation,
  concurrent requests, timeouts, disconnect rejection, reconnect, event delivery,
  frame limits, and clean shutdown.
- Adapter tests prove that the configured TraeX executable is still launched,
  native read-only failures fall back to CLI, and uncertain native prompt writes
  never retry or replay.
- Observer tests cover state-sequence deduplication, terminal identity reset,
  revision-gated reads, and retry after a failed read.
- Model/mode and prompt tests cover native output-match success and polling fallback.
- Existing concurrency, steering, recovery, SQLite, outbox, and CardKit tests remain
  green, followed by typecheck and build.
- Operational verification checks build identity, plugin restart, readiness, Socket
  connection, native request traffic, and confirms the Pane foreground executable
  is `traex`.
