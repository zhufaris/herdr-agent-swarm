# Final Message Completion Choice Metadata

> **Status: superseded in part.** The legacy Hook policy below that says Stop is
> permanently fail-open and performs no repair was replaced by the implemented
> [2026-10-11 herdr-choice-list reliability one-repair plan](../plans/2026-10-11-herdr-choice-list-reliability.md).
> The [2026-10-11 atomic terminal completion envelope](../plans/2026-10-11-atomic-terminal-completion-envelope.md)
> records a cancelled historical native proposal; it is not current authority
> and cannot be resumed or used as a cutover plan.
> The historical body is retained unchanged below.

## Problem Statement

The current `herdr-choice-list` contract asks an Agent to append a reserved
Markdown fence containing JSON to the physical end of its visible final answer.
Swarm later parses that text, removes the fence from Feishu Markdown, persists a
Completion Choice Specification, and renders buttons. This works, but it mixes
presentation text with machine data, makes answer correctness depend on fence
placement, and lets the first Stop Hook request a protocol-only continuation
when the original answer omitted or malformed the fence.

The intended result is one canonical final message, not a second Choice
message. TraeX may continue to record the reserved fence in its raw JSONL for
compatibility, but Herdr Core must normalize that record into a clean final
`text` plus one optional structured `completion_choice` key. Herdr's ordinary
display ignores the key. Swarm persists the structured value, and only the
Feishu presentation path turns it into buttons and an acknowledgement-gated
mention.

## Solution

Add an optional, strongly typed `completion_choice` field to Core's existing
`message` payload when `channel = "final"`. Core recognizes only one bounded
reserved `herdr-choice-list` block at the physical end of the raw final text,
removes it from `text`, and emits a normalized Human Review value when the
block is valid. It does not emit a separate Choice event or message.

The owned TraeX plugin adds the already-designed `UserPromptSubmit` activation
so the original Agent turn is asked to produce the inline fence. Its Stop Hook
becomes fail-open compatibility validation: a missing or invalid Choice never
blocks completion and never requests a protocol-only continuation. A terminal
`intent: "none"` block is consumed from text and produces no
`completion_choice` field.

Swarm accepts the additive field consumer-first, validates it at the Core event
adapter, persists it through the existing Completion Choice Specification and
Completion Action Set transaction, and supplies the durable result to Feishu
card rendering. Feishu remains the only presentation adapter that renders the
question/options or releases the Human Review mention. Legacy final text with
an embedded fence remains supported during migration.

## User Stories

### SCN-1: One final message with Human Review metadata

When an eligible Agent finishes with a valid terminal Choice fence, Core emits
one final `message` whose `text` is the answer without the fence and whose
`completion_choice` contains the question, ordered options, default, labels,
and submitted messages. Herdr displays only `text`. Swarm produces the same
durable buttons and acknowledgement-gated mention as today.

### SCN-2: Normal completion without a Choice

When the final answer has no reserved fence, contains `intent: "none"`, or has
an invalid/oversized reserved block, the turn completes normally with no Choice
buttons and no mention. The Stop Hook does not create a second assistant
message. A recognized reserved terminal block is withheld from visible Core
`text` even when its Choice value is unusable.

### SCN-3: Retry and restart

Replayed raw JSONL produces the same normalized text, structured Choice, event
identity, and durable Completion Choice Specification. Restart or Feishu retry
does not duplicate options, action sets, cards, mentions, or Agent Input.

### SCN-4: Legacy producer and consumer compatibility

Before Core is upgraded, the new Swarm consumer continues parsing the legacy
terminal fence from final text. After Core is upgraded, Swarm prefers the
structured field and refuses conflicting simultaneous structured and legacy
values. Historical stored events and answers remain readable without rewriting
frozen cards.

### SCN-5: Primary and Worker ownership

The same normalized metadata works for an eligible Primary Prompt or Worker
Turn. Existing owner generation, Worker-session generation, parent Pane,
Completion Action Set, and actor fences remain authoritative. Direct Herdr or
otherwise ineligible turns may carry normalized metadata but do not acquire a
Swarm action surface.

## Implementation Decisions

### Domain Model

The existing **Completion Choice Specification** remains the immutable,
normalized Human Review value owned by Swarm. It contains one question, one to
four ordered options, one default option, and bounded IDs, labels, and submitted
messages. The existing **Completion Action Set** remains the mutable
availability/consumption authority. Neither becomes a Core aggregate.

Core owns a transport value named **Final Message Completion Choice**. It is an
optional DTO on one canonical final message, not a command, card payload, Lark
type, or separate event. `intent: "none"` and invalid protocol input produce no
DTO. Swarm translates a valid DTO into its existing domain value at the adapter
and projection seams.

Invariants:

- **INV-1:** One raw final record produces at most one canonical final message
  and at most one `completion_choice` value.
- **INV-2:** Core final `text` never contains a recognized terminal reserved
  Choice fence after normalization.
- **INV-3:** Missing or invalid Choice data never blocks turn completion and
  never causes a protocol-only continuation.
- **INV-4:** A Choice becomes actionable only after durable owner-fenced
  persistence; Feishu delivery is never the workflow authority.
- **INV-5:** A mention is released only after the card revision containing the
  actionable controls is acknowledged.
- **INV-6:** Duplicate source records and delivery retries do not duplicate
  specifications, actions, buttons, mentions, or Agent Input.
- **INV-7:** Herdr Core and Herdr UI do not depend on Feishu, CardKit, Swarm
  persistence, or action semantics.
- **INV-8:** Existing high-risk approval policy remains local to Herdr; Choice
  buttons cannot approve native tools or inject arbitrary terminal input.

### Architecture

#### TraeX plugin boundary

`UserPromptSubmit` supplies constant bounded context asking the Agent to append
one terminal version-2 fence to its original answer. It never sends the prompt
or answer to the eligibility socket. Stop handling validates for compatibility
but always fails open on missing/invalid data and never requests repair output.

#### Herdr Core codec and event schema

Core adds a transport struct matching the bounded version-2 Human Review
shape and an optional `completion_choice` member to `ReplyPayload::Message`.
The field is serialized only for `channel = "final"` and only for a valid
`human_review` value. Core's source codec uses an exact terminal parser rather
than prose inference or a broad regular expression. It bounds the inspected
suffix and complete block before JSON parsing, strips a recognized reserved
block, and does not retain prompts, hidden reasoning, paths, or unrelated
metadata.

Whenever Core consumes a reserved terminal fence and therefore changes the
canonical text, it uses a versioned decoder key such as `message-v2:*` or
`final-v2:*`, including `none` and invalid reserved blocks. Choice-free final
messages retain their legacy key. This prevents a historical payload from
reusing an event ID after normalization semantics change. Normal and recovery
decoding use the same raw record and key derivation.

#### Swarm Core-event adapter and projection

The adapter accepts optional snake-case `completion_choice`, converts it to a
source-neutral value, and keeps known malformed fields fail-closed at event
granularity. The persisted event codec round-trips the field. Conversation
projection keeps Choice metadata out of visible timeline Markdown and passes it
to the existing terminal Primary/Worker completion transition.

The terminal transition persists the normalized Completion Choice
Specification, Completion Action Set, final view, and Prepared Delivery intent
under the existing transaction/fences. If both a structured Choice and a
legacy fence exist, exact semantic equality is accepted; disagreement is a
projection conflict and creates no actionable Choice.

#### Feishu presentation and delivery

Pure Feishu card renderers consume the durable projected Choice/action view,
not raw JSONL or arbitrary Markdown. They render the question and business
buttons, while the system adds Ignore under existing rules. Other presentation
adapters ignore the optional view. The existing Delivery Ring, CardKit sequence,
ACK, outbox, retry, supersession, and mention ordering remain unchanged.

### Behavior & Failure Modes

- A valid `human_review` block is stripped and normalized.
- A valid `none` block is stripped and omitted from structured output.
- A malformed, duplicate, nonterminal, or oversized reserved block yields no
  Choice. Only an exact recognized terminal block is withheld from text;
  ordinary Markdown/code remains untouched.
- Stop always allows completion after bounded local inspection. Eligibility or
  Hook socket failure also fails open.
- Structured/legacy disagreement, invalid owner fences, frozen pages, or stale
  generations create no new action surface and do not rewrite historical cards.
- Persistence or delivery failure retains existing retry/quarantine behavior;
  it does not rerun the Agent or reparse terminal prose heuristically.

### Compatibility & Migration

Deployment remains consumer-first:

1. Install Swarm support for optional structured Choice while retaining the
   legacy fence parser.
2. Restart and verify persisted-codec, projection, Answer/Task card, and mention
   behavior.
3. Install Core with the additive field and versioned normalized identities by
   live handoff, then persist the same binary installation.
4. Install/enable the updated plugin and create a new Swarm-managed TraeX Pane
   because running processes do not hot-load Hooks.
5. Verify one Choice and one no-Choice turn from canonical Core, SQLite, Ring,
   CardKit ACK, and mention evidence.

Core keeps the current event schema version because the message member is
additive. Swarm keeps legacy parsing for existing Core versions and historical
events; removing that fallback is a separate later contraction.

## Testing Decisions

- Core codec tests cover valid Human Review, `none`, malformed, duplicate,
  nonterminal, oversized, and ordinary code-fence cases for TraeX and Pi final
  messages; text stripping, bounds, no private-field leakage, versioned keys,
  checkpoint/restart stability, and live/recovery event-ID equality are
  asserted through existing codec/journal seams.
- Core API schema tests cover Message JSON with and without
  `completion_choice` and current next-version generated schema output.
- Swarm adapter and persisted-codec tests cover additive field conversion,
  malformed isolation, restart round trip, and future unknown fields.
- Primary and Worker integration tests prove the specification/action set is
  persisted once with the terminal view, legacy fallback remains compatible,
  structured/legacy equality is accepted, conflict fails closed, and frozen
  cards are not rewritten.
- Card and delivery tests prove Choice is absent from answer Markdown, Feishu
  buttons render from durable state, Ignore remains system-owned, card ACK
  precedes exactly one mention, and retries/reopen do not duplicate effects.
- Plugin tests prove submit-time activation, missing/invalid Stop fail-open,
  no protocol-only continuation, non-Swarm fail-open, and already-running
  process compatibility guidance.
- Architecture/import checks separately prove Core has no Swarm/Feishu
  dependency and renderers do not parse raw source JSONL.

## Out of Scope

- A separate Choice message or Core event.
- Token-level metadata streaming before a complete final source record exists.
- Modifying TraeX's native JSONL envelope or requiring an upstream TraeX
  structured-output extension.
- Parsing prose to invent choices, product-defined fallback options, or more
  than four Agent-declared options.
- Remote native-tool approval, arbitrary terminal input, or weakening owner and
  generation fences.
- Rewriting frozen historical Feishu cards or deleting production data.
- Removing legacy fence parsing in the same rollout.
- Pushing either repository without separate authorization.

## Further Notes

- Swarm workspace: safe in-place specification writing at
  `/workspace/herdr-agent-swarm`, branch `main`, starting revision
  `f0a3f7b45f82fbb06ce003ef61ae23b0da583d1b`.
- Core implementation target: local `master` at
  `48fdcd625223e6f6e0c9363dbd0989309c738759`.
- Preserved unrelated paths: `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`,
  `handoff.md`, and Core's `.trae/`.
- Fresh focused baseline: 6 Vitest files, 71/71 tests passed, covering current
  Choice protocol/Hook/plugin and Core-event adapter/projector behavior.
- Gate 1 design approval: option A approved on 2026-10-07. Gate 2 specification
  approval: approved by “继续” on 2026-10-07. Gate 3 ticket approval and
  implementation authorization: approved on 2026-10-07.
