# Herdr Events Reader Deep-Module Design

**Date:** 2026-09-30

**Status:** Approved direction; written specification awaiting review

## Objective

Refactor the 638-line `HerdrEventsReader` implementation into one deep public
module with private internal modules. Preserve the existing
`AgentTranscriptReaderPort` interface and every runtime guarantee while making
Core protocol changes, source recovery, durable cursor mechanics, and event
projection independently understandable and testable.

This is a structural refactor. It must not change prompt delivery, Core reads,
SQLite settlement, transcript projection, CardKit output, retry policy, or
operator configuration.

## Current problem

`src/runtime/herdr-events-reader.ts` currently contains four independent kinds
of implementation knowledge:

1. the external `herdr agent events` JSON protocol, Zod validation, command
   bounds, and response normalization;
2. Pane/session/source attachment, boundary location, capability discovery,
   submission receipt lookup, turn enumeration, and historical turn recovery;
3. the durable Core inbox cursor, per-event acknowledgement, retry/quarantine
   rollback, checkpoint continuation, and recovered-lane identity;
4. the stateful reducer that converts normalized Core events into
   `AgentTranscriptObservation`, including message, Tool, Goal, Task List, and
   lifecycle projection.

The public interface is already appropriately small, but those concerns change
for different reasons inside one file. Tests therefore cross a broad
implementation surface, and editing one concern requires understanding the
others. The problem is insufficient internal locality, not a missing public
abstraction.

## Design principles

- Keep `HerdrEventsReader` as the only public facade and the only module imported
  by composition code.
- Create private internal seams, not new domain ports. There is one production
  Core transport, so extra public interfaces would be hypothetical indirection.
- Keep Zod and raw snake-case Core payloads at the protocol edge.
- Pass normalized, bounded data inward. No internal module may run shell
  commands or parse arbitrary JSON unless that is its explicit responsibility.
- Keep durable inbox writes and acknowledgements behind the existing
  `CoreEventInboxStore` interface. Never import a concrete SQLite store.
- Preserve event order, exact identity fences, acknowledgement-before-next-read,
  reducer rollback, and no-replay behavior.
- Replace implementation-shaped tests with tests at stable module interfaces;
  do not layer duplicate test suites over the same behavior.

## Module shape

The existing facade remains at `src/runtime/herdr-events-reader.ts`. Internal
implementation moves below `src/runtime/herdr-events/`.

### `protocol.ts`

Owns the external Core protocol:

- all Zod schemas for capabilities, sources, batches, locations, receipts,
  recovery batches, and turn lists;
- the normalized `AgentEvent` and bounded response result types;
- the single bounded command execution path;
- response-size enforcement, JSON parsing, schema validation, and exact
  response identity checks that are intrinsic to the command result.

Its private interface accepts semantic operations such as `attach`, `sources`,
`locate`, `read`, `recoverTurn`, `submissionReceipt`, and `listTurns`. Callers do
not construct CLI argument arrays and never see raw snake-case response objects.

The command runner and executable remain injected at construction. Transport
errors and schema errors remain errors; policy-level translation into an
`AgentTranscriptOpenResult` stays in the facade.

### `source-session.ts`

Owns source and native-session resolution:

- validates that exactly one requested Pane and terminal identity exist;
- resolves the transcript descriptor;
- attaches from start or end and waits for the matching active source;
- finds active/exact/after boundaries across eligible historical sources;
- derives native Core identity;
- caches Core capabilities for the reader lifetime;
- opens historical recovery using the exact agent/session/turn fence.

It depends on the protocol client, the narrow Herdr Pane lookup, and the existing
descriptor resolver. It returns normalized source/session/boundary facts and
does not project events or mutate SQLite.

### `event-cursor.ts`

Owns ordered consumption and durable settlement:

- reads batches from a supplied normalized batch reader;
- splits non-durable batches at the next `turn_started` boundary;
- ingests durable batches before projection;
- exposes at most one unsettled durable event per observation;
- requires acknowledgement before another read;
- snapshots reducer state before projection and restores it when a quarantine
  attempt did not settle;
- resumes from the durable checkpoint after process restart;
- preserves completion semantics for recovered finite streams.

The cursor depends on a reducer object and optionally on `CoreEventInboxStore`.
Its interface remains the existing `AgentTranscriptCursorPort`; internal
constructor types stay private to the `herdr-events` cluster.

### `event-projector.ts`

Owns the pure stateful reduction from normalized `AgentEvent` values to
`AgentTranscriptObservation`:

- tracks current turn identity, canonical start, final answer, sequence,
  emitted message IDs, and outstanding Tool calls;
- maps Human, Agent, reasoning label, Tool, Goal, plan, branch, skipped-record,
  and terminal events;
- applies existing redaction and output bounds;
- produces a snapshot that can be restored exactly after a failed projection.

The projector performs no command execution and no SQLite work. A single
`project(events)` operation returns the observation and advances its state.
`snapshot()` and `restore(snapshot)` exist only as the cursor's internal rollback
mechanism. Tests cover it through observable observations and rollback results,
not its maps or sets.

### `identity.ts`

Owns deterministic live and recovered lane-ID derivation plus conversion between
normalized `AgentEvent` and `CoreEventEnvelope`. These are shared mechanics of
the source/cursor path, have no mutable state, and are not exported outside the
cluster.

## Facade responsibilities

After extraction, `HerdrEventsReader` remains responsible for application-level
policy at the adapter seam:

- implements `AgentTranscriptReaderPort`;
- maps `open`, `openActiveTurn`, `openFirstTurn`, `openAtTurn`, and
  `openAfterTurn` to boundary resolution;
- selects live versus historical recovery;
- translates external failures into the existing fail-closed unavailable
  reasons;
- returns submission receipts and session-turn summaries through domain DTOs;
- constructs the appropriate live or recovered cursor.

Composition continues constructing one `HerdrEventsReader` with the same five
dependencies. No caller learns the internal module graph.

## Data flow

### Live source

1. The facade asks `source-session` to resolve and attach the Pane/session.
2. `source-session` uses `protocol` to locate the requested boundary.
3. The facade derives and validates the durable lane identity.
4. `event-cursor` reads normalized batches through `protocol`.
5. With an inbox configured, the cursor persists a batch before exposing one
   event to `event-projector`.
6. The caller projects the returned observation and acknowledges it.
7. Only settlement permits the cursor to expose the next durable event.

### Historical recovered turn

1. The facade resolves the unchanged agent/session/turn identity.
2. `source-session` checks capabilities and requests the first recovery batch.
3. A non-recovered outcome maps to its current unavailable reason.
4. The canonical Core start time becomes the recovered identity.
5. The recovered lane excludes the caller's possibly imprecise start time, so a
   timestamp correction cannot fork durable state.
6. `event-cursor` drains the finite stream using the same ingest, projection,
   acknowledgement, retry, and quarantine semantics as the live stream.

## Error and safety behavior

The refactor preserves these exact rules:

- oversized, malformed, identity-mismatched, or ambiguous Core responses fail
  closed;
- capability probing remains cached and degrades to unsupported capability;
- a missing receipt remains `null`, not invented ownership;
- attachment uses bounded retries and never scans transcript files directly;
- recovered events must match agent kind, session, and turn;
- durable batches are persisted before their observations are published;
- a durable event must be acknowledged before the next event is read;
- failed reducer state is restored before retry or quarantine continuation;
- quarantining one event cannot consume or renumber its healthy neighbour;
- no path submits or replays Agent input;
- errors and persisted output retain existing redaction and size bounds.

## Testing strategy

Tests follow the stable interface closest to each behavior:

- Facade tests retain command-contract, source selection, capability fallback,
  receipt fencing, turn enumeration, and unavailable-reason coverage.
- Cursor tests cover batch splitting, ingest-before-project, one-event
  settlement, acknowledgement gating, retry rollback, quarantine continuation,
  restart replay, and finite recovery completion.
- Projector tests cover event-to-observation behavior, Tool correlation,
  deduplication, sequence stability, lifecycle output, redaction, truncation,
  Goal, and Task List projection.
- Identity tests cover deterministic lane IDs and envelope round trips.
- Existing end-to-end transcript/card tests remain unchanged as regression
  coverage across the public facade.

When a focused test is moved to a new internal module, the old duplicate is
removed in the same change. Tests that assert public behavior remain on
`HerdrEventsReader`; tests are not deleted merely because extraction makes them
temporarily inconvenient.

Required verification is:

1. focused protocol, cursor, projector, identity, and facade tests;
2. `npm run architecture:check`;
3. `npm run typecheck`;
4. `npm run build`;
5. the full `npm test` suite.

## Migration sequence

1. Extract protocol schemas and command normalization without changing the
   facade behavior.
2. Extract the projector and move only projector-specific tests.
3. Extract the cursor and its rollback/durable-settlement tests.
4. Extract source/session and lane identity mechanics.
5. Reduce the facade to orchestration and error-policy translation.
6. Add an architecture rule that only the facade and files inside
   `src/runtime/herdr-events/` may import the private cluster.
7. Remove superseded helpers and duplicate implementation-shaped tests.
8. Run the complete verification sequence before considering installation.

Each step must remain type-correct and keep focused tests green. No schema
migration, configuration change, service installation, or restart belongs to
this refactor.

## Non-goals

- changing `AgentTranscriptReaderPort` or adding new public ports;
- changing Core CLI commands, timeouts, response limits, or capabilities;
- changing event schemas, reducer semantics, CardKit rendering, or pagination;
- changing durable inbox schema, retry counts, quarantine policy, or projection
  gaps;
- changing detached Prompt recovery or prompt FIFO behavior;
- adding new runtime features while files are being moved;
- installing or restarting the live service as part of the structural change.

## Acceptance criteria

- `HerdrEventsReader` remains the only public facade imported by composition.
- The facade exposes the same `AgentTranscriptReaderPort` behavior and uses the
  same construction dependencies.
- Raw Core JSON and Zod schemas exist only in the protocol module.
- Durable cursor mechanics and event projection no longer share a class.
- The projector contains no command, Herdr, SQLite, or concrete store import.
- Internal files cannot be imported directly from outside the facade cluster.
- Existing safety invariants and observable outputs remain unchanged.
- Duplicate implementation-shaped tests are removed only after replacement at
  the stable interface.
- Architecture checks, typecheck, build, focused tests, and the full suite pass.
