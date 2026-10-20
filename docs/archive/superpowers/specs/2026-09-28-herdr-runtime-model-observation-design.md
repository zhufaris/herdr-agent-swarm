# Herdr Runtime Model Observation Design

## Status

Approved direction: Herdr Core owns authoritative runtime-model observations;
Herdr Agent Swarm owns desired model preference, dispatch sequencing, and
delivery uncertainty.

This document extends the runtime model preference design in
`2026-09-28-runtime-model-preference-deep-module-design.md`. It does not move
the Swarm preference state machine into Herdr Core.

## Problem

Swarm can request that the next ordinary TraeX turn use a selected model and
can fence that request by binding generation, native session, prompt,
preparation operation, and preference revision. It cannot independently prove
the model the live agent actually reports using.

Herdr Core already owns the native session identity and durable agent-event
stream. Its TraeX decoder currently ignores `trae_extra_info` records even when
`extra_info.model` is present. As a result, the runtime fact is discarded at
the boundary that is best placed to validate and publish it.

## Ownership Boundary

### Herdr Core

Herdr Core owns observed runtime facts:

- decode a bounded canonical model name from TraeX runtime records;
- publish a structured agent event when the observed model changes;
- retain the latest observed model for the exact attached event source;
- expose that observation through pane and agent snapshots;
- clear or replace the observation when native session identity changes; and
- reject stale observations from replaced processes or sessions.

Herdr Core does not choose a model, send a model-change command, assign a
preference revision, or decide whether a Swarm prompt may be replayed.

### Herdr Agent Swarm

Swarm owns workflow intent:

- accept and persist the desired model and revision;
- pin one pending revision to the next ordinary FIFO prompt atomically;
- prepare and commit the exact TraeX model-aware prompt operation;
- preserve `pending`, `applying`, `effective`, and `uncertain` transitions;
- correlate Core observations with the binding and prompt fences; and
- render desired and observed state without presenting intent as runtime fact.

## Herdr Core Contract

### Canonical event

The agent-event payload union gains:

```json
{
  "type": "model_changed",
  "model": "GPT-5.4"
}
```

For TraeX, the decoder derives this only from a non-empty, bounded string at
`trae_extra_info.extra_info.model`. Invalid or oversized model values do not
enter the event journal. Repeated observations of the same model are
idempotent and do not create a semantic change event.

The event envelope continues to carry `source_id`, `agent_kind`, `session_id`,
`turn_id`, `cursor`, and `occurred_at`. `turn_id` may be absent when the runtime
reports a model outside a turn.

### Snapshot projection

Pane and agent responses gain an optional `runtime_model` object:

```json
{
  "name": "GPT-5.4",
  "source_id": "...",
  "agent_kind": "traex",
  "session_id": "...",
  "observed_at": "2026-09-28T00:00:00Z"
}
```

The projection is absent when Core has no observation for the current native
session. It is never synthesized from terminal text, process arguments, a
requested model, or arbitrary display metadata.

### Identity fence and lifecycle

An observation may update the pane projection only while all of these match:

- pane and terminal identity;
- attached event `source_id`;
- agent kind;
- native session ID; and
- foreground process identity captured when the source was attached.

The projection is cleared when the pane's native session is cleared or
replaced. A late event from an old source remains in that source's journal for
audit but cannot mutate the current pane or agent snapshot.

The latest observation is persisted with the event-source checkpoint so a
Core restart reconstructs the same snapshot without rereading unbounded
history. Existing journals and clients remain readable because the new fields
and payload variant are additive.

## Swarm Integration

Swarm extends its Herdr schemas and transcript observation port with an
optional runtime-model observation. The event path is authoritative; the
snapshot initializes or repairs state after startup, reconnect, compaction, or
missed wake-up.

An observation can confirm a model preference only when it matches:

- the current binding ID and generation;
- the current pane and native TraeX session;
- the prompt pinned to the preference revision;
- the prepared operation already accepted by TraeX; and
- the desired model after canonical comparison.

The existing acceptance receipt remains the boundary that proves the prompt
was accepted. A matching Core observation supplies runtime evidence; it does
not authorize replay. A mismatching observation is recorded for presentation
and diagnosis but does not silently change the desired preference. Missing,
stale, or conflicting evidence leaves the preference conservative, including
`uncertain` where delivery may have occurred.

Model Card and Main Card both consume the shared `ModelPreferenceSnapshot`.
They display Core's observed runtime model as `Current`, while `Next turn`,
`Applying`, and `Uncertain` continue to come from the Swarm preference state.

## Compatibility and Failure Behavior

- Swarm feature-detects `runtime_model` and `model_changed`; absence from an
  older Core means `Current` is unknown, not inferred from JSONL.
- Unknown future agent-event payloads remain safely skippable so an additive
  Core release does not break older readers.
- Invalid Core model observations are ignored and logged without exposing raw
  transcript content.
- Core transport loss falls back to periodic Core snapshot reconciliation, not
  direct transcript parsing for model state.
- No failure path automatically replays a prompt that may have reached TraeX.

## Testing

Herdr Core tests cover:

- TraeX `trae_extra_info` decoding and input bounds;
- event deduplication and journal replay;
- checkpoint persistence across restart;
- pane/agent/session snapshot projection;
- stale source, process, and native-session fences; and
- clearing the projection on session replacement.

Swarm tests cover:

- parsing `model_changed` and `runtime_model`;
- startup snapshot initialization and event-driven updates;
- complete binding/session/prompt/revision/operation fencing;
- mismatched and stale observations;
- restart recovery without prompt replay;
- shared Model Card/Main Card rendering; and
- compatibility with a Core that omits the additive fields.

Cross-repository verification runs focused tests first, followed by the full
Rust and Vitest suites, TypeScript typecheck, and both release builds.

## Deployment

Install the verified Herdr Core binary before restarting Swarm. Prefer Herdr's
supported live handoff path so existing panes and agents survive the Core
upgrade. Do not stop or kill the active Herdr server merely to activate the
binary. If live handoff is unavailable, report that activation is pending
instead of terminating user panes.

After Core reports the new contract, install and force-restart Swarm, then
verify:

- Core event and snapshot schemas expose the observed model;
- the Swarm expected and observed build identities match;
- readiness and SQLite integrity are healthy;
- existing active work is observed rather than replayed; and
- Model Card and Main Card distinguish observed current state from desired
  next-turn state.
