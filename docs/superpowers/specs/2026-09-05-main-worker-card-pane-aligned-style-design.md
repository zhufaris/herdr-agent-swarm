# Pane-Aligned Primary and Worker Card Style Design

## Goal

Apply the Answer Card's restrained, type-oriented visual language to the
Primary Main Card, Worker Main Card, and Worker Task Card. Emoji identify the
meaning of structured sections and states; they do not decorate arbitrary
assistant prose. Each card keeps its existing operational purpose, actions,
durability, and update behavior.

## Scope

This change covers pure CardKit rendering for:

- the Primary Main Card rendered by `renderProjectEntryCard`;
- the Worker Main Card rendered by `renderWorkerMainCard`;
- the Worker Task Card rendered by `renderWorkerTurnCard`;
- progress and activity rows shared by those cards where necessary for visual
  consistency.

It does not change domain state, prompt routing, Worker scheduling, CardKit
outbox ordering, pagination offsets, recovery, or navigation targets.

## Visual language

The cards share one semantic vocabulary while retaining different layouts:

| Meaning | Marker | Usage |
| --- | --- | --- |
| Primary | `🧭` | Primary Main Card identity |
| Worker | `🤖` | Worker Main Card identity and Worker summaries |
| Task/request | `🎯` / `💬` | Current task, Task Card identity, request body |
| Workspace | `📂` | Workspace path |
| Branch | `🌿` | Git branch |
| Model | `🧠` | Selected model and active processing |
| Queue | `📨` | Queued work |
| Recent history | `🕘` | Recent Worker tasks |
| Runtime | `🖥️` | Pane, session, generation, and runtime metadata |
| Progress | `📈` | Progress section |
| Navigation | `🔗` | Card navigation controls when representable in text |
| Success | `✅` | Completed or ready |
| Waiting | `⏳` | Queued or preparing |
| Warning | `⚠️` | Blocked, uncertain, degraded, or actionable notice |
| Failure | `❌` | Failed |
| Stopped | `⏹️` | Cancelled or stopped |
| Archived | `📦` | Archived or terminated |

Tool activity continues to use the Answer Card mapping: `⚙️ Ran`, `📖 Read`,
`🔍 Search`, `✏️ Edit`, `🧩 Skill`, `⏳ Wait`, `🤖 Agent`, and `🛠️ Tool`.
Existing per-event state icons remain visible when they add independent status
information. A heading or metadata field receives at most one leading semantic
marker.

## Primary Main Card

The header becomes `🧭 <Primary title>` while retaining the existing phase
color and `HERDR PROJECT · <state>` subtitle. Body sections use concise typed
headings:

- `📊 状态` for the project/work summary when no richer live status exists;
- `⚙️ 最近活动` for recent progress events;
- `💬 最新消息` for the bounded answer preview;
- `🤖 Workers` for Worker summaries;
- `🖥️ Runtime` for the existing runtime footer.

Existing live-status layouts, recovery callouts, Worker links, limits, and
redaction remain unchanged. Emoji are added at render time only.

## Worker Main Card

The header becomes `🤖 Worker · <name>`. The body remains compact and keeps the
current ordering, with typed labels for `👤 Owner`, `🖥️ Primary pane`,
`🧾 Session`, `⚙️ Runtime`, `📂 Workspace`, `🌿 Branch`, `🧠 Model`,
`🎯 Current Task`, `📨 Queue`, and `🕘 Recent Tasks`.

Recent task rows use the shared state markers. The existing buttons and frozen
session note remain functionally identical; the frozen note gains the archived
marker. No new controls are introduced.

## Worker Task Card

The header becomes `🎯 <worker> · Task <id>`. Its body uses `💬 请求`,
`📈 进度`, and `🔗 承接任务` section labels. The task lifecycle continues to
use the established state markers in metadata and empty-output messages.

Worker output is rendered through the same presentation-only activity styling
as Primary Answer output. Recognized tool rows receive the shared type emoji,
and command details retain their current Worker Task streaming behavior. This
change does not introduce Answer Card finalization panels into Worker Task
Cards; that would require a separate durability design.

## Rendering rules

- Apply markers only to renderer-owned headings and exact structured activity
  rows. Never infer a type from arbitrary prose.
- Do not transform text inside fenced code blocks.
- Do not persist emoji-decorated copies as canonical transcript content.
- Keep existing redaction and length limits in force.
- Preserve existing card templates and phase colors. Emoji supplement color;
  they do not replace state text.
- Preserve button labels unless a concise emoji improves scanning without
  changing the action's meaning.

## Testing

Focused tests cover:

- Primary, Worker Main, and Worker Task headers and section labels;
- state-marker consistency across queued, running, blocked, completed, failed,
  cancelled, uncertain, archived, and terminated states;
- shared activity emoji in Primary and Worker render paths;
- unchanged prose and fenced-code literals;
- unchanged card actions, targets, payload limits, and streaming element IDs.

Verification runs the affected card and workflow tests, `npm run typecheck`,
`npm run build`, and the full `npm test` suite.

## Non-goals

- Making all three cards use one identical layout.
- Adding new workflow states, actions, or remote controls.
- Adding collapsible command panels to Worker Task Cards.
- Changing Answer or Worker canonical text, pagination, or recovery semantics.
- Reproducing terminal colors, animations, or chrome.
