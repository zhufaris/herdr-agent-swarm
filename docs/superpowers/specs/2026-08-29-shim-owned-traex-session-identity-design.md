# Shim-Owned TraeX Session Identity Design

## Goal

Make Herdr the only live authority for a TraeX conversation identity. The
installed TraeX shim captures the UUID emitted by the TraeX `SessionStart` hook
and reports it as the pane's native Agent session. Agent Swarm persists that
identity from Herdr reconciliation and uses it to open the exact TraeX JSONL
transcript.

Remove the bridge-owned SessionStart socket, reporter process, environment
capability, and `reported_traex_session_*` persistence without a compatibility
fallback.

## Current problem

The bridge currently injects its own `SessionStart` hook when it starts TraeX.
That hook sends the session UUID over a private Unix socket and stores it in a
second pair of binding columns. The bridge then prefers this bridge-owned value
over Herdr's native `agent_session`.

This duplicates runtime identity ownership and creates a startup race. A live
pane can have a valid `TRAECLI_THREAD_ID` and JSONL file while the socket report
is absent, leaving SQLite without a usable transcript identity. The hook
entrypoint also intentionally suppresses errors, making that divergence hard to
diagnose.

Herdr 0.7.5 already accepts `--agent-session-id` on `pane report-agent`, and its
snapshots expose the result as `agent_session`. The shim already owns TraeX
startup and lifecycle reporting, so it is the correct integration boundary.

## Chosen architecture

The shim installs one self-contained TraeX hook reporter and injects all three
hooks during managed startup:

- `SessionStart` validates the TraeX session UUID and reports `idle` plus
  `--agent-session-id <uuid>` to official Herdr.
- `UserPromptSubmit` reports `working`.
- `Stop` reports `idle`.

All reports use the existing process-scoped authority:

```text
source = herdr-traex-shim
agent  = codex              # Herdr's internal compatible protocol kind
display_agent = traex       # external projection owned by the shim
agent_session.agent = traex # normalized by the bridge at its adapter boundary
agent_session.kind  = id
agent_session.value = <TraeX session UUID>
```

The bridge does not install lifecycle hooks, run a session-report socket, or
accept a session identity directly from a pane. It starts TraeX through the shim,
observes Herdr, stores `agent_session_*` with the binding, and opens the
transcript by that identity.

## Why this approach

Three approaches were considered:

1. Keep the bridge socket as a fallback. This preserves two authorities and the
   failure mode that motivated the change, so it is rejected.
2. Let the shim write Agent Swarm SQLite directly. This couples a host-level
   compatibility tool to one application's schema, lease, and generation rules,
   so it is rejected.
3. Report the native session through Herdr and let normal reconciliation persist
   it. This preserves the documented authority boundary and works for every
   Herdr consumer, so it is selected.

## Shim session reporting

The hook parser accepts at most 64 KiB of JSON and requires:

- `HERDR_ENV=1`;
- a valid `HERDR_PANE_ID`;
- an absolute installer-provided official Herdr executable;
- `hook_event_name=SessionStart`;
- a UUID-shaped `session_id`;
- `source` absent, `startup`, or `resume`.

It invokes the official binary with an argv array, never a shell-interpolated
command:

```text
pane report-agent <pane-id>
  --source herdr-traex-shim
  --agent codex
  --state idle
  --seq <monotonic-sequence>
  --agent-session-id <session-id>
```

The reporter never logs hook input, prompt content, or session transcript data.
Invalid input and Herdr command failure cause the hook command to fail visibly to
TraeX's hook diagnostics, but do not terminate the TraeX process.

The installed shim release must contain the hook CLI and its complete local
JavaScript import closure. Installation validation checks that the installed
official Herdr supports `--agent-session-id`. The release remains independent of
repository `node_modules`.

## Herdr adapter normalization

Herdr internally tracks the shim as the compatible `codex` protocol kind while
the shim marks it with `display_agent=traex`. When such a record carries an
`agent_session`, the adapter normalizes only the session's agent label from
`codex` to `traex`. It preserves source, kind, and value exactly. Unmarked Codex
agents are never rewritten.

Both `agent get` and workspace snapshot parsing use this same normalization so
provisioning, reconciliation, recovery, and transcript selection cannot disagree.

## Persistence cleanup

The binding model retains the canonical fields:

- `agent_session_source`;
- `agent_session_agent`;
- `agent_session_kind`;
- `agent_session_value`.

The following bridge-owned surface is removed:

- `reported_traex_session_id`;
- `reported_traex_session_at`;
- `recordReportedTraexSession`;
- `TraexSessionReporter`;
- `report-traex-session` CLI;
- `HERDR_BRIDGE_SESSION_SOCKET`;
- `HERDR_BRIDGE_SESSION_CAPABILITY`;
- binding/generation environment used only by that reporter.

SQLite migration transactionally drops the two obsolete, unreferenced columns
while preserving every canonical column, index, foreign key, and row. The
migration is idempotent: databases that never had the legacy columns are left
unchanged. It does not infer or backfill a canonical identity from the old
columns, because that would promote a non-Herdr source after the clean cut. Live
bindings acquire identity from their next authoritative Herdr snapshot.

## Transcript lookup and turn behavior

`PromptRunWorkflow` passes only the binding's canonical Herdr session reference
to `TraexTranscriptReader`. The existing reader safety rules remain:

- agent must be `traex`;
- kind must be `id`;
- value must be a UUID;
- the path must remain under the configured sessions root;
- the filename must end in `-<session-id>.jsonl`;
- `session_meta.payload.id` must equal the session ID;
- ambiguous or invalid matches are rejected.

The first-turn bounded identity grace remains, but it polls only
`agentSessionValue`. Missing identity or transcript never causes prompt replay.
It produces the existing structured-output-unavailable behavior.

## Recovery and consistency

Session identity is fenced by pane and binding generation through normal Herdr
reconciliation. A changed native session on an attached binding is treated as an
identity mismatch; it is not silently adopted while a turn may have been
delivered. A new or replacement pane persists the session observed for that pane.

The shim's detached process reporter remains fenced by executable path, PID, and
process start ticks. When the TraeX process exits, it releases its scoped agent
authority and metadata. Herdr then removes the session reference with that
authority; SQLite converges through the existing reconciliation rules.

No code reads `TRAECLI_THREAD_ID` from `/proc` or scans the sessions directory to
guess the newest transcript. The UUID comes only from TraeX's typed SessionStart
event.

## Delivery batches

### Batch 1: Shim-owned native session identity

Extend the shim hook reporter, startup arguments, installed release closure, and
focused tests. Verify that a fresh managed pane exposes the exact session UUID in
Herdr `agent_session` and that the matching JSONL can be opened.

### Batch 2: Bridge clean cut and schema convergence

Remove the bridge socket reporter, hook injection, legacy model/store fields, and
tests. Add the transactional schema rebuild and switch transcript selection to
canonical `agent_session_*` only.

### Batch 3: Recovery, operations, and deployment validation

Exercise startup, resume, replacement-pane, missing-session, mismatched-session,
and service-restart paths. Update architecture and operator docs, run the full
suite, build and install the shim, restart through the normal safety gate, and
verify readiness plus a real non-destructive transcript observation.

Each batch is independently reviewed, tested, and committed. Existing unrelated
worktree changes are preserved and excluded from these commits.

## Verification

Focused tests must cover:

- bounded SessionStart parsing and exact `report-agent` argv;
- startup injection of the shim-owned hook and absence of the bridge reporter;
- installed-release completeness and `--agent-session-id` capability validation;
- snapshot and `agent get` normalization for marked TraeX sessions;
- no rewriting of ordinary Codex sessions;
- canonical session persistence during provisioning and reconciliation;
- transactional migration from a database containing the old columns;
- transcript opening and first-turn delayed identity acquisition using only the
  canonical session;
- mismatch fencing, restart recovery, and no prompt replay.

Before deployment, run the affected Vitest files, `npm test`,
`npm run typecheck`, `npm run build`, and `git diff --check`. Then install the
new shim release, restart the managed service without bypassing its safety gate,
and verify `/ready`, matching build identity, zero failed prompts, zero stalled
outbox lanes, a Herdr snapshot containing the session UUID, and successful
bounded reading of its exact JSONL. No synthetic Lark message is sent merely for
validation.

## Non-goals

- Keeping any bridge-owned SessionStart compatibility path.
- Teaching the shim about SQLite, bindings, Lark, or prompt IDs.
- Guessing sessions from process environment or newest-file ordering.
- Changing transcript content parsing, CardKit pagination, queue semantics, or
  approval handling.
- Replaying a prompt when identity or transcript observation is uncertain.
