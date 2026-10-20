# Atomic Terminal Completion Envelope

<!-- spec-coder:artifact-v1 spec -->

> **Status / decision (2026-10-11): cancelled; not current implementation authority.**
> The user decided that TraeX source will not be modified, so the native atomic
> completion-envelope proposal is stopped and will not enter delivery. T2 and T3
> will not execute. The completed Core T1 work exists only as an undelivered
> prototype on an isolated branch and must not be merged, installed, or deployed.
> The current supported authority remains the compatibility path:
> `UserPromptSubmit` plus the bounded one-repair Stop Hook writes the terminal
> fence; Core strips that fence and emits canonical `completion_choice`; Swarm
> and Feishu consume that canonical projection. The body below is retained as
> historical design context only.

## Problem Statement

The current `herdr-choice-list` path transports an optional Human Review
decision inside the visible final-answer Markdown. A `UserPromptSubmit` Hook
asks the model to append a terminal fenced block, a `Stop` Hook validates or
repairs that block, Herdr Core strips it from visible text, and Swarm consumes
the resulting `completion_choice` metadata. This compatibility path is now
bounded and tested, but it still makes ordinary answer text carry a machine
protocol and depends on running TraeX sessions having loaded the correct Hook.

That seam has produced missing choices, leaked protocol JSON, duplicated
protocol-only continuations, and version-skew failures. It also splits one
logical completion across visible prose and a convention that the model must
format exactly. A more stable contract must bind the visible final answer and
the optional Human Review intent to the same native terminal record without a
second model analysis pass, a second authority, or a new durable delivery
ledger.

The downstream Completion Review lifecycle is not the problem. Swarm already
persists the immutable choice specification and fresh-card Action Set before
Feishu delivery, activates it only from exact ACK evidence, accepts only a
minimal `actionSetId + optionId` callback, and creates at most one deterministic
follow-up Agent Input. Primary and Worker ownership are already symmetric at
that boundary. The selected change must preserve those contracts.

The authoritative TraeX 0.209.1 producer source checkout and build/test contract
were not present during design. The installed binary contained native
collaboration event types, but binary inspection was evidence only and did not
authorize patching. The producer portion was therefore not implemented before
the proposal was cancelled. Supplying source or ownership information later
does not reopen this specification; a new user-authorized plan would be required.

## Solution

Introduce a capability-gated native Terminal Completion Envelope. For a native
session, the model completes the current turn through one terminal interface
that carries both the visible answer and an explicit review intent:

```ts
type TerminalCompletionEnvelopeV1 = Readonly<{
  answer: string;
  review:
    | Readonly<{ kind: "none" }>
    | Readonly<{
        kind: "choice";
        question: string;
        defaultChoiceId: string;
        choices: readonly {
          id: string;
          label: string;
          message: string;
        }[];
      }>;
}>;
```

TraeX owns provider adaptation and exact current-turn binding. It accepts
exactly one successful terminal envelope, renders only `answer`, and persists
`review` as hidden native turn metadata. The envelope is a terminal response
item, not an MCP call, plugin-to-Swarm IPC message, or post-completion model
job. Provider adapters may use forced tool calling or native structured output
internally, but the persisted TraeX contract is identical.

The persisted v1 record contract is fixed before either producer or consumer
implementation. It is one TraeX rollout `event_msg` whose payload is:

```ts
type TurnCompletionEndV1 = Readonly<{
  type: "turn_completion_end";
  schema_version: 1;
  turn_id: string;
  completion_id: string;
  answer: string;
  review:
    | Readonly<{ kind: "none" }>
    | Readonly<{
        kind: "choice";
        question: string;
        default_choice_id: string;
        choices: readonly {
          id: string;
          label: string;
          message: string;
        }[];
      }>;
}>;
```

TraeX writes the current `nativeTurnId` as `turn_id` and derives
`completion_id` before provider finalization as
`tcv1:<digest>`, where `<digest>` is the 64-character lowercase hexadecimal
SHA-256 of the UTF-8 JSON encoding of
`["herdr.turn-completion.v1", nativeSessionId, nativeTurnId]`. The complete
wire value is exactly 69 ASCII characters and matches
`^tcv1:[a-f0-9]{64}$`; the model cannot supply or change it. The rollout
record's append is the terminal linearization point. Core uses source identity
plus `completion_id` as the stable logical event key. Existing journal
`INSERT OR IGNORE` behavior remains unchanged: replay of the same key produces
no second canonical event. TraeX producer terminal uniqueness is authoritative;
Core does not add conflicting-body recovery, quarantine, or replacement logic
for a producer that violates that invariant. Native/legacy disagreement inside
one accepted record still yields the visible answer with no actionable review
under INV-9.

Herdr Core advertises `turn_completion_envelope_v1`, decodes the native record,
and continues emitting the existing canonical final `message` event with its
current optional `completion_choice` field. Swarm therefore keeps the existing
Core-event adapter, choice normalization, Completion Review aggregate, SQLite
transactions, Delivery Ring behavior, Feishu presentation, callback fencing,
and recovery semantics.

The cancelled proposal described an expand-cutover-contract migration. It would
have retained legacy fence reads for old sessions and retained history, pinned
native-versus-legacy mode when a session started, and required mixed-version E2E
and capability telemetry before any writer change. No part of that proposed
migration is executable or resumable from this specification. The supported
path remains the existing writer Hook plus Core canonical projection.

## User Stories

### SCN-1: Complete a turn without Human Review

A native-capable Primary or Worker completes with `review.kind = "none"`.
Only the answer is visible, Core emits one final message without actionable
choice metadata, and Swarm creates no Completion Review.

### SCN-2: Complete a turn with Human Review

A native-capable Primary or Worker completes with one question, one to four
ordered business choices, and one default choice. Only the answer is visible;
Core emits one final message with validated `completion_choice`; Swarm creates
the existing fresh Completion Review card with the responsible actor mention,
business buttons, and system-owned Ignore.

### SCN-3: Preserve exact answer and review atomicity

The answer and review intent come from one successful terminal envelope bound
to one exact native session and turn. A crash or transcript rescan cannot pair
the answer with another turn's review or create a second logical completion.

### SCN-4: Reject malformed terminal output safely

If a provider produces an invalid envelope, TraeX may perform one bounded local
schema repair within the same provider turn. If that still fails, the turn
ends explicitly failed or aborted; TraeX does not infer `none`, extract choices
from prose, or emit a partially canonical final answer.

### SCN-5: Preserve Primary and Worker symmetry

The model-facing and Core-facing envelope is identical for Primary and Worker
turns. TraeX/Core bind native session and turn identity; Swarm resolves the
current Primary Prompt, Primary/Worker Conversation Segment, or Worker Turn
using its existing durable ownership and generation fences.

### SCN-6: Handle duplicate native records deterministically

Repeated reads of the same native terminal record derive the same canonical
event identity and one persisted choice specification. TraeX prevents a second
distinct successful terminal envelope for the same turn; Core relies on that
producer invariant and preserves its existing same-key deduplication behavior.

### SCN-7: Run native and legacy sessions together

Native-capable sessions use the terminal envelope while older sessions continue
using the fenced protocol. Both produce the same canonical Core event shape and
the same Swarm behavior. Capability absence disables only the native writer; it
does not make an otherwise supported legacy session unusable.

### SCN-8: Fail closed on native and legacy disagreement

If a final record contains both native review metadata and a legacy fence, Core
normalizes and compares them. Equal values produce one decision. Different or
independently invalid values produce the visible answer without actionable
review metadata plus a payload-free diagnostic.

### SCN-9: Preserve callback and no-replay behavior

A Feishu business choice atomically consumes the existing Action Set and creates
one deterministic ordinary Agent Input from the server-side option message.
Ignore remains local. Pending delivery may retry the same prepared effect;
uncertain delivery is never replaced or replayed automatically.

### SCN-10: Recover after process restart

Core can reconstruct the same final message and choice metadata from the native
terminal record. Swarm can reconstruct the same Completion Review from Core and
SQLite without invoking the model, resubmitting a terminal operation, or reading
Feishu as workflow authority.

### SCN-11: Support providers without native structured output

TraeX may adapt forced tool calling or another provider-native structured mode
to the terminal envelope. If a provider cannot satisfy the envelope contract,
TraeX reports the native capability as unsupported for that session and uses
the pinned legacy mode; it does not embed an unvalidated alternative protocol.

## Implementation Decisions

### INV-1: One terminal authority

For a native-capable turn, the Terminal Completion Envelope is the sole writer
of the final answer and review intent. A separate `requestHumanReview` record,
plugin-to-Swarm IPC call, and post-terminal Swarm derivation job are excluded
because each creates a second ordering or effect authority.

### INV-2: Explicit review intent

Every native envelope contains either `none` or `choice`. Missing review intent
is invalid rather than equivalent to `none`. TraeX never derives review intent
from answer prose.

### INV-3: Bounded choice value

A choice review has a nonblank question of at most 2,000 characters and one to
four ordered business choices. Choice IDs are unique, match
`[A-Za-z0-9][A-Za-z0-9_-]*`, are at most 64 characters, and cannot be `ignore`.
Labels are nonblank and at most 40 characters. Messages are nonblank and at
most 2,000 characters. The default ID names one choice and that choice's message
remains exactly `default` during this migration. Ignore is system-owned.

### INV-4: Exact native turn binding

The caller supplies no Pane, session, turn, owner, generation, actor, chat, or
card identity. TraeX binds the envelope to its current native turn, Core binds
the canonical event to the current source/session/turn, and Swarm supplies the
existing durable owner and route fences. Late, nested, stale-session, or
cross-turn envelopes are rejected.

`completion_id` is the exact `tcv1:` plus lowercase SHA-256 value defined by
the persisted record contract. Values with another prefix, case, length,
encoding, or digest are malformed. Core does not recompute it from optional
provider fields. Core requires `turn_id` and accepts the record only when it
strictly equals the decoder's current active turn; a missing, stale, or
mismatched value fails closed before any final message is emitted. TraeX
producer tests independently compute known fixture IDs from exact Session/Turn
inputs; Core consumes those frozen wire fixtures and validates only the exact
69-byte shape.

### INV-5: Canonical event compatibility

Core continues emitting the existing final `message` payload and
`completion_choice` value. The native source does not require a parallel Swarm
event, new Completion Review schema, or new owner-specific interface. Event
identity is replay-stable and incorporates the native terminal-record identity
under the current redaction rules.

### INV-6: Visible-answer isolation

Only `answer` enters terminal presentation, Core visible Markdown, Answer/Turn
projections, and Feishu answer cards. Review metadata remains private durable
transport state and is subject to the same secret redaction and size limits as
other model output. Neither the envelope nor provider tool syntax is rendered.

### INV-7: Bounded repair, then explicit failure

TraeX allocates the stable `completion_id` before provider finalization and
persists a local terminal state with transitions `open -> finalizing ->
committed`. The atomic rollout append and `committed` transition form one
durable operation and are the only success linearization point. Rendering and
Core observation occur after commit and may be retried from that record.

TraeX may request at most one local schema correction while the state remains
`finalizing`. The correction is part of the same live provider turn and does
not become a new user turn or visible answer. If the process exits after a
provider response but before durable commit, or while repair outcome is
uncertain, restart marks the turn explicitly interrupted/failed and never calls
the provider again. If it exits after commit but before rendering or ACK to the
caller, restart replays presentation from the committed record without another
model call. Exhaustion produces explicit terminal failure/abort and no Human
Review. No layer manufactures a choice or resubmits uncertain finalization.

### INV-8: Session-pinned capability

Core advertises `turn_completion_envelope_v1`. At native Session creation,
TraeX snapshots that capability and durably records exactly one
`completion_protocol_mode` value: `native_v1` or `legacy_fence_v2`. That pin is
part of TraeX Session metadata and survives resume/restart. In `native_v1`,
TraeX registers the terminal envelope and suppresses invocation of the owned
`herdr-choice-list` writer Hooks for that Session. In `legacy_fence_v2`, the
existing plugin path remains active. A running Session never changes mode
because of plugin installation, Swarm restart, or capability refresh.

Swarm neither chooses nor reconstructs the pin. It may observe the mode only
through bounded diagnostics supplied by TraeX/Core, continues consuming the
same canonical final-message contract, and keeps the legacy plugin installed
while any supported legacy Session may still run. Global plugin installation
is therefore compatibility availability, not per-Session writer selection.

### INV-9: Dual-read conflict policy

During migration, Core accepts native metadata and the current legacy fence.
Native-only and legacy-only valid values are accepted. Two valid equal values
deduplicate. Any disagreement or invalid mixed pair fails closed to no
actionable review and emits a bounded diagnostic without answer or option text.

### INV-10: Durable-first Completion Review

Swarm persists the immutable choice specification, Action Set, fresh-card
presentation intent, owner/session fences, and outbox work before Feishu
delivery. Exact delivery ACK activates the Action Set. Retries do not repeat
model finalization or choice submission; uncertain effects remain non-replayable.

### INV-11: Dependency direction

The value rules for review intent remain provider-neutral domain policy. TraeX
provider adapters depend on the terminal-envelope interface. Herdr Core is a
transport adapter from native/legacy records to the existing canonical event.
Swarm application workflows depend on canonical Core and Completion Review
ports, not on TraeX provider formats or Feishu callback JSON. Feishu remains an
outer presentation and interaction adapter.

### ARCH-1: Deep terminal-completion module

TraeX exposes one terminal interface, conceptually
`completeTurn({ answer, review })`. It hides provider forced-tool/structured
output differences, schema validation, one-repair policy, current-turn binding,
terminal uniqueness, persistence, and visible-output suppression. Provider
limits must not force the full answer through a narrower ordinary MCP/custom
tool argument channel; the adapter must use a native response item or an
equivalent path with normal final-answer capacity.

### ARCH-2: Core translation seam

Herdr Core owns capability advertisement, native record decoding, legacy fence
fallback, mixed-source comparison, redaction, and deterministic canonical event
identity. It does not call Swarm or Feishu and does not persist a second workflow
queue. Published stable endpoint codecs remain unchanged; the new capability
and native record decoder are additive.

### ARCH-3: Existing Swarm Completion Review seam

Swarm continues to validate `FinalMessageCompletionChoice`, normalize the
choice specification, and use the current Completion Review aggregate for
Primary Prompt, Primary/Worker Segment, and Worker Turn owners. No
`terminal_review_requests`, Delivery Ledger, owner-specific callback, or frozen
answer-card mutation is introduced.

### ARCH-4: Cancelled historical compatibility rollout proposal

The cancelled proposal's historical rollout order would have frozen the v1
record contract, implemented the Core decoder, obtained authoritative TraeX
source and tests, implemented the producer and Session pin, run mixed-version
E2E, enabled native mode for new Sessions, and then contracted the writer only
for those Sessions. This sequence was never completed and is no longer a rollout
plan. None of its remaining steps may execute or resume from this artifact.

### ARCH-5: Cross-repository workspace safety

The Swarm specification was written in the then-clean isolated worktree. The
Core prototype used a separate clean worktree because the Core main checkout
contained unrelated user changes. No TraeX implementation was started. The
proposal is now cancelled unconditionally, so no source checkout, repository
instructions, build/test commands, or mutation owner can make it executable;
binary patching remains forbidden.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, SCN-8, SCN-9, SCN-10, SCN-11, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10, INV-11, ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-5

The following paragraphs preserve the cancelled proposal's historical test
design only. They do not define pending work and cannot authorize implementation,
verification, cutover, or delivery.

The proposed TraeX tests would have driven the public terminal interface with `none`, one through
four choices, duplicate IDs, reserved Ignore, invalid defaults, oversized and
multibyte values, missing intent, malformed provider output, one successful
repair, exhausted repair, duplicate terminal calls, late calls, stale sessions,
Primary and Worker turns, provider modes, and normal final-answer-sized output.
They would have proved that only answer text was rendered and exactly one native terminal
record was persisted with deterministic identity. Fault-injection tests would have covered
exit after provider response before commit, exit during repair, exit after
commit before rendering, duplicate caller acknowledgement, and restart from
each durable state; no proposed path would have issued another provider finalization after an
uncertain pre-commit outcome.

The proposed Core codec tests would have covered native none/choice records, required exact-active
`turn_id`, a turn-1 completion arriving after turn 2 starts, legacy-only
records, native/legacy semantic equality, disagreement, malformed mixed input,
fence-only answers that become empty after visible-answer cleanup, replay,
redaction, stable key derivation, capability absence, and old-session
compatibility. Missing or mismatched `turn_id`, stale-turn completion, and an
empty cleaned answer would have failed closed without publishing a final message.
Journal conflict recovery was explicitly excluded.
The tests would have asserted compatibility with the existing canonical
final-message schema and frozen endpoint contracts. The proposed locked Core
codec suite and repository `just` checks would have run in an isolated worktree.

The proposed Swarm tests would have preserved current event decoding, choice normalization,
Primary/Worker symmetry, fresh-card reservation, ACK activation, minimal
callback, Ignore, deterministic Submission Intent, duplicate/restart behavior,
legacy retained input, mixed-version conflict diagnostics, and uncertain Feishu
no-replay behavior. Architecture checks would have proved domain/application code did
not depend on TraeX provider or Feishu transport types.

The proposed end-to-end verification would have required one native Primary and one native Worker
completion, each with a visible answer free of transport syntax, one fresh
mention/button card, one successful callback, one resulting input, and restart
reconstruction. It would also have required mixed native/legacy coexistence and
inspection of capability telemetry and exact source evidence before changing
the legacy writer. None of these native checks remains pending under this plan.

## Out of Scope

- A second LLM pass that infers choices from completed answer prose.
- A Swarm-owned durable review-job queue or Delivery Ledger.
- Plugin-to-Swarm or plugin-to-Core IPC as terminal authority.
- Remote approval or denial of native tools, arbitrary terminal input, process
  control, or Pane control.
- Changes to Feishu card layout, callback shape, requester mention semantics,
  Submission Intent identity, Delivery Rings, or uncertain-effect policy.
- Removing the legacy reader, rewriting historical transcripts, or deleting
  delivered/uncertain Completion Review cards in this migration.
- Relaxing the default choice's `message: "default"` compatibility invariant.
- Patching or reverse-engineering the installed TraeX binary as an implementation
  substitute.
- The independent Herdr mouse-copy bug, which follows its own bounded design,
  workspace, tests, and commit.

## Further Notes

Gate 1 design selection was approved by the user on 2026-10-11 after comparing
the existing fenced protocol, a separate hidden review tool, the selected atomic
terminal envelope, and Swarm post-terminal derivation.

Workspace: in-place reuse of the clean isolated Swarm worktree
`<workspace>`,
branch `worktree-unified-delivery-ingress`, starting revision
`e93cb6939d9e887ae3e47c0a1eba885e18626bf6`. No initial changes were present.
Locked npm dependencies were already installed. Herdr Core was observed at
local `master` `2c0bff83eef7159bba99f5dec82b36ccc4866105`, 24 commits ahead of
freshly fetched `origin/master`, with unrelated user changes in `Cargo.lock`,
quick-start docs, and mouse-selection files. No Core mutation is authorized in
that checkout. TraeX 0.209.1 is installed internally, but its authoritative
producer source and build/test contract were not found; that blocks producer
implementation and Gate 3 readiness, not this specification review. That was a
historical planning observation, not a resumable gate; the later cancellation
closed the proposal regardless of future source availability.

Fresh Swarm baseline records for request
`terminal-completion-envelope-20261011-1`:

```spec-coder-verification
{"record_id":"be7bc82ffba8496ebeca30edeac91278","command":["/usr/bin/npm","test"],"exit_code":0,"status":"captured","observed_at":"2026-10-11T15:14:55.553594+00:00","result":"301 files and 4640 tests passed"}
{"record_id":"2dd4e71a03074588b7f572a66d9f32e9","command":["/usr/bin/npm","run","typecheck"],"exit_code":0,"status":"captured","observed_at":"2026-10-11T15:15:07.876186+00:00"}
{"record_id":"fafe8d1747674967b6cf15d3a7034611","command":["/usr/bin/npm","run","build"],"exit_code":0,"status":"captured","observed_at":"2026-10-11T15:15:12.635526+00:00","build_id":"sha256:38b12fd8c22f2fd4782fdd079311f492ab84c4a7cc756763a34f42d9a288b70d"}
{"record_id":"c2516da6f18846b4ad5e58ae59b1e0f6","command":["/usr/bin/npm","run","architecture:check"],"exit_code":0,"status":"captured","observed_at":"2026-10-11T15:15:15.334828+00:00","result":"535 source files checked"}
```

The earlier nonreusable capture `e67772da32014bfb9260fb9c788c8c0d`
used a reserved uncertainty sentinel in its dependency description and is not
baseline evidence; its child test command nevertheless exited zero. The four
records above replace it.
