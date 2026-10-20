# Herdr Runtime Model Observation Implementation Plan

## Objective

Make Herdr Core publish and retain the actual model reported by the current
native agent session, then make Herdr Agent Swarm consume that fact while
retaining ownership of desired-model revisions, prompt dispatch, uncertainty,
and no-replay behavior.

Each work package follows red-green-refactor. Core changes land in
`/workspace/herdr-core`; Swarm changes land in this repository.
No JSONL fallback may be added for runtime model observation.

## Protected behavior

- Existing agent-event turn, message, tool, and lifecycle payloads retain their
  meanings and cursor ordering.
- Existing Core clients may omit the new optional snapshot field and may safely
  ignore the additive event payload.
- A stale event source cannot mutate a replacement pane process or native
  session.
- Swarm changes a model only on the next ordinary FIFO prompt.
- A prompt that may have reached TraeX is never automatically replayed.
- Acceptance of a model-aware prompt remains fenced by binding generation,
  native session, prompt, preference revision, and operation ID.
- `Current` is based on Core observation; desired state is never presented as
  observed runtime fact.

## Work package 1: Core canonical model event

### Red

Add focused decoder tests in `herdr-core/src/agent_events/codec.rs` for:

- a TraeX `trae_extra_info.extra_info.model` record producing one bounded
  `model_changed` payload;
- duplicate observations producing no second semantic event;
- missing, blank, non-string, and oversized model values being rejected or
  skipped without leaking record content; and
- model observation retaining the exact current turn when one exists.

Add schema serialization tests for the additive payload in
`herdr-core/src/api/schema/agent_events.rs`.

### Green

- Add `ReplyPayload::ModelChanged { model }`.
- Give `Decoder` a persisted latest-model projection used for deduplication.
- Decode only the documented TraeX path and enforce a small explicit bound.
- Keep reasoning and unrelated `trae_extra_info` fields filtered.

### Focused gate

- `just test-one agent_events`

## Work package 2: Core durable runtime projection and fences

### Red

Extend journal/source tests and API tests to prove:

- the latest model survives journal reopen through the source checkpoint;
- `agent.events sources` returns the current observation for the exact source;
- pane, agent, and session snapshots expose an optional `runtime_model`;
- process replacement, session replacement, source mismatch, and agent-kind
  mismatch reject stale observations; and
- clearing/replacing the native session removes the old projection.

### Green

- Add a bounded `RuntimeModelInfo` schema shared by pane and agent responses.
- Extend the source checkpoint/source summary with the latest observation.
- Add a server-owned runtime update path from the agent-event collector into
  `TerminalState`; do not route through arbitrary presentation tokens.
- Compare-and-set the update against terminal, source, agent kind, native
  session, and foreground process identity.
- Reconcile the checkpoint projection on collection ticks so a crash after the
  journal commit cannot permanently lose the pane snapshot update.
- Emit the normal pane/agent update signal when the projected model changes.
- Update generated next-version API schema and unreleased socket API docs; do
  not edit preview, published version docs, or changelog.

### Focused gate

- `just test-one agent_events`
- `just test-one api_ping`
- `just test-one pane_report_runtime_model`

## Work package 3: Swarm Core-contract adapter

### Red

Extend `tests/herdr-adapter.test.ts` and `tests/herdr-events-reader.test.ts` to
prove:

- optional `runtime_model` is parsed from pane/agent snapshots;
- `model_changed` is parsed without becoming answer text or a tool activity;
- an unknown field from an older/newer compatible Core does not fail the
  reader; and
- absent Core model data remains unknown and never triggers JSONL inference.

### Green

- Add a runtime-model observation type to the Herdr boundary.
- Extend `HerdrPane` and `AgentTranscriptObservation` with optional observed
  model data.
- Parse the additive Core snapshot and event fields in `herdr-adapter.ts` and
  `herdr-events-reader.ts`.
- Keep the shadow reader observational only and do not add a transcript model
  parser.

### Focused gate

- `npx vitest run tests/herdr-adapter.test.ts tests/herdr-events-reader.test.ts tests/herdr-events-shadow.test.ts`
- `npm run typecheck`

## Work package 4: Swarm observed-model deep-module integration

### Red

Extend model, store, observer, recovery, and card tests to prove:

- only an observation matching binding generation, pane, native session,
  prompt, accepted operation, and revision can confirm the requested model;
- model comparison uses the same canonical catalog identity as selection;
- mismatches retain desired intent and surface the observed model separately;
- stale observations are ignored;
- uncertain work remains non-replayable after restart;
- startup snapshot reconciliation restores `Current`; and
- Model Card and Main Card render the same observed/desired snapshot.

### Green

- Extend `RuntimeModelPreference` with one typed observed-runtime evidence
  input and snapshot projection.
- Persist only the minimal observation and its identity fence needed for
  deterministic restart behavior; Core remains the source of truth.
- Feed event observations through the existing transcript observer and feed
  snapshot observations through session reconciliation.
- Keep SQLite compare-and-set transitions transactional and behind the existing
  deep-module/store port.
- Converge both card families only when the shared snapshot changes.

### Focused gate

- `npx vitest run tests/model-selection.test.ts tests/sqlite-store.test.ts tests/herdr-runtime-reconciler.test.ts tests/model-command-integration.test.ts tests/main-card-workflow.test.ts tests/run-card.test.ts`
- `npm run typecheck`

## Work package 5: Cross-repository verification

### Herdr Core

- `just check`
- regenerate/check the next API schema with the repository-supported command;
- `git diff --check` for touched files.

Because this changes persisted agent-event checkpoint data and public optional
API fields, treat it as release-risk and retain explicit characterization tests
for old checkpoint deserialization and absent fields.

### Swarm

- run all directly affected Vitest files;
- `npm test`;
- `npm run typecheck`;
- `npm run build`; and
- `git diff --check` for touched files.

## Work package 6: Installation and live verification

- Inspect the installed Herdr version and the local Core build identity.
- Build the release with the repository-supported `just` recipe.
- Install the binary without stopping the active Herdr server.
- Use the installed Core's supported live-handoff mechanism if available. If it
  is unavailable, leave activation pending and do not terminate user panes.
- Verify `session.snapshot` and agent events report the same model for an exact
  native session.
- Build and install Swarm, then force-restart its user service.
- Verify expected/observed Swarm build identity, readiness, SQLite integrity,
  Core connectivity, current model projection, and absence of new startup
  errors.

## Intended commit boundaries

Herdr Core commit proposal:

`feat: expose observed agent runtime model`

Swarm implementation commit proposal:

`feat: consume herdr runtime model observations`

The Core commit requires explicit message alignment before it is created, per
that repository's contributor instructions. No remote push or pull request is
part of this plan.
