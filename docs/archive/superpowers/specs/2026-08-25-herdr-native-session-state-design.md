# Herdr Native Session State Design

## Status

Approved implementation direction. This specification incorporates the official
the then-supported Herdr release documentation while treating the installed the then-supported Herdr release schema as the
runtime compatibility baseline.

## Source-of-truth boundary

Herdr owns live Pane identity, terminal identity, detected Agent identity, Agent
lifecycle, output revision, and optional native Agent session reference. SQLite
continues to own binding generations, prompt FIFO, dispatch checkpoints, run-card
state, outbox intent, idempotency, and the instance lease. Terminal text is a
bounded content stream, not the normal lifecycle authority.

Herdr session persistence has four distinct meanings:

- detach/reattach retains the original PTY and process;
- snapshot restore rebuilds layout and cwd, but not arbitrary processes;
- experimental Pane history restores display text, not processes or workflow;
- native Agent restoration uses an official integration's `agent_session`
  reference to restart a supported Agent conversation.

Only the last item supplies an Agent session reference. It does not expose the
conversation transcript or establish which Lark prompt produced a response.

## Native event client

Add a process-owned Socket API subscriber over the newline-delimited JSON Unix
socket. The managed systemd unit receives `HERDR_SOCKET_PATH` from the plugin
action that installs, starts, or restarts it. The value is never hardcoded. If the
path is absent, the bridge runs in snapshot-only compatibility mode.

On each connection the subscriber sends one `events.subscribe` request for:

- `pane.created`, `pane.updated`, `pane.closed`, `pane.exited`, and `pane.moved`;
- `pane.agent_detected` and `pane.agent_status_changed`;
- `pane.agent_status_changed` is registered once per currently known Pane because
  the then-supported Herdr release does not support a wildcard subscription for this event.

the then-supported Herdr release emits `pane_output_changed` to plugin hooks but rejects
`pane.output_changed` as a Socket subscription type. The existing bounded UDP
plugin hook therefore remains the output-change wake-up source. Snapshot
`revision` suppresses unchanged terminal reads after either wake-up path.

Herdr uses dotted names in subscription requests. The subscriber accepts both
dotted and underscored event-envelope spellings used across the Socket and plugin
event surfaces. Every event is validated and reduced to bounded workspace/Pane
identities before entering the coordinator. Unknown, malformed, or unscoped
events request a full reconciliation.

The subscriber reconnects with bounded exponential backoff. Connection errors and
malformed frames are logged without failing readiness. A successful reconnect
requests reconciliation so `session.snapshot` repairs events missed while offline.
Periodic reconciliation remains enabled for the same reason.

Plugin UDP hooks remain as a compatibility wake-up path and are required for
output changes on the then-supported Herdr release. Duplicate Socket and UDP wake-ups are harmless
because reconciliation is coalesced and state transitions are idempotent.

## Snapshot and session model

`HerdrPane` gains optional `agentSession`:

```ts
interface HerdrAgentSession {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}
```

The parser accepts the field from Pane or Agent snapshot records and preserves it
without interpreting its value. `terminalId` remains the live PTY identity used by
existing binding fencing. The existing database field `traexSessionId` continues
to contain terminal identity in this change; renaming and migrating it is separate
work. An Agent session reference may survive a Herdr server restart while the
terminal identity changes, so it must not silently weaken current fencing. The
bridge learns a native session reference only when the binding has none and never
silently replaces a different persisted reference. A changed terminal ID is
accepted only when the complete persisted and observed references match.

## Runtime observation

Structured `agent_status` is authoritative whenever it is not `unknown`. The
snapshot's Agent kind is the primary evidence that TraeX/Codex occupies a Pane.
`pane process-info` is queried only when Agent detection is absent or unknown.
Terminal classification runs only after both structured sources are insufficient.

Turn observation tracks the last native `revision`. It reads terminal content
when the revision changes, when structured state is `unknown`, and once after
completion to extract the final answer. State transitions therefore do not depend
on text markers in the normal path, while CardKit streaming still receives answer
content.

`/model`, Mode selection, prompt echo confirmation, and approval-screen
classification continue to use bounded terminal reads. Herdr has no equivalent
structured API for these TraeX UI details.

Ordinary prompt submission prefers `herdr agent prompt`, which validates the
live Agent and rejects a blocked Agent before writing. The bridge still owns the
durable dispatch checkpoint and output streaming. In particular,
`agent_prompt_stalled` means Herdr sent the prompt but did not observe a lifecycle
change in time, so the bridge marks the prompt as possibly dispatched and detaches
its observer rather than replaying it. `agent wait` cannot replace the observation
loop because it does not provide incremental answer content. `agent read` and
`pane read` expose terminal text, not structured conversation messages.

## Failure and recovery semantics

- Socket unavailable: log degradation, continue CLI snapshot reconciliation, and
  reconnect in the background.
- Socket disconnect: discard partial frame, reconnect, then request convergence.
- Event burst: coalesce affected workspaces before reconciliation.
- Malformed/oversized frame: drop it and request full reconciliation.
- Herdr state `unknown`: use the existing bounded process and terminal evidence;
  insufficient evidence remains unknown and never dispatches queued work.
- Terminal read failure: lifecycle still follows known structured state; answer
  extraction falls back to the existing safe user message.
- Bridge or Herdr restart after prompt dispatch: observe the durable detached turn;
  never replay it. `agent_session` is supporting identity evidence only.

## Testing

Focused tests use a temporary Unix socket server to verify request framing, event
normalization, fragmented/multiple frames, targeted routing, reconnect, and clean
shutdown. Adapter tests verify optional `agent_session`, native Agent-kind
precedence, process fallback, revision-gated reads, and the existing unknown-state
fallback. Plugin lifecycle tests verify dynamic socket-path propagation.

Integration tests verify that duplicate Socket and UDP wake-ups converge through
one reconciliation path without duplicate workflow effects. Existing concurrency,
steering, detached recovery, model/mode, SQLite, and outbox tests remain green.

Operational verification builds the plugin, restarts the managed service, checks
health/readiness and bounded logs, and observes one real snapshot/event connection
without sending a Lark prompt.
