# Process-forward answer and main cards

**Status:** approved design, awaiting specification review

## Purpose

Make the Lark answer experience feel like an observable remote workflow rather
than a final-text-only relay. A participant should be able to tell what TraeX
is doing, what it has already done, whether action is needed locally, and where
to read the complete answer. The design covers both the single-request answer
card and the binding-level main (project entry) card.

The bridge remains a durable workflow coordinator. Herdr is authoritative for
live pane state; SQLite remains authoritative for binding, prompt, queue, view,
and outbox facts. Lark cards remain projections only.

## Goals

- Preserve a complete, readable process trail for each prompt.
- Make the three newest process events visible by default and keep all older
  events available through an in-card collapsible panel.
- Keep the completed answer easy to read as a deliverable, while retaining its
  process context.
- Make blocked and failed states immediately actionable without adding remote
  approval or remote stop controls.
- Give the main card a clear session-overview role without duplicating full
  answer text.
- Retain existing stream ordering, frozen-page, FIFO, no-replay, and durable
  outbox guarantees.

## Non-goals

- Persisting CardKit collapse state, presentation preferences, or another
  display-specific read model.
- Cross-message jump links or buttons between the main card and answer cards.
- Remote TraeX approval, stop, or terminal control actions.
- Reformatting, summarizing, or semantically rewriting TraeX answer prose.

## Shared process-timeline renderer

Add a small pure renderer under `src/cards/`, tentatively
`progress-timeline.ts`. It accepts existing `RunProgressEvent` values and a
display context, then returns CardKit elements. It owns the common presentation
rules used by both card kinds:

- Process events stay in their durable order.
- The three newest events are visible by default.
- Older events are rendered in an expanded-by-default outer process panel but
  a collapsed inner "查看完整过程（N）" panel. This preserves the full trail
  while keeping the default scan path short.
- Each event is a bounded one-line entry using a kind icon (`🧠`, `🔎`, `📖`,
  `🛠️`, `🧪`, or `•`) and a compact state marker.
- Event labels are normalized, redacted through existing safe display paths,
  and length bounded. Raw terminal output, token counts, native task frames,
  subagent console status, and sensitive material are never rendered as a
  process item.
- The process heading gives aggregate context: running uses a done/total count,
  completed uses total completed steps, and blocked/failed foregrounds that
  work requires attention.

The module has no dependencies on SQLite, Herdr, Lark SDK calls, outbox work,
or coordinator decisions. It must not mutate its input.

## Answer card

`renderRequestAnswerCard` remains one card per prompt and retains its stable
answer markdown `element_id`. Its layout becomes:

```text
Header: TraeX reply / continuation page N       phase
Task title

Process timeline (all events available; newest three visible)
Action notice (blocked or failed only)
Answer body (the stable streaming element)
Footer: Pane · duration · page N where applicable
```

### Phase behavior

| Phase | Process presentation | Body and notice |
| --- | --- | --- |
| queued | No empty timeline; show a light accepted/queued state. | No fabricated answer. |
| running | Current work and newest events are visually prominent. | Streamed prose continues in the existing element; before prose exists, show a small receiving/preparing placeholder. |
| completed | Keep the full process timeline, but let the answer body dominate visually. | Show final prose; footer includes duration. |
| blocked | Heading says attention is needed. | An independent notice appears before the body and directs the participant to the corresponding local Herdr pane. |
| failed | Heading says attention is needed. | An independent failure notice appears before the body; do not present process-only output as a result. |

The renderer continues to filter native TraeX status and normalize Markdown
before showing answer prose. If a completed prompt has no displayable answer,
show an explicit "本次未产生可展示的回答" fallback.

### Continuation pages

Existing page behavior remains authoritative: a frozen page is never patched;
the newest page owns the stream updates; a too-large answer creates the next
page through the durable outbox. New presentation behavior is:

- Page headers use `✨ TraeX 继续回复 · 第 N 页`.
- The footer repeats the page number for orientation.
- A newly created page contains the process-timeline snapshot available at its
  creation. It does not backfill older frozen cards.
- The stream-finish continuation label is Chinese and explicit, for example
  `回答将在第 2 页继续`.

## Main project-entry card

`renderProjectEntryCard` is the durable binding-level session dashboard. It
does not duplicate a full request answer. Its layout becomes:

```text
Header: project or session title                 binding phase
SPACE · PANE · QUEUE

Current work or next queued request
Session process timeline (newest three visible, older collapsed)
Queue summary
Latest-result preview (small, filtered tail only)
Action notice when local Herdr interaction is required
```

### Main-card behavior

- While running, foreground the current task, aggregate progress, and latest
  active event.
- When done, show the latest completed result as a short filtered tail and
  retain the process trail. If work is queued, say that the next request is
  waiting rather than implying it is already running.
- When queued, identify queue position and preserve FIFO wording.
- When blocked, error, orphaned, draining, or archived, put the actionable
  session notice above previews. It only directs the user to Herdr or to the
  existing recovery/new-session flow.
- The full answer remains on its request answer card. The main-card preview is
  bounded and continues to remove native task frames and subagent console
  status.
- The full history is a pure collapsible panel, not a link or a new persisted
  interaction state.

## Data and delivery constraints

No domain, SQLite schema, or workflow protocol changes are required. The
renderers consume existing `TopicViewState`, `RunCardView`, `progressEvents`,
answer text/segments, and answer-page fields. Specifically, the change must
not alter:

- prompt acceptance, FIFO dispatch, steering, or the no-automatic-replay rule;
- SQLite transaction boundaries, projections, or outbox idempotency keys;
- CardKit stream sequence ordering within an answer element;
- the rule that only the newest answer page is mutable;
- authority boundaries: Lark output never establishes workflow state.

Process changes update the active projected cards through the existing normal
outbox paths. They never resubmit a prompt to TraeX.

## Tests and verification

Add focused coverage for:

- shared process timeline: kind/state display, bounded labels, latest-three
  split, complete collapsed history, and empty input;
- answer card: running, completed, blocked, failed, no-result fallback,
  process/body hierarchy, and continuation title/footer;
- main card: current-work summary, queue state, full-but-collapsed process
  history, bounded answer preview, and actionable state precedence;
- integration: updating process events only updates the active answer page,
  continuation creation includes its current process snapshot, and frozen pages
  remain unmodified;
- Markdown and terminal-safety regression cases for process labels and answer
  previews.

Before handoff, run the affected Vitest files, `npm run typecheck`, and
`npm run build`; run `npm test` because this spans shared card rendering and
projection-facing behavior.

## Acceptance criteria

1. Every non-empty process history is fully present in the card while only its
   latest three entries are visible without expanding nested history.
2. The answer card communicates progress during a run and preserves a readable
   final answer at completion.
3. The main card reports binding-level state, queue context, and a bounded
   latest-result preview without duplicating complete answers.
4. Blocked and failed cards direct the participant to local Herdr handling and
   expose no remote high-risk control.
5. Existing delivery, pagination, safety filtering, and no-replay tests remain
   valid.
