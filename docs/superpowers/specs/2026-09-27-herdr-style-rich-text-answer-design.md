# Herdr-Style Rich-Text Answer Design

## Goal

Make Primary and Worker Answer posts read like the Herdr terminal transcript while retaining Feishu rich-text delivery, safe incremental updates, pagination, and durable recovery.

## Scope

- Change only the Markdown generated inside rich-text Answer posts.
- Apply the same formatter to Primary and Worker Answer timelines.
- Keep Primary Main, Worker Main, status, model, pane-token, and action surfaces in CardKit.
- Preserve the existing 9,000-character page budget, safe Markdown boundaries, one-second/48-character refresh throttle, cursor behavior, outbox idempotency, and frozen-page rules.
- Do not restore or emit CardKit updates for `rich_post` Answer pages.

## Presentation

Agent prose remains ordinary Markdown without an extra container or heading. Activity and status messages use restrained, category-specific emoji rather than copying Herdr's single `◆` marker. The result is easier to scan in Feishu while retaining Herdr's compact two-level rhythm:

```text
📖 Read · src/runtime/answer-rich-text.ts · ✓
> └ 读取 132 行

⚙️ Ran · `npm test` · ✓
> └ 222 files · 2821 tests passed

Agent Markdown continues here.

---
📋 **任务 4/5**
- ✔ 已完成的步骤
- ■ 当前步骤
- ◻ 待处理步骤

▌
```

Rules:

- Use category-specific markers: `📖 Read`, `🔍 Search`, `✏️ Edit`, `⚙️ Ran`, `🧪 Test`, and `🛠️ Step`.
- Use status markers `⏳ 处理中`, `⚠️ 等待用户处理`, and `❌ 执行失败`.
- Put the tool state at the end as `…`, `✓`, or `✗`; the preceding icon and label already carry the meaning, so repeated state words are unnecessary.
- Put a bounded result preview on a quoted `└` line. Collapse multiline output to its first useful line and report the omitted line count.
- For commands, show a compact inline command in the summary. Do not repeat it in a fenced block.
- Preserve fenced code blocks authored by the Agent as fenced code blocks.
- Strip ANSI, redact secrets, normalize whitespace, and truncate labels/previews before rendering.
- Keep one live task-list status block at the bottom of the active page. Show the completed/total count and the latest five plan steps with `✔`, `■`, `◻`, or `✕`; summarize older steps instead of duplicating plan history.
- Update that block in place as the plan changes. Keep the final task-list state on the terminal page.
- Keep the active `▌` on its own final line. Remove it from terminal pages.
- Keep continuation titles as `回答（续 N）`.

## Data flow and boundaries

`AnswerTimelineItem` remains the canonical transcript input, while the existing `progressEvents` projection supplies the current task-list snapshot. `planAnswerTimelinePage` continues to own transcript ordering and pagination. The rich-text renderer converts planned items to compact Markdown and reserves space for the task-list footer; the Feishu gateway continues to wrap that Markdown in a `post` payload. Coordinators pass the current progress snapshot without changing storage or transport contracts.

The formatter remains pure and deterministic. Primary and Worker workflows therefore share the exact same visual semantics without duplicating presentation logic.

## Error and edge behavior

- An activity without a preview renders only its summary line.
- Multiline previews collapse to one readable line before truncation.
- Running tool activity can be replaced by its terminal state through the existing stable timeline item ID.
- Incomplete Markdown constructs remain withheld by `safeStreamingMarkdown` until a safe boundary exists.
- Pagination accounts for the rendered compact Markdown so no frozen page is rewritten later.

## Verification

- Unit tests cover each tool category, each state, multiline preview compaction, ANSI removal, secret redaction, and command deduplication.
- Existing Markdown safety, cursor, pagination, Primary workflow, Worker workflow, outbox, and recovery tests remain green.
- A live post-restart check confirms new Answer outbox rows use `rich-text-reply` or `rich-text-update`, not CardKit `card` intents.
