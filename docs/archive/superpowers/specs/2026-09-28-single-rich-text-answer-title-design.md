# Single Rich-Text Answer Title Design

## Goal

Render each Feishu rich-text Answer title exactly once. Keep the native post
title as the single visible title and remove the compatibility copy currently
inserted as the first bold content row.

## Current failure

`materializeFeishuRichText()` writes the same value to both `zh_cn.title` and
the first row of `zh_cn.content`. Feishu now renders the native title in thread
replies, so users see the identical title twice. A live deployed payload
reproduces this deterministically with two serialized occurrences of
`🤖 herdr-agent-swarm · ad9s`.

## Design

- Preserve `RichTextDocument.title` in `zh_cn.title`.
- Do not copy the title into `zh_cn.content`.
- Materialize only the canonical Markdown and native code blocks as content.
- Preserve metadata formatting, redaction, bounds, and continuation suffixes
  such as `续 2`.
- Do not change Answer pagination, durable page state, outbox identity, or
  delivery ordering. Existing delivered messages remain immutable; subsequent
  creates and updates use the corrected materialization.
- Do not change Primary Main Card title work or the separate Assistant-message
  versus thinking-message issue.

## Verification

- A titled document serializes the title exactly once.
- Untitled first-page documents keep an empty native title.
- Markdown and fenced-code materialization remain unchanged apart from removal
  of the duplicate heading row.
- Rich-text Answer, event-card, and outbox delivery tests pass.
- Type checking, build, architecture checks, and the full Vitest suite pass
  before deployment.
