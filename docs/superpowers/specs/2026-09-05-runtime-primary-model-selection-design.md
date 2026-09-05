# Runtime Primary Model Selection Design

**Date:** 2026-09-05
**Status:** Approved design

## Summary

Make `/swarm model` a reliable runtime model-selection command for the current
Primary TraeX session. A selection is validated against that session's model
catalog, persisted as durable intent, and applied atomically with the next
ordinary prompt. The command never interrupts an active turn and never drives
the TraeX `/model` terminal UI.

The model override and prompt must cross the external-effect boundary in one
structured TraeX `turn/start` request. TraeX 0.202.3 documents the `model` field
as an override for the new turn and subsequent turns. The implementation uses
the existing shim-managed session peer and preserves Herdr as Swarm's sole
Agent-control boundary.

## Goals

- Let `/swarm model <name>` select the model for the current Primary session.
- Apply the selection to the next ordinary turn and subsequent turns.
- Validate names against the current session's actual provider-backed catalog.
- Preserve FIFO dispatch, exact session identity, generation fencing, and the
  rule that work possibly delivered to TraeX is never replayed automatically.
- Report pending, effective, and uncertain states without presenting durable
  intent as observed runtime fact.
- Leave Worker startup model selection and other sessions unchanged.

## Non-goals

- Switching the model of an already-running turn.
- Project-wide or global default-model configuration.
- Changing Worker models after creation.
- Restarting or replacing a Primary to apply a model.
- Driving the TraeX `/model` picker with terminal text or key input.
- Falling back to an unvalidated model name when catalog lookup fails.
- Remotely changing provider, reasoning effort, verbosity, or collaboration mode.

## Current State

`/swarm model` currently creates a durable pane-control operation that is always
rejected. The documentation states that runtime selection is unsupported. The
managed TraeX driver accepts `--model` only at startup.

Ordinary Primary turns are submitted through `HerdrPort.runPrompt`, implemented
with `herdr agent prompt --wait`. The installed `herdr-traex-shim` already owns
the managed TraeX session peer needed for structured app-server operations and
uses it for native steering. This is the appropriate integration boundary for
model-aware prompt submission.

The TraeX 0.202.3 app-server schema exposes:

- `model/list` for the session-visible model catalog; and
- `turn/start`, whose optional `model` field overrides the model for that turn
  and subsequent turns.

There is no separate structured request that changes an existing thread's model
without starting a turn. Therefore the reliable semantic is "apply on the next
ordinary turn", not immediate mutation.

## Alternatives Considered

### A. Model-aware structured prompt through the Herdr shim

Persist the requested model and attach it to the next prompt dispatch. The shim
validates the exact managed session and uses the session peer to send one
`turn/start` request containing both prompt input and model.

Selected. It provides a structured receipt, keeps the model and prompt in the
same external-effect boundary, and reuses the existing identity and socket
security model.

### B. Restart and resume TraeX with `--model`

Stop the current process and resume its session with a new startup model.

Rejected. It changes runtime identity, expands recovery risk, and is not a true
runtime model change.

### C. Automate the TUI `/model` picker

Type `/model` into the pane and navigate the picker.

Rejected. Focus, terminal layout, menu text, approval state, and timing cannot be
fenced reliably. It cannot produce an at-most-once structured receipt.

## Command Semantics

### `/swarm model`

The query resolves the current Primary binding and exact shim-managed TraeX
session peer. It returns:

- the confirmed effective model, if known;
- any pending target model;
- an explicit uncertain state, if present; and
- models returned by the current session's `model/list`.

The catalog is session-scoped. Swarm must not substitute the output of a separate
`traex debug models` process because its profile or provider can differ from the
running Primary.

### `/swarm model <name>`

The mutation requires the same creator-and-administrator authorization already
assigned to the command. It also requires an active, attached Primary binding
with exact managed TraeX session identity.

The workflow reads `model/list` through the current peer and resolves the input
to a canonical catalog name. Exact matching is preferred. A case-insensitive
match is accepted only when unique; ambiguous and absent names are rejected. If
the catalog is unavailable, malformed, oversized, or times out, the request is
rejected and no model intent is persisted.

On success, Swarm persists a new desired revision and reports that the selection
will apply to the next ordinary turn. It does not interrupt an active turn,
create an empty turn, or claim that the model is already effective.

For model requests that have not started dispatch, the latest successfully
persisted request wins. An applying or uncertain revision cannot be overwritten
until reconciliation resolves it.

## Durable State

Store the preference separately from Binding lifecycle state. One row is scoped
to an exact binding generation and contains at least:

```text
binding_id
binding_generation
desired_model
desired_revision
effective_model
effective_revision
state: pending | applying | effective | uncertain
dispatch_prompt_id
updated_at
```

The stored model is a bounded canonical catalog name. Prompt text and the model
catalog are not stored in this record.

The state meanings are:

- `pending`: validated durable intent not yet attached to a dispatch.
- `applying`: a specific prompt has claimed the desired revision and dispatch
  may begin.
- `effective`: TraeX accepted the exact model-aware turn.
- `uncertain`: the external effect may have occurred but no conclusive receipt
  has been persisted.

New, replaced, reset, archived, or generation-changed Primary sessions do not
inherit the preference. A stale row remains historical evidence or is retired
by migration policy; it is never applied to a different runtime identity.

## Dispatch Protocol

### Claim and fencing

`claimNextDispatchablePrompt` extends its existing transaction so that it also:

1. reads the latest pending preference for the exact binding generation;
2. records the selected model revision on the claimed prompt or an equivalent
   durable dispatch record; and
3. changes that preference from `pending` to `applying` with the prompt ID.

This transaction prevents a later `/swarm model` command from changing the model
of a prompt that has already been claimed. A normal prompt with no pending model
retains the existing dispatch path.

### Herdr boundary

`HerdrPort.runPrompt` gains an optional model-dispatch value containing the
canonical name and durable revision. The adapter invokes the Herdr CLI as usual.
For a model-aware request it adds shim-owned, explicitly parsed arguments such as:

```text
herdr agent prompt <target> <text> --wait --timeout <ms> \
  --model <canonical-name> --model-revision <revision>
```

These options are implemented by the installed shim. Non-shim and non-TraeX
agents must reject the extension rather than interpret it as terminal input. The
prompt argument remains subject to existing command-runner redaction.

### Shim behavior

Before causing an external effect, the shim:

1. resolves the Herdr target and requires the explicitly projected managed TraeX
   identity;
2. verifies the peer socket owner, restrictive permissions, session UUID, and
   thread identity;
3. rejects a blocked or already-working Agent for ordinary dispatch;
4. calls the peer's `model/list` and confirms the canonical model still exists;
5. initializes the app-server protocol; and
6. sends one `turn/start` containing the prompt input, thread ID, and model.

The shim must not call official `herdr agent prompt` and then separately mutate
the model. The prompt and override are one app-server request. It returns a Herdr-
compatible structured result and keeps existing bounded transcript settlement
behavior.

Direct `turn/start` means the shim, rather than official `herdr agent prompt`, is
responsible for preserving Herdr-visible Agent lifecycle convergence. Existing
reporter/hooks and fresh Herdr snapshots remain the authority for observed state;
the shim must not fabricate durable idle completion solely from the RPC response.
The implementation plan must prove this path against a real disposable pane
before retiring the existing unsupported behavior.

### Dispatch receipt

Immediately before writing `turn/start` to the validated peer socket, the
adapter-side dispatch path must cross the existing durable `onDispatched` fence.
From that point onward, a lost response is delivery-uncertain and the prompt is
never replayed automatically. The implementation must not rely on a callback
from the short-lived shim process to establish this fence after the write.

The `turn/start` response must then contain a valid new turn ID for the expected
thread. That response confirms acceptance, lets Swarm persist the exact runtime
turn identity, and promotes the desired revision to `effective`. A response that
is missing, malformed, or inconsistent after the dispatch fence leaves the
revision `uncertain`; it never converts the operation back to not-delivered.

The effective model is sticky inside TraeX, so subsequent turns need not resend
the model. Swarm may retain `effective_model` as its last confirmed value for
cards and status. Fresh structured runtime evidence may update that projection,
but unstructured terminal text may not.

## Failure and Recovery

### Before `turn/start`

Identity mismatch, catalog rejection, blocked state, and a confirmed transport
failure before the dispatch fence are `not-delivered`. The prompt follows the
existing safe pre-dispatch failure policy and the desired model returns to
`pending`.

### After delivery may have begun

A timeout, socket disconnect, process crash, or malformed response after crossing
the dispatch fence is delivery-uncertain. Swarm must:

- mark the prompt observer detached or otherwise use the existing uncertain
  prompt path;
- mark the selected model revision `uncertain`;
- never replay the prompt automatically; and
- reject another model mutation until reconciliation settles the revision.

### Reconciliation

Recovery uses the exact prompt, session, thread, and transcript turn identity.
If the expected fresh turn is found, the prompt is treated as dispatched and the
revision becomes `effective`. If evidence proves the request never started, the
revision may return to `pending`. If neither conclusion is safe, both prompt and
model remain uncertain.

The model must not be inferred from a Lark card, terminal menu, stale binding
projection, or a different TraeX process.

## User-visible Projection

The model result card distinguishes intent from fact:

- `Current`: last confirmed effective model, or `unknown`.
- `Next turn`: pending model, when present.
- `Applying`: model and prompt identity while dispatch is in progress.
- `Uncertain`: explicit warning that the request may have taken effect and is
  awaiting runtime evidence.

After a model-aware turn receives a confirmed dispatch receipt, its result card
is updated to `Switched to <model>`. A failed validation or confirmed
non-delivery reports that the current model was not changed.

The Main Card `MODEL` metric shows only confirmed effective runtime evidence. A
pending or uncertain model is displayed separately and never replaces the metric.

## Security and Operational Bounds

- Accept only the current binding's exact managed session peer and thread.
- Apply the same Unix socket ownership and permission checks as native steering.
- Bound request/response bytes, catalog entries, canonical model length, and RPC
  timeout.
- Parse app-server JSON strictly and reject unknown or inconsistent identities.
- Do not log prompt bodies, full model catalogs, peer tokens, socket contents, or
  configuration secrets. Logs may include binding ID, prompt ID, revision, a
  bounded canonical model name, and outcome.
- Preserve local-only high-risk approval. Model selection must not approve or
  answer an active TraeX prompt.

## Testing

### Domain and SQLite

- Migration preserves existing databases and initializes no false effective model.
- `pending -> applying -> effective` is generation-fenced.
- Prompt claim and revision pinning occur in one transaction.
- A newer pending selection replaces an older pending selection.
- Applying and uncertain revisions reject overwrites.
- Confirmed non-delivery returns the same revision to pending.
- Uncertain delivery is never made dispatchable again automatically.
- Replacement and generation changes cannot consume stale preferences.

### Shim and app-server protocol

- `model/list` parsing handles canonical names, pagination, size limits, malformed
  JSON, timeouts, and ambiguous case-insensitive matches.
- Socket owner/mode, session UUID, target Agent, and thread ID are fenced.
- `turn/start` contains the exact prompt and model in one request.
- The durable dispatch fence is crossed before writing `turn/start`; any later
  failure is never classified as safely replayable.
- A valid response with the expected new turn ID confirms acceptance and the
  effective model.
- Explicit pre-delivery errors, post-delivery disconnects, wrong thread/turn IDs,
  blocked state, and session replacement produce the correct fail-closed result.
- Existing model-free prompt settlement continues unchanged.

### Workflow and projections

- Query and mutation enforce current Primary scope and authorization.
- Selection during an active turn persists pending intent without interruption.
- The next FIFO prompt claims the selected revision.
- A concurrent later selection cannot alter an already claimed prompt.
- Cards distinguish pending, effective, rejected, and uncertain outcomes.
- Transcript reconciliation promotes only an exactly matched dispatched turn.

### Verification

Run the affected Vitest files, `npm run typecheck`, and `npm run build`. Because
the change spans persistence, dispatch, recovery, and shared runtime behavior,
also run `npm test`. Before deployment, use a disposable real Herdr pane to prove
catalog lookup, next-turn model application, lifecycle observation, transcript
settlement, and no-replay behavior. Do not use the production Primary for this
acceptance test.

## Documentation Changes

Update `README.md`, `docs/architecture.md`, and
`docs/feishu-group-usage.md` to replace the unsupported-runtime statement with:

- current-Primary scope;
- strict current-session catalog validation;
- next-turn activation;
- pending/effective/uncertain feedback; and
- no terminal-menu fallback.
