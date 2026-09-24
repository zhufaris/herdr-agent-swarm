# Terminal-Aligned Answer Cards Design

## Objective

Make Primary and Worker Answer Cards preserve the meaningful event order visible
in the Herdr terminal while retaining a native, compact Lark CardKit presentation.
Agent messages, tool calls, tool results, blocked states, and final answers appear in
one chronological timeline. Tool details are collapsed by default and remain
redacted.

This is semantic alignment, not a terminal screenshot. ANSI sequences, transport
envelopes, reasoning content, credentials, and other internal protocol data must
never be copied into Lark.

## Current behavior and problem

`TraexTranscriptProjector` currently emits answer text and a separate collection
of `toolActivities`. The view reducers use the text for Answer pages and the tool
activities for progress summaries. `foldFinalAnswerContent` can recognize a
bridge-generated `Ran` block and render it as a collapsed panel, but this is a
late text transformation rather than a durable event model.

This split loses information needed for a faithful timeline:

- tool activity can appear apart from the Agent text that preceded or followed it;
- a tool call and its result are represented as text fragments plus summary state;
- presentation code must infer structure from generated Markdown;
- Primary and Worker paths can render the same transcript differently;
- pagination can split a logical tool item or freeze it before its result arrives.

## Chosen experience

The Answer Card uses one chronological timeline. It preserves canonical transcript
order, but uses Lark-native elements instead of emulating a terminal window.

```text
HERDR ANSWER · PRIMARY 51g1
Working

User task
Align Answer Cards with the Herdr terminal

Execution timeline

Inspecting the current Answer Card implementation...

> Read · src/cards/run-card.ts · succeeded
  collapsed; expand for redacted details

The existing renderer separates tool progress from the answer...

> Command · npm test · succeeded
  collapsed; expand for redacted command and output

The card structure has been updated.

Completed · 2 tools · 1m 42s
Primary 51g1 · Pane wN:p3S
```

The `>` rows above denote CardKit collapsed panels, not literal Markdown in the
delivered card. Agent text remains normal Markdown. Tool panels are collapsed by
default.

## Canonical timeline model

Introduce a domain-owned ordered item model rather than making CardKit or parsed
Markdown authoritative:

```ts
type AnswerTimelineItem =
  | {
      kind: "agent_message";
      id: string;
      sequence: number;
      markdown: string;
    }
  | {
      kind: "tool";
      id: string;
      sequence: number;
      category: "read" | "search" | "edit" | "command" | "test" | "step";
      label: string;
      command?: string;
      resultPreview?: string;
      state: "running" | "succeeded" | "failed";
    }
  | {
      kind: "status";
      id: string;
      sequence: number;
      label: string;
      state: "running" | "blocked" | "failed";
    }
  | {
      kind: "final_answer";
      id: string;
      sequence: number;
      markdown: string;
    };
```

The exact persisted representation may use normalized rows or a versioned JSON
projection, but it must preserve these semantics:

- item identity is stable across polling and restart;
- `sequence` is monotonic within one turn and defines display order;
- a tool result updates the matching tool item while that item remains mutable;
- adjacent Agent fragments may merge only when no tool or status item lies between
  them;
- final-answer identity comes from the trusted turn lifecycle, not formatting
  heuristics;
- unknown supported tool events degrade to `step` rather than disappearing.

SQLite remains the durable authority. Projector caches and runtime wake-ups may
reduce latency but cannot define ordering, completion, or replay behavior.

## Boundaries and responsibilities

### Transcript projection

`TraexTranscriptProjector` parses canonical transcript envelopes and emits typed
timeline deltas. It owns event identity, call/result correlation, bounded text,
and redaction. It does not know CardKit layout or page boundaries.

Reasoning events may update a compact main-card status label but never create an
Answer timeline item. User input is represented by existing request metadata, not
duplicated into the Answer stream.

### Durable projection

The Primary Prompt and Worker Turn aggregates persist timeline changes together
with their canonical answer projection and outbox intent. Any new schema is an
ordered additive migration and is protected by the instance lease write fence.
Tool updates are idempotent by stable item ID and cannot reorder earlier items.

During compatibility rollout, existing `answer` and page records remain readable.
Old turns without timeline data use the current answer renderer. New turns write
the timeline while retaining the canonical answer text required by existing
recovery and audit paths. Removing legacy fields is outside this change.

### Presentation

A shared pure `AnswerTimelineRenderer` converts timeline items into CardKit
elements. Both Primary Answer pages and Worker Task Answer pages use it. Their
outer cards continue to own identity, title, state, and action controls.

The renderer must not parse raw TraeX envelopes. The existing
`foldFinalAnswerContent` remains the legacy-text fallback and may share small
formatting helpers with the timeline renderer.

## Tool presentation

Every visible tool item has a compact header containing category, bounded target,
and state. The detail panel is collapsed by default.

- `running`: blue/neutral border and an in-progress marker;
- `succeeded`: grey or green completion marker;
- `failed`: red marker with bounded, safe failure detail;
- command tools: fenced, redacted command followed by fenced, redacted output;
- read/search/edit tools: normalized target and a bounded result summary where
  useful;
- no useful output: explicit completion text rather than an empty panel.

Commands and results are redacted before persistence. The renderer applies a
second defensive bound but is not the primary security boundary. Long output is
truncated at a safe Markdown boundary and ends with an instruction to inspect the
corresponding Herdr Pane.

## Streaming and pagination

The existing 9,000-character Answer page budget remains. Page planning operates
on complete timeline items instead of arbitrary character offsets whenever
timeline data is available.

- Agent Markdown may split only through the existing Markdown-safe splitter.
- A tool panel is indivisible. Its detail is truncated to fit rather than split
  across cards.
- The current active page may update a running tool item in place.
- A frozen page is immutable. If a result arrives after its tool-call page was
  frozen, the active page receives a compact completion item referencing the
  original tool label and ID.
- Continuation pages expose page number, previous-page relationship, and the same
  Primary or Worker identity.
- Delivery checkpoints advance only after successful CardKit delivery. Restart
  resumes from SQLite without duplicating timeline items.

The canonical timeline remains independent from rendered pagination. Page
selection, truncation, and collapsed-panel construction are render-only
transforms and never rewrite transcript state.

## Relationship to other cards

- **Primary Main Card:** shows state, recent readable progress, and at most the
  current tool summary. It does not duplicate the full Answer timeline.
- **Worker Main Card:** uses the same identity/runtime row and current-activity
  vocabulary as Primary Main.
- **Worker Task Card:** uses the shared timeline renderer for its answer pages.
- **Command Status Card:** continues to represent command admission and execution;
  command status is not mixed into an Agent Answer.
- **Human Review:** inserts an orange blocked timeline item at the observed point
  and updates the relevant Main Card. Existing notification and local-only
  approval boundaries remain unchanged.
- **Project and Pane cards:** may reuse typography, spacing, metadata rows, and
  state colors, but do not adopt the Answer timeline model.

## Failure and recovery behavior

- Malformed or unsupported transcript items are ignored with bounded structured
  diagnostics; safe Agent output continues to render.
- If typed timeline projection fails, the turn falls back to the existing
  redacted answer-text path rather than blocking delivery.
- Missing tool results leave the tool in `running` until turn termination, when it
  becomes a bounded failed or incomplete item according to the trusted lifecycle.
- Lark failures remain durable outbox failures. A retry renders or sends the same
  projection revision and never repeats the Agent or tool action.
- Restart never replays an externally dispatched turn. It reconstructs timeline
  state from SQLite and continues exact-turn observation under existing identity
  fences.

## Security and privacy

- Run the existing secret redaction before any command, output, label, or Agent
  Markdown enters durable timeline storage.
- Preserve bounded parsing and payload limits.
- Never expose environment values, authentication material, raw protocol
  envelopes, hidden reasoning, or arbitrary terminal buffers.
- Keep remote approval and arbitrary terminal-input capabilities out of cards.
- Structured logs may include turn, prompt, binding, pane, and item IDs, but not
  raw command arguments or result bodies.

## Testing strategy

Focused tests must prove:

1. transcript events produce a stable sequence of Agent, tool, status, and final
   items;
2. calls and results pair by stable ID and update without duplication;
3. Agent fragments do not merge across a tool boundary;
4. reasoning, protocol data, ANSI sequences, and secrets do not enter the
   timeline;
5. tool panels are collapsed and command/result content is bounded and redacted;
6. running tools converge to succeeded or failed;
7. pagination does not split a tool item and frozen pages are never patched;
8. a late result produces a linked completion item on the active page;
9. restart recovery neither loses nor duplicates timeline items;
10. Primary and Worker paths produce the same timeline semantics;
11. old rows without timeline data retain the existing rendering behavior;
12. durable writes, outbox creation, and lease fencing remain transactional.

Before handoff, run affected transcript, reducer, SQLite, Answer page, Worker card,
CardKit, recovery, and event integration suites, followed serially by typecheck,
build, architecture check, documentation audit, public audit, and the full test
suite.

## Non-goals

- Pixel-level terminal emulation or ANSI rendering in Lark.
- Publishing model reasoning or raw protocol traffic.
- Changing command admission, remote approval, or Human Review notification
  policy.
- Replacing SQLite or the durable outbox with an in-memory event stream.
- Destructive migration or immediate removal of legacy answer fields.
- Rewriting historical frozen cards.

## Success criteria

For a new Primary or Worker turn, a user can compare the Answer Card with the
meaningful Herdr terminal history and see the same Agent/tool ordering. Tool
details are available on demand without dominating the card. Restart, pagination,
and Lark retries preserve exactly-once projection semantics, and old turns remain
readable without migration-time rewriting.
