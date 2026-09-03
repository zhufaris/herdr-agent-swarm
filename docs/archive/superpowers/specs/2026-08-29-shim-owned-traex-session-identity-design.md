# Shim-Owned TraeX Session Identity Design

## Goal

Make Herdr the only live authority for a TraeX conversation identity. The
installed TraeX shim generates a launch correlation UUID before process launch,
supplies it to TraeX through the legacy `--session-id` naming option, resolves
TraeX's canonical thread ID from its process registry, and reports that canonical
ID as the pane's native Agent session. Agent Swarm persists the identity from
Herdr reconciliation and uses it to open the exact TraeX JSONL transcript.

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

Herdr 0.7.5 accepts session identity through the dedicated
`pane report-agent-session` command. Live verification exposed an additional
authority rule: Herdr acknowledges an arbitrary source with `ok`, but only an
installed integration source such as `herdr:codex` becomes the pane's projected
`agent_session`. The shim owns TraeX startup and invokes the compatible Codex
protocol, so it reports session identity through that trusted integration source
while retaining its own source for process state and display metadata.

## Chosen architecture

The shim generates one correlation UUID per managed start:

- `--session-id <uuid>` gives the TraeX process a unique thread name that can
  be correlated with its canonical thread ID.
- The process-fenced reporter reports initial `idle` under its own state
  authority and reports the UUID separately through Herdr's trusted Codex
  session authority.

All reports use the existing process-scoped authority:

```text
state.source = herdr-traex-shim
state.agent  = codex              # shim-owned process lifecycle authority
display_agent = traex             # external projection owned by the shim
agent_session.source = herdr:codex # trusted built-in session authority
agent_session.agent = traex       # normalized by the bridge adapter
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
3. Generate the UUID in the shim, pass it independently to TraeX and Herdr, and
   let normal reconciliation persist it. This avoids startup-hook trust ordering,
   preserves the authority boundary, and works for every Herdr consumer, so it
   is selected.

## Shim launch correlation and canonical identity

Before launching TraeX, the shim generates a lowercase launch correlation UUID
with `crypto.randomUUID()`. TraeX 0.201.6 documents `--session-id` as a legacy
session selection or naming option; live validation proves it becomes
`threadName`, while TraeX independently generates the canonical `threadId`
stored in `session_meta.payload.id` and the JSONL filename. The shim rejects
caller-supplied `--session-id`, `--resume`, or equivalent
`--option=value` arguments so one managed start cannot have competing
correlation sources. It writes the launch request with:

```text
traex
  --session-id <uuid>
  <caller arguments>
```

After the exact TraeX process is observed and fenced by executable path, PID,
and process start ticks, the detached reporter waits a bounded interval for one
TraeX `session-peers` record satisfying all of these conditions:

- a regular, non-symlink file no larger than 4 KiB;
- `protocolVersion === 1` and `location === `local``;
- `pid` equals the fenced TraeX PID;
- `threadName` equals the generated launch correlation UUID;
- `threadId` is a UUID and the filename equals that UUID without hyphens plus
  `.json`.

The directory scan is capped at 10,000 entries and the wait at 10 seconds. Zero,
multiple, malformed, oversized, or changing matches fail closed. No newest-file
ordering is used. The reporter rechecks the pane process identity before
publishing the resolved canonical `threadId` through separate Herdr argv arrays:

```text
pane report-agent <pane-id>
  --source herdr-traex-shim
  --agent codex
  --state idle
  --seq <monotonic-sequence>

pane report-agent-session <pane-id>
  --source herdr:codex
  --agent codex
  --seq <monotonic-sequence>
  --agent-session-id <canonical-thread-id>
  --session-start-source startup
```

The reporter receives the launch correlation UUID through its private argv input.
It never discovers identity from process environment, terminal output, or
newest-file ordering. The configured session-peer directory is resolved at
installation from `HERDR_TRAEX_HOME`, then `TRAECLI_HOME`, then
`$HOME/.trae/cli`, and stored as an absolute private config path. No TraeX hook
is installed for identity or lifecycle reporting.

The installed shim release contains the start shim, process-fenced reporter, and
peer resolver as a complete local JavaScript import closure. Installation validation checks that the installed
official Herdr provides `pane report-agent-session` with
`--agent-session-id` and `--session-start-source`. The release remains
independent of repository `node_modules`.

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
guess the newest transcript. The correlation UUID is generated once by the shim;
the canonical identity comes only from the PID-correlated TraeX peer record and
is published to Herdr before the managed start returns.

## Delivery batches

### Batch 1: Shim-owned native session identity

Extend the shim startup, process reporter, installed release closure, and
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

- generated correlation UUID propagation into exact TraeX argv;
- PID- and thread-name-fenced resolution of the canonical thread UUID into the
  exact `report-agent-session` argv;
- bounded rejection of malformed, oversized, symlinked, ambiguous, stale, and
  mismatched peer records;
- separation of shim-owned state authority from trusted `herdr:codex`
  session authority;
- rejection of caller-provided session/resume identity arguments;
- startup injection of only the shim-owned state hooks and absence of a
  SessionStart or bridge reporter hook;
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

- Keeping any SessionStart identity hook or bridge-owned compatibility path.
- Teaching the shim about SQLite, bindings, Lark, or prompt IDs.
- Guessing sessions from process environment, session-index ordering, or
  newest-file ordering.
- Changing transcript content parsing, CardKit pagination, queue semantics, or
  approval handling.
- Replaying a prompt when identity or transcript observation is uncertain.
