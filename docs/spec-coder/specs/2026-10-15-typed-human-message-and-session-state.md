# Typed human messages, structured choices, and Turn session state

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Feishu text messages and card choices enter different application paths. Text is
stored as a legacy `IncomingLarkMessage`, while a completion button is decoded as
an untyped card action and converted directly into a Submission Intent. The
choice identity is therefore not preserved through the same durable message
contract as ordinary human input.

Assistant choices have a typed Core projection, but their primary producer is
still a handwritten Markdown fence. The current v2 fence couples a `default`
option ID to a separately declared option list and requires the selected
option's message to equal the sentinel `"default"`. Small generation mistakes
fail closed and leave a final card without buttons.

The recently added pane identity, model usage, token, wait, Goal, and Subagent
state also remains split across Topic View, Session Activity, and Conversation
Segment projections. Human Turn Cards currently show Goal, Task List,
Subagents, and Compaction, but omit worktree/branch and model usage timing.

## Solution

Introduce versioned typed assistant and human message contracts. A human message
contains text plus an optional reference-only choice selection. A typed
assistant message contains text plus an optional `ChoicePrompt` whose default
option is embedded as a complete object, with alternatives stored separately.
Legacy v2 fences remain parse-only compatibility input.

Persist the canonical human message through durable inbound handling and
Submission Intent, then submit it to Herdr Core through a separately advertised
typed Agent Input method. Core retains typed metadata while the terminal Agent
receives only trusted resolved text.

Add a bounded `TurnSessionStateView` read model that combines authoritative
Topic View and Session Activity data at Turn Card convergence without copying
that state into each Conversation Segment.

## User Stories

### SCN-1: A normal Feishu text message remains typed end to end

The Gateway creates a versioned human message with text and no choice. Durable
inbound handling, Submission Intent, and Core preserve that message identity;
text-only input can use the compatible Core path when typed metadata is absent.

### SCN-2: A completion button becomes a typed human choice

A valid Feishu button click supplies only `actionSetId`, `optionId`, and
`sourceMessageId`. Swarm resolves label, submit text, owner, generation, actor,
and card identity from the current durable Action Set, then atomically consumes
the choice and admits one typed Submission Intent.

### SCN-3: Invalid, duplicate, and unsupported choices fail safely

Tampered, stale, unauthorized, or unknown choices create no Submission Intent.
An exact duplicate returns the original submission. Reusing a submission
identity with different canonical typed content is an identity conflict. A
choice is not submitted to a Core that lacks typed-message capability.

### SCN-4: An assistant declares a choice without cross-field references

A typed assistant message embeds one complete `defaultOption` plus zero or more
complete alternatives. Presence of `choice` means Human Review; absence means
no review. Rendering never depends on a dangling default ID or the legacy
`"default"` message sentinel.

### SCN-5: Legacy assistant choice fences remain compatible

A valid terminal v2 fence is converted once into the typed Choice Prompt.
Native Core metadata wins. Invalid compatibility input is withheld, records an
explicit reason, and cannot fabricate buttons. New code never emits the legacy
shape.

### SCN-6: The current Human Turn Card shows bounded session state

The mutable current Turn Card displays available workspace/worktree/branch,
model/context/token, wait/first-visible timing, turn state, active Subagents,
and compaction. Goal and Task List remain Segment-owned and are not duplicated.

### SCN-7: Session state convergence is idempotent

A visible session-state change reserves one current-page revision. Repeated or
invisible changes are no-ops. Frozen history pages are never patched.

## Implementation Decisions

### INV-1: Typed human message content is immutable

`HumanInputMessageV2` is the immutable Submission Intent payload. Its canonical
digest covers schema version, text, and optional reference-only choice. Retry
and receipt adoption compare the same payload; metadata is never silently
dropped after a possible Core effect.

### INV-2: Choice consumption and submission admission are atomic

The durable Action Set is the authority for option content and current
eligibility. Consuming the selected option and inserting its typed Submission
Intent occur in one SQLite transaction. Provider payload text, labels, owner
fields, and generations are untrusted hints and never become submission data.

### INV-3: Agent runtime input remains trusted text

Typed metadata is control-plane evidence. Swarm and Core persist it, and Core
emits it on the canonical Human Message event, while TraeX/Pi receive only the
validated resolved `text`. Transport JSON is never inserted into the prompt.

### INV-4: Session state is never guessed

Only explicit Topic View, Session Activity, Segment, Herdr, and Core facts may
appear. Missing branch, token, timing, or terminal Subagent evidence stays
unavailable. Presentation does not parse system prompts or infer completion.

### ARCH-1: Gateway ingress owns provider translation

The Feishu adapter translates SDK text and card callbacks into provider-neutral
typed Gateway events. The application-owned human message DTO crosses inward;
raw SDK objects and untyped card payloads do not. The legacy message adapter is
text-only and must not downgrade a choice event.

### ARCH-2: Submission Intent owns durable human input

Durable inbound rows and Submission Intents store canonical typed message JSON
plus bounded indexed text. Migration preserves existing text rows as typed
messages without a choice. Recovery, idempotency, and Core submission consume
the same DTO rather than reconstructing it from card actions.

### ARCH-3: Choice Prompt embeds its default option

`ChoicePrompt` contains `question`, `defaultOption`, and `alternatives`.
`ChoiceOption` contains `id`, `label`, and `submitText`. IDs remain bounded and
unique across the embedded default and alternatives. The renderer orders the
default first. A legacy adapter translates valid v2 `{default, options}` input;
typed producers never create that representation.

### ARCH-4: Core typed capability is explicit

Swarm requires the additive `agent_input_typed_message_v1` capability before
submitting a message with choice metadata. Plain text may safely fall back to
the existing path. Typed choice on an older Core remains recorded and reports a
capability mismatch instead of degrading to text.

### ARCH-5: Turn session state is a read model

A small query module resolves the current Segment owner and combines existing
Topic View identity/model usage with Session Activity turn/token/Subagent facts.
The presentation interface accepts one bounded `TurnSessionStateView`. Its
fingerprint contains exactly the displayed fields and drives one current-page
invalidation when they change.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, INV-1, INV-2, INV-3, INV-4, ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-5

Use Gateway contract tests for text and choice normalization, SQLite migration
and transaction tests for typed-message round trips and atomic choice
consumption, Submission Intent tests for duplicate/conflict/recovery behavior,
and adapter tests for v4 capability negotiation and plain-text fallback. Use
protocol tests for embedded default construction and v2 compatibility
translation. Use pure renderer/fingerprint tests plus Turn Card workflow and
card-context integration tests for Session State ordering, bounded values,
single invalidation, terminal filtering, and frozen-page preservation.

Cross-repository fixtures must serialize the same Human Input JSON in Swarm and
Core. Delivery runs focused suites, Swarm typecheck/build/architecture/full
Vitest, and the accepted Core native verification set.

## Out of Scope

Provider-native typed user prompts inside TraeX/Pi, parsing system prompt or
environment-context prose, retroactively rewriting historical Turn Cards,
guessing unavailable tokens or Subagent terminal state, changing Feishu
transport credentials, push/PR publication, installation, restart, and
production deployment are excluded.

Windows MSVC cross-lint is excluded from this task's prepared Core baseline
because the host lacks the Microsoft SDK and the user selected the native
baseline rather than authorizing SDK installation. This is not a claim of
Windows verification.

## Further Notes

Gate 1 approved the combined typed-message/Core-v4/TurnSessionStateView design.
The user then replaced the legacy default-ID reference with the embedded
`defaultOption + alternatives` contract and approved that revision.

Swarm workspace:
`<repo-root>/.trae/worktrees/fix/stop-active-turn-deploy`,
detached clean HEAD `75720dc64be138f27874bb17e3f785744130369b`.
Fresh preparation passed `npm run typecheck`, `npm run build` with build ID
`sha256:d620d832fa53bcff8c10a5fa0a34d08a6d2bbe82511e138789e1c93f3e9b025c`,
`npm run architecture:check` for 544 files, and `npm test -- --reporter=dot`
for 304 files / 4910 tests. Full-test capture record:
`ad621f98413545389ee469ccdb321334`.

Core authoritative workspace:
`/tmp/herdr-core-typed-message-v4-master`, branch
`fix/typed-human-message-v4-master`, clean base
`a3ebee21a71e100a3c6d8ad12ddd408e03fedc7f`. The original Core checkout's
user-owned changes remain untouched. An earlier old-base worktree at
`/tmp/herdr-core-typed-message-v4` is retained as failed preparation evidence.
With verified Zig 0.16.0 and isolated XDG directories, Core passed fmt, clippy,
4073/4073 native Rust tests, 150 maintenance tests, and Bun integration/release
tests. The final Windows cross-lint failed only because `lib.exe`/Microsoft SDK
is absent; the user explicitly approved this narrower native baseline.
