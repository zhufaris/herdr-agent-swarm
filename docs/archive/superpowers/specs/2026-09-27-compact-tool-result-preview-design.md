# Compact Tool Result and Progress Preview Design

## Goal

Keep Answer cards readable when tools or intermediate Agent updates produce large results. Match the Herdr pane's compact presentation: show enough output to identify progress and results, then state exactly how many lines were omitted. Preserve the complete redacted content in the canonical timeline.

## Display policy

- Every Tool result shows its first 3 and last 3 logical output lines. Results of 6 lines or fewer remain complete.
- When more than 6 lines exist, insert `… +N lines omitted` between the visible head and tail, where `N` is the exact number of undisplayed logical lines. Head and tail ranges never overlap.
- Bound each displayed line to 500 characters and replace its omitted tail with an inline character-count marker. This prevents a minified payload or stack trace from filling a card despite having few newlines.
- Normalize CRLF and CR to LF before counting lines. Preserve blank lines in the visible head and tail and include hidden blank lines in the omitted-line count.
- Apply the same preview policy to CardKit and `rich_post` rendering. Keep the existing emoji, state label, nested marker, and collapsible-panel behavior.
- A result with no omitted content has no omission marker.

## Command execution wrapper

TraeX command results can contain a presentation wrapper inside the structured `function_call_output.output` field:

```text
Script completed
Wall time <duration>
Output:
<actual command output>
```

Parse the JSONL envelope and validate the structured event before examining this field. Do not edit raw JSONL or scan unrelated transcript text. When the normalized Tool result begins with exactly this three-line shape, the Answer presentation keeps only the content after `Output:`. The match is anchored at the beginning, `Script completed` and `Output:` are exact lines, and the middle line must begin with `Wall time `. If any condition fails, retain the original result unchanged.

Wrapper removal is a presentation transform applied before head-and-tail compaction. It does not parse the command output itself and does not alter execution-state detection or the canonical result stored in SQLite. An empty extracted output uses the existing empty-result message.

## Intermediate message policy

- Retain the latest 3 safe intermediate `agent_message` items on each rendered Answer page.
- Show at most the first 3 logical lines of each retained intermediate message, followed by the same exact `… +N lines omitted` marker when needed.
- Add a compact thinking/progress marker to distinguish these messages from the final answer.
- Never derive these messages from `agent_reasoning_raw_content`, chain-of-thought, protocol records, approval UI, terminal chrome, or other private channels. Only already-approved `agent_message` timeline events are eligible.
- Final-answer items remain full-content and continue to use normal Answer pagination.

## Data and delivery boundaries

The renderer removes a recognized wrapper and performs line compression on a copy. `AnswerTimelineItem.result` remains complete, redacted, and bounded only by the existing 512 KiB durable safety ceiling. SQLite rows, event projection, execution-state detection, idempotency keys, frozen-page immutability, and prompt execution do not change.

Because displayed results and intermediate messages are bounded, they no longer create continuation cards merely to expose hidden detail. Oversized commands and final-answer prose continue using the existing section-aware pagination. Legacy `resultPreview` values remain readable through the same display formatter.

## Verification

Focused tests cover recognized-wrapper removal after structured-event parsing; malformed-wrapper fallback; first-three/last-three previews for successful, running, and failed results; exact omitted counts; non-overlapping short results; the latest-three intermediate-message rule; blank lines and CRLF normalization; long single-line output; CardKit/rich-post parity; full final-answer pagination; and preservation of canonical content through SQLite reopen. Existing Primary/Worker pagination and full-suite checks must remain green.
