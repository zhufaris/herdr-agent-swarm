# Historical: Terminal output window

> Superseded by the current Answer pagination and render-safe fence behavior.
> This record is retained for decision history and must not be treated as current.

## Goal

Keep live Feishu cards useful when a single TraeX terminal observation is very large, without exposing the bridge's internal `OUTPUT TRUNCATED` marker.

## Behavior

- The terminal-stream parser keeps a bounded newest window of an oversized observation rather than its oldest prefix.
- Its emitted update is replace-only, so an old card draft is replaced by the current terminal window instead of accumulating duplicated text.
- The visible window starts with the user-facing Chinese notice: `较早的实时输出已省略，以下为最新状态。`
- The internal `… [OUTPUT TRUNCATED]` marker is never emitted into a bridge event or any Lark card.
- A later safe final `◆` answer remains authoritative through the existing completion path.

## Scope and safety

This changes only live terminal-delta presentation. It does not change Lark's normal card-size truncation markers, prompt dispatch, historical Answer-card immutability, or final-answer extraction. The bounded window continues to receive existing secret redaction and control/composer filtering before it is published.

## Verification

- A parser regression test proves an oversized delta has the Chinese notice, preserves the newest tail, uses a replacement update, and omits the internal marker.
- Existing stream/card and final-answer tests remain green.
