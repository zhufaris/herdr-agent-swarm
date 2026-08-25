# Stable Lark topic titles

## Goal

Make a Lark topic immediately identifiable by its Herdr context. Its root card
must use the binding's canonical title, formatted as `spaceName / paneName`,
rather than a transient TraeX execution state.

For example, a `datasage` Space and `fabric-full` pane are shown as:

```text
datasage / fabric-full
```

## Rendering behavior

The root project-entry card uses `TopicViewState.title` as its stable identity:

- `header.title` is the bounded canonical binding title with no `TraeX` prefix.
- `config.summary.content` remains the same binding title.
- `TraeX 正在处理`, queued, blocked, completed, and error states remain in the
  card body as operational status, not title identity.

The existing title formatter remains the authority for `spaceName / paneName`,
fallbacks, whitespace normalization, and the 80-character binding-title limit.
The renderer may still apply its existing header-specific truncation.

## Lifecycle and compatibility

Newly created topics receive this rendering through the existing root-card
creation path. A `/herdr rename <name>` already updates the binding title and
the normal projection updates the root card, so its visible thread name follows
the renamed pane automatically.

No migration or startup scan changes existing bindings or historical Lark
topics. Request cards and answer cards retain their per-request titles.

## Verification

The focused card-rendering test verifies that, for a running topic:

1. the root-card header displays only the canonical `spaceName / paneName`;
2. its summary carries that same title; and
3. `TraeX 正在处理` is still rendered as body status.

This protects stable thread identification without hiding runtime state.
