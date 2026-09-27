# Rich-Text Answer Metadata Title Design

## Goal

Give every Primary and Worker rich-text Answer a compact native Feishu post title that identifies its project and Herdr pane without adding another visual container around the response body.

## Presentation

Use the rich-text document's native `title` field from the initial `正在生成… ▌` reply through every update and terminal state.

- Primary: `🤖 <project> · <pane>`
- Worker: `🤖 <project> · <pane> · <worker>`
- Continuation: append `· 续 N`, where `N` is the one-based page number.

`project` is the configured project ID so Primary and Worker use the same stable identifier. `pane` prefers the Herdr native four-character pane token and falls back to the full Pane ID only when no token is available. Worker titles append the stable Worker name. Values are normalized to one line, redacted, and bounded before they enter the title.

The title is metadata, not Answer content. Agent Markdown, compact emoji activity, the task-list footer, pagination, and the typewriter cursor remain unchanged.

## Data flow

Add one pure title formatter next to the existing rich-text Answer planner. Both initial rich-text payload creation and later page planning use the same formatter so the title does not appear late or drift between updates.

Primary creation and update paths derive metadata from the persisted binding and `RunCardView`: project ID, pane token, and Pane ID. Worker creation and update paths derive it from the persisted `AgentInstance`: project ID, runtime pane token, runtime Pane ID, and Worker name. The Worker Answer workflow gains read-only access to `getAgentInstance`; no metadata is inferred from visible Lark content.

All continuation creation paths pass the same metadata with the next page index. Frozen pages keep the title they had when frozen.

## Fallbacks and safety

- Missing token: use the full Pane ID.
- Missing token and Pane ID: use `未知 Pane`.
- Missing project: use `未知项目`.
- Missing Worker instance during a later update: keep rendering with `未知项目 · 未知 Pane · <worker name>` rather than blocking Answer delivery.
- Redact secret-shaped values and normalize whitespace before composing a title.
- Bound each metadata segment and the final title so malformed external values cannot exceed the Lark post title budget.

## Verification

- Unit tests cover Primary, Worker, continuation, token preference, Pane ID fallback, normalization, redaction, and bounded titles.
- Primary and Worker workflow tests assert that update payloads carry the expected title.
- Acceptance and continuation tests assert that the first placeholder and every new page already have the title.
- Existing Markdown, task-list, cursor, pagination, outbox, recovery, and CardKit-leak tests remain green.
