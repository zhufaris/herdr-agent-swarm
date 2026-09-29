# Pane-Aligned Answer Card Design

## Status

Approved for implementation on 2026-09-29.

## Problem

Herdr Agent Swarm already persists a canonical Answer timeline containing Agent
messages, tool calls, status changes, and final answers. Its two presentation
paths do not expose that structure consistently:

- CardKit timeline cards can render collapsible Tool panels, but the primary
  live Answer path currently creates and updates a plain rich-text message.
- The rich-text renderer flattens Tool activity into Markdown, so commands are
  not collapsible and Primary and Worker Answers can look different.
- The card layout does not explicitly request wide-screen presentation, which
  makes long Markdown and code harder to read on desktop.
- Emoji, action names, short command summaries, and terminal states are defined
  in more than one renderer and can drift.

The desired result is an Answer Card whose reading rhythm matches a Herdr Pane:
Agent prose remains the main line of the conversation, structured Tool activity
appears in chronological order between prose segments, commands are easy to
scan and expand, and the final answer has an unmistakable completion boundary.
Transient status events are retained durably but are not rendered as a second
process log. The task plan is the single progress summary shown at the bottom.

This design changes Answer Cards only. Main Cards retain their current compact
layout and width.

## Goals

1. Use a wide CardKit Answer surface for new Primary and Worker turns.
2. Keep Agent Markdown visually clean and uninterrupted by redundant labels.
3. Interleave Tool activity in canonical Core event order as collapsed panels.
4. Show a safe short command in the collapsed title and full bounded details on
   expansion.
5. Preserve native incremental text rendering while allowing Tool panels to be
   inserted and updated during a live turn.
6. Make Primary, Worker, continuation, and completed Answer pages use one
   presentation model.
7. Preserve durable ordering, pagination, restart recovery, frozen-page rules,
   prompt idempotency, and the existing security boundary.

## Non-goals

- Changing Main Card content or layout.
- Reproducing terminal cells, colors, cursor control, or raw scrollback.
- Reading pane text or Agent JSONL as an Answer fallback.
- Adding a new Herdr Core event type.
- Migrating an already-created rich-text message into a CardKit entity in the
  middle of its turn.
- Expanding failed Tool panels automatically.

## Chosen approach

Use one semantic Answer timeline and one shared CardKit presentation model.
Agent Markdown is emitted as ordinary Markdown nodes. Each Tool event is emitted
as an indivisible collapsed panel. A live page has exactly one mutable Markdown
slot; completed prose before a Tool boundary becomes immutable, the Tool panel
is inserted by an ordered structural update, and a new mutable Markdown slot is
created after it.

This combines CardKit's element-level content updates for text with sequenced
whole-card updates for structural changes. It avoids flattening tools into
Markdown and avoids attempting to insert a CardKit panel into a rich-text post,
which the provider does not support.

Rejected alternatives:

- **Terminal-line replica:** closer visually to terminal output but too dense on
  mobile and obscures the Agent's prose.
- **Grouped activity panel:** compact, but hides chronology and makes an
  individual running or failed Tool difficult to update and inspect.
- **Markdown-only tools:** compatible with rich-text messages, but cannot meet
  the requirement that commands remain collapsible.

## Visual hierarchy

An Answer page is ordered as follows:

1. Answer header and compact runtime metadata.
2. Agent Markdown and Tool panels in canonical timeline order.
3. A distinct final-answer boundary when a `final_answer` item exists.
4. One task-progress section at the bottom.

The task-progress section is the final content block, after Answer prose, Tool
panels, notices, and actions. It contains semantic plan steps rather than a
second copy of read/search/edit activity. Earlier frozen continuation pages do
not need a live task list; the current active page and terminal tail page do.

Example:

```text
✨ TraeX 回复                         project · pane · elapsed

Agent Markdown remains ordinary Markdown.

🖥️ Ran · npm test · ✅              collapsed
📖 Read · src/main.ts · ✅           collapsed
✏️ Edited · 3 files · ✅             collapsed
⌨️ Input · session 263 · ✅          collapsed

More Agent Markdown.

✅ 最终回答
Final Answer Markdown.

📋 任务进度 · 3/3
```

Agent messages do not receive a per-message heading or Emoji. This keeps prose
readable and prevents a long answer from looking like a log.

## Semantic vocabulary

Tool categories have one shared label and Emoji map:

| Category | Display |
| --- | --- |
| read | `📖 Read` |
| search | `🔎 Search` |
| edit | `✏️ Edited` |
| command | `🖥️ Ran` |
| test | `🧪 Tested` |
| input | `⌨️ Input` |
| delegated Agent work | `🤖 Delegated` |
| unknown Tool | `🔧 Tool` |

Tool states use semantic Emoji:

| State | Display | Border |
| --- | --- | --- |
| running | `⏳` | blue |
| succeeded | `✅` | grey |
| failed | `❌` | red |

Skill loads use `🧩 Skill · <name> · <state>`. Their panels retain only the
bounded Skill name and success/failure summary. They never include `SKILL.md`
contents, the complete Skill instructions, or the raw tool-result body.

Status items remain part of the durable canonical timeline but are omitted from
the Answer rendering because the bottom Task List and card lifecycle already
represent that state. A final-answer item starts with `✅ 最终回答`.

## Collapsed title and expanded details

The title format is:

```text
<category emoji> <action> · <safe short target> · <state emoji>
```

For a command, the short target is the first non-empty line after secret
redaction, ANSI/control removal, and whitespace normalization. It is limited to
88 Unicode code points. Other tools use their safe path, query, file count,
session label, Worker name, or normalized tool name.

Command and Input details use a Bash fence. Tool output uses a text fence:

````markdown
```bash
npm test
```

```text
218 files passed
```
````

All Tool panels default to collapsed, including failed tools. Empty command and
result sections are omitted. `write_stdin` shows only its bounded input preview;
its returned background-process output is not repeated in the Input panel.

## Wide-screen CardKit contract

New Answer views request wide-screen presentation. The provider-neutral Gateway
View receives additive optional presentation fields for width and native stream
behavior. The Feishu materializer maps those fields to:

```json
{
  "wide_screen_mode": true,
  "update_multi": true,
  "streaming_mode": true,
  "streaming_config": {
    "print_frequency_ms": 70,
    "print_step": 1,
    "print_strategy": "fast"
  }
}
```

When the page becomes terminal, only `streaming_mode` changes to `false`;
wide-screen mode remains enabled. Feishu can still adapt the layout on mobile.
Main Card views do not request wide-screen mode.

The Gateway contract owns semantic presentation preferences rather than raw
Feishu JSON keys. Existing schema-version-1 views without the additive fields
retain standard width and current streaming behavior.

## Live update lifecycle

### Page creation

A new turn creates a CardKit entity and replies with its card reference. The
card contains header metadata, any existing timeline prefix, and one mutable
Markdown node carrying the page's canonical `answerElementId`.

Each active page has exactly one element ID. Previously completed Markdown nodes
and Tool panels have no element ID. This preserves the current stream-target
fence and avoids tracking an unbounded set of mutable nodes.

### Text delta

When only the current Agent Markdown grows, the outbox issues a sequenced
element-content update for the active slot. CardKit performs native incremental
printing. The update contains the complete safe content for that slot, not a
terminal byte stream.

### Tool boundary

When a Tool starts:

1. The current Markdown slot is materialized as an immutable Markdown node.
2. A collapsed running Tool panel is inserted after it.
3. A new empty Markdown node receives the same page-level active element ID.
4. One sequenced whole-card update publishes the new structure.

Later Agent text targets the new slot. When the Tool finishes, a structural
update changes the same stable Tool item's state and adds its bounded result.
The provider may reset a user's temporary expanded/collapsed choice during a
structural update; the canonical default remains collapsed.

### Completion

A `final_answer` item is preceded by the `✅ 最终回答` marker and retains native
Markdown formatting. The page footer renders task progress once, after the
timeline. The final ordered operation disables streaming and changes the Answer
header to its completed green state.

## Ordering and durability

- Herdr Core Agent Events remain the only structured Answer authority.
- SQLite retains canonical timeline items, page cursor, delivery mode, and the
  single monotonically increasing Answer sequence.
- Element-content updates and whole-card structural updates share that sequence
  and the same durable outbox lane.
- Workflow intent is persisted before any provider effect.
- A retry can repeat only the provider delivery intent; it cannot repeat a
  TraeX prompt.
- Tool IDs remain stable from running to terminal state, so a result updates the
  semantic item rather than appending a duplicate.

The renderer remains a pure projection. It does not write transformed Markdown
lengths back into canonical timeline offsets.

## Pagination and late results

The existing payload-aware page planner and current page-size policy remain in
force; this work does not shorten Answer pages. Agent Markdown may split only at
safe renderer boundaries. Tool and status panels are indivisible and never span
pages.

When a page freezes, it is never patched again. A Tool result that arrives after
its original page froze is projected onto the active page as a completion item
with an origin reference. Continuation pages keep wide-screen mode and the same
header, Emoji, and Tool rules.

## Deployment transition

New Answer pages created after activation use `delivery_mode = 'streaming'` and
the CardKit mixed timeline. A page already persisted as `rich_post` keeps that
mode until its turn finishes. The service must not target a Post message with a
CardKit operation or replace an in-flight message merely for presentation.

This is a bounded handoff for durable in-flight work, not a runtime fallback.
No new turn chooses rich-text delivery. CardKit failures use the existing retry,
quarantine, and dead-letter behavior. They do not switch formats silently.

No Herdr Core schema change or SQLite schema migration is required. Existing
delivery-mode and timeline storage already distinguish the two surfaces.

## Security and failure behavior

- Tool inputs are redacted and bounded at projection time and again at render
  time.
- ANSI escapes, unsafe control characters, and unsupported fence content are
  removed or normalized before delivery.
- Empty commands do not produce empty code blocks.
- Unclosed streaming Markdown fences, links, and inline-code spans are withheld
  until they form a safe render boundary.
- Unknown tools degrade to `🔧 Tool` without exposing raw argument JSON.
- Structural or content update failures remain durable outbound work and retain
  their identity and sequence.
- Frozen pages, stale generations, mismatched message/card IDs, and stale
  element IDs fail closed through existing target validation.

## Code boundaries

- `src/domain/answer-timeline.ts` retains the provider-neutral timeline items.
- A shared Answer presentation module owns labels, Emoji, short targets, state
  appearance, and bounded panel details.
- `src/cards/answer-timeline.ts` renders the shared model to Gateway View nodes.
- `src/cards/answer-timeline-page.ts` remains the item-aware pagination seam.
- Primary and Worker card builders consume the same renderer and configuration.
- Gateway View gains additive semantic width and stream-presentation options.
- `src/gateways/feishu/cardkit-view.ts` maps those options to CardKit JSON.
- The Answer projection/outbox workflow selects streaming CardKit for new pages
  and preserves the persisted delivery mode for pages already in flight.
- `src/runtime/answer-rich-text.ts` remains only for completing already-persisted
  `rich_post` pages and can be removed after no durable rows require it in a
  later, separately approved cleanup.

## Test strategy

Focused unit tests must prove:

- the complete category and state Emoji vocabulary;
- safe 88-code-point command summaries;
- collapsed Bash/text details and omission of empty sections;
- double redaction, ANSI/control removal, and `write_stdin` output suppression;
- Agent Markdown without redundant headings and Final Answer with its boundary;
- wide-screen and native streaming materialization for Answer views only;
- one active element ID per page after every structural transition.

Workflow and integration tests must prove:

- chronological Agent/Tool/Agent interleaving for Primary and Worker Answers;
- content update followed by Tool insertion followed by a new content update;
- one monotonic sequence across structural and content operations;
- restart recovery from the persisted page cursor and delivery mode;
- page rollover without splitting a Tool panel or rewriting a frozen page;
- late Tool completion on a continuation page;
- existing active `rich_post` work finishes in place while a new turn uses
  CardKit;
- retries never cause a duplicate prompt or duplicate Tool item.

Before handoff, run the affected Vitest files, `npm run typecheck`, `npm run
build`, the full `npm test -- --run` suite, and `git diff --check`.

## Acceptance criteria

The work is complete when all of the following are true:

1. A new Primary or Worker Answer appears as a wide CardKit card.
2. Agent Markdown streams naturally without a per-message label.
3. Tool panels appear in canonical order and default to collapsed.
4. A command title contains its category Emoji, safe short command, and state
   Emoji; expansion shows bounded Bash and result fences.
5. `write_stdin` retains its safe code-only Input behavior.
6. Final Answer and terminal card state are visually explicit.
7. Main Card layout is unchanged.
8. Existing `rich_post` turns complete without surface-type mutation.
9. Pagination, frozen-page, recovery, target-fence, and idempotency invariants
   pass focused and full regression tests.
