# Answer Timeline Consistency Design

## Goal

Make Primary and Worker Answer output converge with the public Herdr/TraeX
timeline without exposing private reasoning or verbose Skill output. Repair rich-text
continuation delivery without weakening the durable delivery fences, and remove
spurious blank lines from compact Tool result previews.

This design covers five related defects:

1. a rich-text continuation can dead-letter when a cursor moves within one Tool
   item but the legacy integer `pageStart` does not increase;
2. fallback JSONL projection can publish a `phase: final_answer` Assistant message
   as commentary and then publish `task_complete.last_agent_message` again;
3. public Assistant commentary is labeled as private thinking;
4. structurally recognized Skill calls lose their identity and expose their output;
5. Tool result previews can begin with blank lines inside the displayed code block.

## Chosen approach

Use the structured Answer timeline as the authority at every boundary that already
has it. Keep `pageStart` as a compatibility and diagnostics field, but stop using
strict integer growth as proof that a rich-text timeline continuation progressed.
Preserve semantic message and Tool types through projection so rendering does not
need to infer intent from text. Apply whitespace cleanup only to Tool previews.

This is preferred over two alternatives:

- Encoding section and section offset into a synthetic integer `pageStart` would
  make the field monotonic, but would silently change its historical meaning and
  complicate recovery and operational inspection.
- Relaxing the existing `pageStart` check without a replacement cursor fence would
  allow stale or cyclic continuation intents. It fixes the observed rejection but
  weakens delivery correctness.

## Rich-text continuation contract

`AnswerTimelineCursor` is the canonical position for timeline-backed rich-text
pages. Cursor ordering compares, in order:

1. `itemIndex`;
2. the section order `message`, `command`, `result`;
3. the effective section offset (`offset`, falling back to `markdownOffset`).

The implementation will expose one shared cursor comparison helper rather than
duplicating this ordering in the workflow, SQLite reservation, and outbound target
validation. A continuation is valid only when its next-page start cursor is
strictly after the current page start cursor.

The existing `answer_timeline_page_checkpoints` rows remain the durable cursor
authority. Reserving a continuation atomically:

- verifies the planned cursor is strictly after the active page checkpoint start;
- reserves the frozen-page update with that cursor;
- creates the next checkpoint with the same cursor; and
- enqueues the next rich-text reply.

Before delivering the reply, outbound target validation verifies the expected next
page index, the existing Answer identity, and the next checkpoint cursor. Equal
legacy `pageStart` values are accepted only when the structured checkpoint proves
strict cursor progress. Non-timeline and historical paths retain their current
integer checks. No frozen page is patched and no prompt is replayed.

`pageStart` remains populated for compatibility. Its value may repeat across two
rich-text pages when both begin in different sections of the same Tool item; code
must not treat that equality as lack of progress.

## Assistant message phases and final-answer fallback

The fallback TraeX JSONL projector will parse the optional Assistant message
`phase` field. It applies this policy:

- `commentary` and an absent/unknown public phase produce `agent_message`;
- `final_answer` produces `final_answer`, never `agent_message`;
- private reasoning records remain excluded and never become timeline content.

An explicit `phase: final_answer` item is the preferred final content.
`task_complete` remains the lifecycle completion signal. Its
`last_agent_message` is used as a bounded fallback only when the exact turn has not
already emitted an explicit final item. This avoids both an extra commentary row
and a second final row, including the known case where `last_agent_message` is only
a prefix of the explicit final text.

The native Herdr event path already distinguishes commentary and final messages and
keeps that behavior unchanged. Stable source item IDs continue to drive timeline
deduplication.

## Public commentary presentation

`agent_message` means public Assistant progress, not private reasoning. Both the
CardKit and rich-post renderers will label its compact three-line preview as
`💬 进展`. The existing exact omitted-line count remains. `final_answer` remains
unlabeled full Markdown subject to normal pagination.

No `agent_reasoning_raw_content`, reasoning history item, system message, developer
message, or protocol record enters the Answer timeline.

## Skill presentation

Add `skill` to `AnswerTimelineToolCategory`. The existing structural Skill
detection in `tool-activity-projector` remains authoritative: only trusted
`SKILL.md` paths and their paired calls become Skill activity. Projection preserves
that category instead of collapsing it to `step`.

Both renderers display a compact title/status such as
`🧩 Skill · herdr · ✓`. Skill result bodies are never rendered, regardless of
success or failure. The lifecycle state remains visible, while diagnostics stay in
the Herdr pane and service logs. Other Tool categories keep their current collapsed
panels and first-three/last-three result previews.

## Tool-result whitespace normalization

Whitespace cleanup is presentation-only and applies before Tool preview line
counting:

1. normalize CRLF/CR to LF;
2. remove the recognized `Script completed`, `Wall time ...`, `Output:` wrapper;
3. remove leading and trailing blank lines from the remaining Tool output;
4. retain meaningful interior blank lines;
5. calculate the first-three/last-three preview and exact omitted count from the
   cleaned lines.

This removes the observed ` ```text\n\n\n{...}` output without globally trimming
Assistant or final-answer Markdown. It also avoids attributing the defect to Feishu
post layout: durable outbound payload evidence shows the blank lines already exist
inside the Tool result fence.

## Compatibility and recovery

No schema migration is required. Existing cursor JSON already carries the needed
fields, and legacy checkpoints without `section` or `offset` compare using their
existing `itemIndex` and `markdownOffset`. Existing rich-text pages continue to be
recoverable. The change affects only validation of new continuation reservations
and deliveries.

Canonical timeline rows, idempotency keys, lane ordering, prompt FIFO behavior,
observer attachment, and the no-replay guarantee remain unchanged. Formatting and
compaction do not rewrite SQLite source state.

## Verification

Focused regression tests will prove:

- a Tool command-to-result continuation with equal legacy `pageStart` values is
  reserved and accepted when its structured cursor advances;
- an equal or regressing structured cursor is rejected even if page indices advance;
- restart/retry target validation reads the same durable cursor contract;
- `phase: commentary` becomes one `agent_message`;
- `phase: final_answer` becomes one `final_answer`, and matching/prefix
  `task_complete.last_agent_message` does not add another timeline item;
- a completion without an explicit final still uses the bounded lifecycle fallback;
- commentary renders as `💬 进展` in CardKit and rich-post output, while private
  reasoning stays absent;
- Skill renders its name and state but no result body in either renderer;
- wrapped and unwrapped Tool results drop only leading/trailing blank lines, retain
  interior blanks, and compute the exact omitted count after cleanup.

After focused tests, run the complete Vitest suite, `npm run typecheck`, and
`npm run build`. Then install the immutable release, force-restart through the
supported lifecycle command because the current observer may still be active, and
verify readiness, build identity, outbox health, and a real Answer projection.
