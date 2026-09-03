# Tool Heading Terminal-Wrap Repair Design

## Problem

TraeX renders tool activity in the Herdr terminal as a heading followed by
terminal-width continuation rows. A narrow pane can turn `◆ Ran sqlite3` into:

```text
◆ Ran sqli
  │ te3
```

The bridge currently persists both physical terminal rows. CardKit then renders
the visual wrap as a semantic newline, making tool names and commands appear
broken across several lines.

## Scope

Repair only TraeX tool headings in the terminal-output normalization boundary.
When a line beginning with `◆` is immediately followed by one or more `│`
continuation rows, join their text back onto the heading. Whitespace introduced
only by the terminal frame is removed, so the example becomes `◆ Ran sqlite3`.

Do not join `└` rows. They contain tool results, command output, expansion
notices, or timing metadata whose line boundaries remain meaningful. Do not
change fenced Markdown, lists, ordinary answer prose, or the canonical CardKit
streaming and outbox protocols. Existing persisted cards are not rewritten.

## Data Flow

`parseTerminalStreamDelta` continues to own terminal sanitation. Its
`normalizeTerminalForLark` pass will recognize the bounded tool-heading shape,
consume only adjacent `│` rows, and emit one logical heading. All later
redaction, answer projection, streaming, pagination, and CardKit delivery stay
unchanged.

## Safety and Tests

Regression tests use captured shapes from the live bridge and prove that:

- one or several `│` rows reconstruct a single tool heading;
- a following `└` result row is preserved on its own line;
- ordinary Markdown/code output is unchanged;
- existing secret redaction and terminal-delta behavior still apply.

The change is deliberately render-forward-only. It does not migrate stored
answers or resend old cards.
