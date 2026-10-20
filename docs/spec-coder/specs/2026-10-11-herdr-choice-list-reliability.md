# Herdr Choice List Reliability and Invisible Transport

<!-- spec-coder:artifact-v1 spec -->

Status: Gate 1 design, Gate 2 specification, and Gate 3 implementation plan
approved by the user on 2026-10-11. T1 evidence reopened the authority design;
the user selected the revised protocol-authoritative design on 2026-10-11.

## Problem Statement

The `herdr-choice-list` path currently relies on a model following an advisory
instruction. For an eligible Swarm-managed TraeX turn, the
`UserPromptSubmit` Hook injects context asking the model to invoke the
`herdr-choice-list` Skill, but the Skill disables implicit invocation and the
`Stop` Hook always permits the turn to end. A spec-coder Gate can therefore
render ordinary Markdown options such as `A / B / C` without producing a
machine-readable Human Review decision. Feishu then receives plain text with
no buttons and no requester mention.

The text protocol also has an overly fragile visibility boundary. Swarm strips
a valid `herdr-choice-list` block only when it is the unique terminal block.
Trailing metadata, multiple blocks, or a nonterminal block can cause reserved
transport JSON to remain in visible Markdown. The JSON is not user content and
must never be displayed in Feishu.

Finally, once a valid Human Review choice is rendered inline in the Answer or
Task card, current completion-notification code can enqueue a second standalone
message such as:

```text
@用户 需要你的选择。
```

That message is redundant because the exact card already contains the trusted
mention, question, business buttons, and system-owned Ignore action.

## Solution

Make the protocol a one-repair, fail-closed transport contract for every
eligible turn.

`UserPromptSubmit` continues to add bounded context, but the final answer must
now contain exactly one version-2 terminal protocol with either
`intent:"human_review"` or `intent:"none"`. The protocol JSON is compact
one-line JSON produced in `JSON.stringify` form. The complete text envelope is
at most three lines: opening fence, one JSON line, and closing fence.

The first `Stop` validates eligibility and the terminal protocol:

- a valid decision is allowed;
- a missing, malformed, nonterminal, multiple, version-1, or oversized protocol
  blocks Stop once and asks for a protocol-only repair continuation;
- a repeated Stop never blocks again, preventing an infinite repair loop.

The existing final-answer selection path combines the original accumulated
answer with a valid protocol-only continuation. If the accumulated answer
contains an invalid reserved block, the invalid block is removed before the
replacement protocol is appended.

Reserved `herdr-choice-list` fences are transport-only. Swarm removes every
reserved block from visible Markdown regardless of validity or position. Only
one valid terminal block may activate Human Review. Invalid, multiple, or
nonterminal blocks produce bounded diagnostics but never visible JSON and
never actionable choices.

When a final card contains a current Human Review Action Set, no standalone
choice reminder is reserved. Any existing pending, unclaimed, never-attempted
choice reminder is atomically dismissed, its obsolete prerequisite edges are
deleted, and its obligation reference is cleared without suppressing the
inline controls. Choice-free completion notices remain unchanged. Delivered or
possibly-started historical notices are never deleted or replayed.

## User Stories

### SCN-1: Eligible non-decision turn emits compact intent none

When an eligible Swarm-managed turn has no useful Human Review decision, the
final answer contains exactly one terminal three-line block whose JSON line is
the compact value `{"version":2,"intent":"none"}`. The protocol is absent from
Feishu visible Markdown.

### SCN-2: Spec-coder Gate becomes a Human Review card

When a final answer presents a concrete approval or selection Gate, the owned
Skill carries one compact version-2 `human_review` protocol with the same
question, option order, labels, messages, consequences, and declared default.
Feishu renders the trusted mention, question, buttons, and Ignore action. The
Stop Hook validates the protocol but never infers intent from prose.

### SCN-3: Missing protocol receives one repair

If the first eligible Stop has no reserved protocol, the Hook blocks Stop once
with a bounded instruction to emit only the compact terminal protocol. The
repair continuation is combined with the original answer before Core
projection.

### SCN-4: Invalid or nonterminal protocol is replaced safely

If the first eligible Stop contains malformed JSON, an unsupported shape,
multiple blocks, or content after the protocol, the Hook blocks once. The
invalid reserved transport content is removed, the valid repair block replaces
it, and non-protocol prose remains visible in its original order.

### SCN-5: Repeated Stop cannot loop

When `stop_hook_active` is already true, the Hook never blocks again. Core may
accept a repaired protocol or finish without actionable Human Review, but the
Hook cannot cause an unbounded continuation loop.

### SCN-6: Feishu never displays reserved JSON

For valid, invalid, incomplete, nonterminal, oversized, duplicate, or repaired
reserved protocol input, no `herdr-choice-list` fence or protocol JSON appears
in the Answer card, Task card, Main card, completion message, or recovery
projection.

### SCN-7: Raw TraeX transport stays compact

The text-protocol implementation emits compact one-line JSON with no indentation
or presentation-oriented formatting. Raw TraeX transcripts may still show the
three-line transport envelope; hiding it there requires the separately scoped
native side-channel design.

### SCN-8: Inline Human Review has no standalone reminder

After a final card containing a valid current Action Set is acknowledged,
Swarm does not create a standalone `需要你的选择` completion reply for a
Primary Prompt, Worker Turn, or Primary Segment owner.

### SCN-9: Existing safe pending reminder is retired

If a Human Review owner already references a pending standalone reminder that
has no claim, attempt, surface checkpoint, Gateway checkpoint, or possible
remote effect, Swarm dismisses it atomically, removes its prerequisite edges,
and clears the notification reply reference while leaving the inline Action
Set available.

### SCN-10: Historical remote effects are preserved

If a standalone reminder is delivered, claimed, attempted, checkpointed,
uncertain, or otherwise possibly applied remotely, this change does not delete,
dismiss, resend, or rewrite it.

### SCN-11: Choice-free completion notice remains

When a trusted successful completion has no Human Review choice, the existing
standalone completion mention remains ACK-gated, retryable, restart-safe, and
at most once.

### SCN-12: Button actions remain one-shot

The exact actor may select one business option or Ignore. Business options
create one deterministic ordinary Agent Input; Ignore consumes locally.
Duplicate, stale-card, wrong-actor, wrong-generation, or unknown-option
callbacks create no second input.

### SCN-13: Restart does not recreate a suppressed reminder

After SQLite reopen, current inline Human Review state is reconstructed from
the durable obligation, choice specification, and Action Set. Recovery does not
create a standalone choice reminder, and repeated convergence is idempotent.

## Implementation Decisions

### Domain Model

The affected bounded contexts are TraeX Hook Integration, Conversation
Projection, Completion Interaction, and Delivery and Operations.

A **Review Transport Decision** is a bounded transport value:

```ts
type ReviewTransportDecision =
  | Readonly<{ version: 2; intent: "none" }>
  | Readonly<{
      version: 2;
      intent: "human_review";
      question: string;
      default: string;
      options: readonly {
        id: string;
        label: string;
        message: string;
      }[];
    }>;
```

The canonical textual encoding is:

~~~text
```herdr-choice-list
<one compact JSON line>
```
~~~

Whitespace inside JSON is accepted for backward compatibility, but the owned
Skill and repair instruction emit only compact one-line JSON.

A **Reserved Protocol Region** is any assistant-authored fence beginning with
the exact reserved `herdr-choice-list` fence at a line boundary. It is never
user-visible content. Stripping a reserved region does not make it valid or
actionable.

A **Protocol Repair Attempt** is the single continuation permitted by the Stop
Hook. It contains no repeated Answer prose and no provider effect. Final-answer
selection combines it with sanitized accumulated prose.

An **Inline Human Review Owner** is a current-generation Primary Prompt,
Worker Turn, or Primary Segment whose delivered card contains the exact trusted
Action Set. Inline presentation and standalone notification are different
delivery effects.

The following invariants are normative:

#### INV-1: Exactly one terminal decision

Every eligible final turn ends with exactly one valid version-2 terminal
decision after at most one repair attempt.

#### INV-2: One-line owned encoding

The owned Skill and repair path emit compact single-line JSON. They never emit
pretty-printed protocol JSON.

#### INV-3: Reserved JSON is never visible in Feishu

Every reserved protocol region is removed from visible Markdown before any
Feishu presentation is planned or rendered, independent of protocol validity.

#### INV-4: Validation and visibility are separate

Stripping reserved JSON does not authorize choices. Only one valid terminal
`human_review` decision may create durable choice state.

#### INV-5: At most one repair

The first eligible Stop may block; a repeated Stop cannot block or recursively
create another repair.

#### INV-6: Original answer is preserved

A protocol-only repair attaches to sanitized accumulated prose. It does not
replace, duplicate, reorder, or create a second user-facing Answer.

#### INV-7: Inline controls are authoritative presentation

Human Review owners retain their obligation, trusted actor, choice
specification, and Action Set for inline rendering even when the standalone
choice reminder is suppressed.

#### INV-8: No standalone Human Review reminder

No new standalone choice reminder is reserved for an owner whose exact card
contains the actionable Human Review controls.

#### INV-9: Safe retirement only

An obsolete pending reminder may be dismissed only when durable evidence proves
no claim, attempt, checkpoint, delivery, or possible remote effect.

#### INV-10: Choice-free notice compatibility

Successful trusted completion without Human Review keeps the existing
standalone completion-notification contract.

#### INV-11: One-shot callback

Action Set consumption, actor/card/generation fencing, deterministic Submission
Intent identity, and uncertain-effect no-replay behavior are unchanged.

### Architecture

The hardened flow is:

```text
User Prompt
  -> UserPromptSubmit Hook
  -> explicit herdr-choice-list Skill context
  -> Answer plus compact terminal protocol
  -> first Stop validation
       -> valid: finish
       -> missing/invalid: one protocol-only repair
  -> final input selection sanitizes accumulated reserved regions
  -> Core canonical final message
  -> protocol parser separates visible Markdown and decision metadata
  -> SQLite final Segment/Prompt/Turn plus Action Set
  -> Feishu card projection uses visible Markdown plus structured choices
  -> button callback consumes once
```

`src/runtime/completion-choice-hook.ts` owns Hook eligibility, one-repair Stop
policy, and the bounded repair instruction. It does not infer Human Review
intent from Markdown or prose.

`plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md` owns compact
encoding instructions. The wrapper remains a bounded fail-open transport to
the version-compatible release helper.

`src/domain/completion-choice.ts` owns reserved-region scanning, sanitization,
validation, decision extraction, protocol-only continuation replacement, and
backward-compatible version-1 reads.

Core/TraeX adapters may persist structured `completion_choice` metadata, but
visible Markdown consumers receive only sanitized prose.

SQLite completion-notification stores own reminder suppression. The card
renderer does not decide whether an external reminder is needed.

### Stop Hook Contract

For an eligible first Stop:

| Inspection | Result |
| --- | --- |
| one valid terminal `human_review` | allow |
| one valid terminal `none` | allow |
| missing protocol | block once |
| malformed, incomplete, multiple, oversized, or nonterminal protocol | block once |
| terminal version-1 protocol from new output | block once |

The repair reason is constant and payload-free. It instructs the model to emit
only one compact terminal version-2 block and not repeat the Answer.

For `stop_hook_active=true`, the Hook returns no block response without an
eligibility call. This remains the recursion breaker.

### Visible Markdown Sanitization

Sanitization recognizes reserved fences only at a line boundary. It removes:

- complete valid blocks;
- complete invalid blocks;
- nonterminal complete blocks while preserving following prose;
- every block in a multiple-block answer;
- an incomplete final reserved block from its opening fence to end of input.

Validation runs against the unsanitized candidate set. Sanitization must not
reinterpret prose as JSON or parse arbitrary code fences.

### Standalone Reminder Suppression

For every owner kind with a current Action Set, the completion transaction
does not reserve a standalone choice reminder.

If an obsolete reminder reference exists, cleanup uses the existing safe
pending-effect predicate and additionally removes dependent prerequisite rows.
The obligation retains the state needed by inline rendering. A Segment
obligation stays `waiting_for_answer`; legacy Prompt/Worker state may use the
existing compatible suppressed state only if that state does not remove the
already persisted Action Set from its card.

Delivered or possible-effect reminders retain their IDs, prerequisites,
receipts, and immutable history.

### Behavior and Failure Modes

- Eligibility socket unavailable: UserPromptSubmit remains fail open; Stop
  cannot force a review on an unproven pane.
- Missing activation file or stale plugin version: wrapper emits no response;
  service diagnostics expose plugin activation health through existing
  lifecycle checks.
- First Stop missing protocol: block once with constant repair text.
- Repair still malformed: second Stop finishes without another block; reserved
  JSON remains hidden and no actionable choice is created.
- Valid protocol followed by citation or prose: first Stop treats it as
  nonterminal and repairs; visible prose after the invalid region is preserved.
- Multiple reserved blocks: no choices are activated until repaired.
- Existing pending reminder becomes claimed between discovery and cleanup:
  conditional dismissal loses, history is retained, and no destructive retry
  occurs.
- Crash after final card commit but before wake: restart uses durable state and
  still does not create a standalone Human Review reminder.

### Compatibility and Migration

No schema migration is required for reminder suppression. Existing obligation,
reply, prerequisite, and Action Set states are sufficient.

Version-1 choice blocks remain readable for retained historical turns.
New owned output and all repairs use version 2 only.

Already delivered standalone reminders remain immutable history. The change
does not issue remote message deletion.

## Live E2E addendum: prominent inline controls

A production Feishu E2E exposed two presentation gaps after the original W1
delivery. A long Turn Card placed its valid Human Review controls after fifteen
Timeline nodes, outside the card's immediately visible area, and a non-final
assistant message could retain reserved transport even though the terminal
message was sanitized.

When a current Human Review Action Set is present, its question, buttons,
Ignore action, and trusted mention must render before the Answer Timeline.
Choice-free completion notices retain their existing order. Reserved protocol
regions must be removed from every visible assistant channel, not only the
terminal `final` channel.

The plugin remains version `1.0.0` unless its public activation contract
changes. Source/release build identity still records the exact installed helper
path and socket.

## Testing Decisions

### Baseline

At starting revision `ca4b53d468a4124469e63b17aafe99e515479aad`:

- the worktree is clean;
- `npm test` passed 300 files and 4,576 tests;
- `npm run typecheck` passed;
- `npm run build` passed with build identity
  `sha256:dda672133fe061d0d8515a245f7abb0d87eb63f45117f726d3e49af163e33e8a`.

### Hook Tests

`tests/completion-choice-hook.test.ts` must prove:

- eligible missing protocol returns one blocking repair;
- valid compact `intent:none` and `human_review` pass without prose inference;
- malformed, nonterminal, multiple, oversized, and incomplete blocks repair;
- `stop_hook_active=true` never blocks or calls eligibility;
- repair reason contains no original prompt or Answer payload.

`tests/completion-choice-plugin-wrapper.test.ts` must prove the wrapper forwards
both allow and block responses byte-for-byte and still fails open for stale
activation.

### Protocol and Projection Tests

`tests/completion-choice-protocol.test.ts`,
`tests/herdr-event-projector.test.ts`,
`tests/traex-transcript-projector.test.ts`, and Answer/Worker projection tests
must prove:

- owned JSON is one line;
- valid, invalid, nonterminal, multiple, and incomplete reserved regions never
  appear in visible Markdown;
- valid terminal decisions alone become structured metadata;
- protocol-only repair replaces invalid accumulated transport content;
- surrounding prose is preserved;
- raw payload and reserved JSON are absent from Feishu card JSON.

### Notification Tests

Completion notification and conversation Segment tests must prove:

- Primary Prompt, Worker Turn, and Primary Segment inline Human Review create
  zero standalone choice reminders;
- choice-free successful completion still creates one ACK-gated notice;
- safe pending reminders are dismissed and prerequisites removed;
- claimed, attempted, checkpointed, delivered, and uncertain reminders are
  unchanged;
- restart and repeated convergence do not recreate reminders;
- replacement and retention no longer retain a final card solely for a removed
  pending choice reminder.

### Interaction Tests

Card interaction tests must prove business option, default, Ignore, duplicate,
wrong actor, stale card, and restart behavior remain unchanged.

### End-to-End Acceptance

After install and restart, an eligible Feishu turn presenting a decision must:

1. render one Answer/Task card with mention, question, business buttons, and
   Ignore;
2. display no protocol fence or JSON;
3. create no standalone `需要你的选择` message;
4. submit exactly one selected stored message;
5. preserve `intent:none` turns as ordinary answers with no buttons.

## Out of Scope

- Native TraeX/Core structured side-channel that removes JSON from the raw
  TraeX transcript.
- Changes to spec-coder's external plugin package beyond the Hook context and
  decision-cue compatibility needed by this repository.
- Deleting already delivered historical reminder messages.
- New approval semantics, more than four business choices, remote approval of
  terminal permissions, or arbitrary terminal input.
- Startup recovery, Core scheduling, Gateway substage, Card Context, and other
  P0/P1 optimization implementation; those resume after this W1 delivery.
- Installation, restart, production mutation, or push before Gate 3 and
  delivery verification.

## Further Notes

- Compact one-line JSON is a transport format, not a user-facing document.
- Review intent is authorized only by the validated protocol; natural-language
  prose is never parsed into an Action Set by the Stop Hook.
- Feishu JSON invisibility is a W1 guarantee; raw TraeX invisibility requires
  the later side-channel design.
- The Stop repair is a safety net. The normal path remains one original final
  answer with one terminal protocol and no continuation.
