# Bridge-Owned TraeX Session Identity Design

## Goal

Make a bridge-created TraeX Pane eligible for typed JSONL output without
depending on Herdr to project a custom TraeX `agent_session`.

## Authority and trust boundary

Herdr remains authoritative for Pane identity, terminal identity, foreground
runtime, and reconciliation. SQLite records the exact TraeX SessionStart UUID
as a bridge-owned workflow fact. The UUID is not represented as a Herdr-native
agent session and Lark never receives it.

The bridge starts a private Unix-domain socket before it creates any Pane. Each
bridge-created Pane receives four process-local environment values: the socket
path, a fresh per-process capability token, its binding ID, and its binding
generation. The injected SessionStart hook sends only a bounded JSON line with
the current Pane ID, those binding coordinates, the exact UUID, and the
SessionStart source. The socket accepts no prompt or transcript content.

The receiver requires a valid capability token, bounded payload, UUID-shaped
session ID, and current binding/pane/generation match. SQLite accepts the
report only for a non-archived bridge binding and only if it is the first UUID
or an idempotent repeat of the same UUID. A different UUID cannot overwrite a
bound transcript identity. Invalid, stale, duplicate, and rejected reports do
not affect prompt dispatch.

Only `startup` and `resume` SessionStart events are accepted. A local TraeX
`/clear` is deliberately not a bridge session transition: it cannot replace
the persisted UUID. Users create a new bridge-owned session with `/swarm
reset`, which advances the binding lifecycle and provisions a new Pane.

## Persistence and transcript selection

Bindings gain `reported_traex_session_id` and
`reported_traex_session_at`. These are bridge provenance fields distinct from
the existing `agent_session_*` columns, which remain Herdr observations.

Before dispatch, `PromptRunWorkflow` prefers the bridge-reported UUID. It
constructs a typed TraeX identity only for the transcript reader; the reader
still requires one exact `*-<uuid>.jsonl` file and an equal
`session_meta.payload.id`. It never uses cwd, time, title, or newest-file
discovery. Existing bindings with no direct UUID retain the existing terminal
fallback; a validated native Herdr identity remains a compatibility fallback
for panes not created by this path.

## Lifecycle, failure, and rollout

The private socket starts after this instance has acquired the SQLite write
fence and closes before SQLite ownership is released. A service restart creates a new capability token; a
previous process cannot write a new report. Existing panes do not receive a
new token and remain safely in terminal mode until explicitly reset or
recreated. A reporter failure is best-effort and never blocks TraeX startup or
replays a prompt.

The command boundary redacts the capability from Pane-creation failures. The
reporter tracks accepted sockets, stops accepting new connections, destroys
partial or idle clients during shutdown, and settles before the write fence,
lease, or SQLite store is released.

Only metadata-safe structured diagnostics are emitted: outcome, binding ID,
and Pane ID. They exclude the UUID, token, prompt, and transcript content.

## Verification

- reporter tests cover required capability-bound environment, valid wire
  payload, and malformed payload drop behavior;
- socket tests cover token rejection, binding/pane/generation mismatch,
  idempotent reports, bounded input, and shutdown with a partial client;
- command error tests prove the capability is absent from error fields;
- hook tests prove `clear` reports are ignored and only startup/resume are
  configured;
- SQLite tests cover atomic first-write, idempotence, and conflicting UUID
  rejection;
- workflow tests cover direct identity preference and strict transcript
  validation; and
- a rebuilt managed service plus a fresh bridge-created binding confirms that
  SQLite records an exact UUID and the next answer selects typed JSONL mode.
