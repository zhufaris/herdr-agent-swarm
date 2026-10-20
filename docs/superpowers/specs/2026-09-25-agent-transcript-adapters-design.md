# Agent Transcript Adapters Design

## Problem

The bridge currently treats structured transcript observation as a TraeX-only
capability. Its otherwise reusable port, observations, exact-turn fencing, and
coordinators all carry `TraexTranscript` names, while `PiDriver` declares that
structured events are unavailable. A completed Pi turn therefore replaces the
Answer Card with a notice directing the user to the Herdr Pane even though Pi
has already persisted the authoritative conversation to its native session
JSONL.

Terminal screen scraping is not an acceptable substitute. It mixes UI chrome,
history, partial output, and potentially sensitive terminal content, and it has
no reliable turn boundary. The bridge must consume each Agent's native durable
transcript while preserving exact-turn ownership, restart recovery, output
redaction, and the existing durable card/outbox pipeline.

## Evidence

Pi 0.87.1 writes an append-only JSONL session with a `session` header followed
by entries linked through `id` and `parentId`. Message entries include `system`,
`user`, `assistant`, and `toolResult` roles. Assistant content can contain text,
thinking, and tool-call blocks. An assistant message with `stopReason=toolUse`
is an intermediate tool phase; the later assistant message with
`stopReason=stop` closes the turn. Usage is attached to assistant messages. Pi
accepts `--session-id` and `--session-dir`, so a managed process can be assigned
a deterministic transcript location instead of relying on a newest-file scan.

TraeX uses a different JSONL envelope. Its `event_msg` records provide native
task-start, task-complete, and abort events with a runtime `turn_id`. The two
formats share turn semantics, not a storage schema.

## Decision

Introduce an Agent-neutral transcript port and keep format knowledge behind
per-Agent adapters. The domain-facing vocabulary becomes:

- `AgentTranscriptReaderPort`;
- `AgentTranscriptCursorPort`;
- `AgentTranscriptObservation`;
- `AgentTranscriptOpenResult` and `AgentTranscriptUnavailableReason`;
- `AgentTranscriptSource`, which describes the durable binding/generation,
  Agent kind, project cwd, and optional Herdr-native session identity needed to
  locate a transcript.

`TranscriptObserver`, `ExactTurnObserver`, Primary observation, detached
recovery, external-turn observation, and Worker observation depend only on this
port. They do not branch on Pi or TraeX formats. Existing `TraexTranscript*`
domain names are migrated rather than retained as aliases, so the public seam
does not continue to imply a TraeX-only model.

Infrastructure composes an `AgentTranscriptReader` router. It selects a concrete
reader by `AgentTranscriptSource.agentKind`:

- `TraexTranscriptReader` preserves its current native-session discovery and
  projector behavior;
- `PiTranscriptReader` resolves the bridge-managed Pi session file and projects
  Pi entries into the same observations;
- an unsupported Agent returns a typed unavailable result and follows the
  existing safe fallback path.

The JSONL formats are never normalized at the file-record level. Each adapter
owns validation, incremental reading, turn-boundary recognition, tool mapping,
usage extraction, bounded rendering, and secret redaction before producing a
domain observation.

## Pi transcript identity

Pi transcript identity is distinct from Herdr's native Agent control identity.
The implementation must not overload `agentSessionValue`, because that value is
used to fence session-scoped Herdr control operations.

For every managed Pi Primary, a pure helper derives a stable transcript
descriptor from `bindingId` and `generation`:

- a valid deterministic UUID for `--session-id`;
- a private directory below the configured swarm state directory, partitioned
  by binding and generation, for `--session-dir`.

`PiDriver.start` passes both arguments when Herdr starts Pi. The same helper is
used by `PiTranscriptReader`; no directory-wide newest-file heuristic is used.
The directory is created with private permissions before process launch. A
generation change necessarily selects a different directory and session ID, so
an old pane cannot feed a replacement binding's cards.

Existing Pi panes that were started without this managed descriptor remain on
the truthful unavailable/fallback path. They are not guessed from cwd or mtime,
and the bridge does not restart or replace them automatically. Newly
provisioned Pi bindings use structured observation.

## Pi turn projection

The Pi reader opens the selected append-only branch and advances incrementally.
It validates the session header ID against the expected descriptor and applies
these boundaries:

1. A new user message begins a turn. Its entry ID is the adapter's stable
   runtime turn ID, and its timestamp is the turn start.
2. Descendants on that selected branch belong to the turn until the next user
   message. Non-selected branches are not projected.
3. Assistant text blocks produce bounded, redacted answer deltas. Thinking
   blocks are ignored.
4. Assistant tool-call blocks and matching `toolResult` messages produce the
   existing tool activity and Answer timeline deltas. Tool arguments and results
   pass through the same safe projection limits used for TraeX.
5. `stopReason=toolUse` keeps the turn active. `stopReason=stop` completes it and
   supplies the accumulated assistant text as `finalAnswer`. Explicit aborted or
   error stop reasons terminate it as aborted with a safe reason. An incomplete
   trailing JSONL line is retried and never treated as completion.
6. Assistant usage is accumulated into the common main-status token count.

Opening `latest`, `first`, `active`, `at`, and `after` boundaries has the same
contract as TraeX. This allows the existing `ExactTurnObserver` and persisted
`transcriptTurnId`/`transcriptTurnStartedAt` fence to protect Pi without a
Pi-specific coordinator path.

## Prompt and recovery flow

Before dispatch, `TranscriptObserver` opens the reader selected for the
binding. Once Pi appends the user entry, the observation's fresh turn start
confirms dispatch and atomically claims that exact transcript turn for the
durable Prompt. Subsequent observations flow through the existing reducers,
Run Card projection, Answer Card pagination, and durable outbox. No Lark call is
made directly by a reader or coordinator.

After service restart, a detached Prompt reopens the same binding/generation
descriptor at its persisted exact turn. It may replay persisted JSONL only to
reconstruct card output; it never resubmits the prompt. A later manual Pi turn
is treated as a conflicting external turn under the existing ownership rules
and cannot overwrite the Prompt's Answer Card.

If the file is absent, ambiguous inside its dedicated directory, has a mismatched
header, contains invalid records, or loses its exact boundary, the reader returns
a typed unavailable result. The bridge preserves already-emitted safe output and
falls back without replaying the prompt.

## Capabilities and compatibility

`PiDriver` advertises `structuredEvents: true` and `usageReporting: true` only
when the managed transcript reader and state directory are configured. Pi's
native resume capability remains unchanged by this work; transcript recovery is
not permission to restart or resume an Agent process. TraeX behavior and its
native control identity remain unchanged.

The user-visible Pi completion fallback is retained only for legacy or genuinely
unavailable transcripts. A managed Pi turn with a valid JSONL completes with its
actual final answer in the same Answer Card workflow as TraeX.

## Security and operational constraints

- Pi session files remain local and private; they are not copied into SQLite.
- Only bounded, redacted projections are persisted or delivered to Feishu.
- System messages and thinking content are never projected.
- Unknown record/content types are ignored safely and counted in structured
  diagnostics without logging their bodies.
- Logs may contain the Agent kind, binding ID, generation, turn ID, and typed
  failure reason, but not prompt text, answer text, tool payloads, or secrets.
- Reader polling and per-drain record counts are bounded to prevent an actively
  growing or malformed transcript from starving reconciliation.
- Installation or restart does not mutate or terminate an existing Pi pane.

## Tests

Focused tests cover:

- generic port naming and router selection without format leakage into
  coordinators;
- deterministic, generation-fenced Pi descriptor creation and startup args;
- Pi header validation, partial trailing lines, multi-turn and branched sessions;
- text-only completion, tool-use loops, tool failures, aborts, and usage;
- secret redaction, thinking/system omission, and bounded output;
- exact-turn ownership, detached replay without prompt replay, later-turn
  conflict handling, and unavailable legacy panes;
- a Primary integration in which a Pi JSONL final answer replaces the accepted
  placeholder and reaches the existing durable card/outbox projection.

The affected focused tests, full Vitest suite, typecheck, build, documentation
audit, and public audit must pass. A real newly provisioned Pi binding must then
be used to verify that its Answer Card contains the native JSONL answer rather
than the fallback notice.

## Out of scope

- Scraping terminal screen output.
- Guessing ownership from the newest Pi file in a shared cwd directory.
- Automatically restarting, replacing, or migrating an existing Pi pane.
- Adding remote approval or arbitrary terminal input.
- Making Pi and TraeX JSONL record schemas identical.
