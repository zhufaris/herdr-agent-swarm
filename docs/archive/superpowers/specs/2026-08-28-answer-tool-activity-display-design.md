# Answer Tool Activity Display Design

## Problem

Answer Cards currently place a fenced shell command directly into the answer.
It is difficult to distinguish that block from code written as part of the
assistant's prose. Successful tool output is also bounded only by characters,
so long Git, JSON, test, and text results can dominate a card.

## Design

Command activities mirror the recognizable TraeX pane vocabulary while staying
valid Markdown for CardKit:

````text
◆ Ran

```bash
git status --short
```

```text
│ M  src/a.ts
│ … 已省略中间 16 行 …
└ M  src/z.ts
```
````

`◆ Ran` is a visible activity marker, not part of the command. The command is
kept in its own `bash` fence. When output exists, each displayed output line is
prefixed with `│ ` and the final line with `└ `. This preserves Herdr's visual
language without copying ANSI styling into Lark. Running and failed commands use
the same marker and retain their existing explicit status text.

Each tool result may display at most 20 output lines. Results of 21 lines or
more render the first 10 lines, one omission marker, and the last 9 lines. The
omission marker counts toward the 20-line limit. This policy applies uniformly
to Git diff/status/log, JSON, tests, and ordinary command text. Short output is
unchanged except for the tree prefixes. Markdown fences are always closed.

## Data Boundary

The transformation happens only while projecting typed TraeX tool activity for
the Answer Card. It does not rewrite the JSONL transcript, persisted canonical
answer, stream source offsets, page cursors, or recovery state. Existing secret
redaction and the character safety bound remain in force after line bounding.

## Verification

- Renderer tests cover the marker, command fence, tree prefixes, and closed
  fences.
- Table-driven tests cover JSON, Git diff/status/log, test output, and plain
  text using the 10 + 1 + 9 policy.
- Existing secret-redaction, failure, running-command, and transcript tests must
  continue to pass.
- The focused suite, full suite, typecheck, and production build run before
  deployment.

## Non-goals

- Reproducing terminal colors or interactive expand controls in CardKit.
- Changing canonical answer pagination or recovery semantics.
- Changing non-command tool categories such as Read, Search, Edit, or Agent.
