# TraeX Typed Transcript Design

## Goal

Render Answer Card content from TraeX's typed session transcript when a Herdr
pane has an exact native session identity. Terminal text remains a safe
compatibility fallback and is never parsed to guess command or diff boundaries.

## Identity

The bridge starts managed TraeX panes with a process-local `SessionStart` hook
injected through a `-c` override. The hook receives TraeX's authoritative
`session_id` and reports it to Herdr with `pane.report_agent_session`. It does
not edit user configuration. Existing panes without a native session identity
continue to use terminal output.

The bridge accepts a transcript only when all of these conditions hold:

- Herdr reports an agent session with kind `id`;
- the ID has the expected UUID shape;
- exactly one transcript filename matches the ID under the configured TraeX
  sessions root; and
- the first `session_meta` record contains the same ID.

No cwd, timestamp, title, or newest-file heuristic is allowed.

## Transcript cursor

A reader opens the verified JSONL at its current byte length immediately before
prompt dispatch. Subsequent polls read only complete newline-terminated records
after that byte cursor. Partial trailing records remain buffered for the next
poll. Session ID and byte cursor are observer state, not durable workflow state;
after restart, detached observation may use terminal fallback without replaying
the prompt.

## Typed rendering

`history_mutation.payload.items` is the canonical typed-message source. The
reader consumes append mutations in record and item order and emits only
externally safe items:

- assistant `message` items containing `output_text` become Markdown;
- `function_call` items become a neutral `tool` block with the declared tool
  name and JSON arguments;
- `function_call_output` items are paired by `call_id` and become a separate
  `text` block; and
- reasoning, developer/user/system messages, metadata, and unknown records are
  ignored.

The cursor tracks emitted item IDs and pending calls for its lifetime. Repeated
items are not emitted twice, and a `function_call_output` is rendered only with
the matching call identity. A result that arrives in a later mutation remains
paired with the earlier call. Missing, duplicate, or malformed identities are
ignored rather than guessed.

Top-level `event_msg` records are not the typed-message authority. They may be
used later for independently specified lifecycle or progress projection, but
must not duplicate content already represented by `history_mutation` items. In
particular, the reader must not infer shell commands or patches from JavaScript
or JSON strings inside an `exec` call. A future native command or patch item may
map to a specialized block only from explicit typed fields. Existing secret
redaction and CardKit Markdown sanitization still apply to every emitted field.

## Integration and fallback

`PromptRunWorkflow` opens a transcript cursor before dispatch and chooses one
output mode for the turn. If the cursor opens, the turn is `typed`; otherwise it
is `terminal`. Every turn-start log records the chosen mode. Terminal fallback
records a bounded reason code such as `missing_session_identity`,
`unsupported_session_identity`, `transcript_not_found`,
`ambiguous_transcript`, or `transcript_validation_failed`. It does not include
prompts, transcript content, or secrets.

On every runtime observation a typed turn reads the next complete mutation
records. If reading fails before any typed content is published, the observer
may switch once to terminal mode and records `transcript_read_failed`. If any
typed content has already been published, terminal content is not mixed into
the answer; the reader failure is logged and finalization uses the accumulated
typed content. Typed reader failures never fail or replay a TraeX prompt.

Final completion uses accumulated typed content for a typed turn. A terminal
turn uses the accumulated terminal view and then final terminal extraction.
Existing SQLite, outbox, pagination, source offsets, frozen-page behavior, and
prompt replay invariants do not change.

## Existing panes and rollout

The bridge never guesses transcript identity from cwd, timestamps, titles, or
the newest session file. Existing panes without a native session identity stay
on terminal mode for their remaining lifetime. Newly created or explicitly
reset panes receive the bridge-managed `SessionStart` hook, report the exact
TraeX UUID through Herdr, and become eligible for typed mode on their next turn.
No automatic restart or replacement of an existing pane is part of rollout.

Operational verification must demonstrate both paths: an existing unidentified
pane logs terminal mode with `missing_session_identity`, while a newly created
or reset bridge-managed pane logs typed mode and streams content sourced from
its exact JSONL transcript.

## Verification

- unit tests use realistic `history_mutation` fixtures and cover identity
  validation, cursor behavior, partial JSONL records, assistant message
  rendering, cross-record tool/result pairing, duplicate suppression, unknown
  records, and redaction;
- adapter tests cover injected hook arguments and session reporting;
- workflow integration tests cover typed-only rendering, fallback before the
  first typed emission, no mixed-source fallback after emission, and structured
  mode/reason diagnostics;
- a sanitized real JSONL fixture covers actual message, function call, and
  function call output shapes;
- a live smoke check covers one legacy pane and one newly created or reset pane;
  and
- the full Vitest suite, typecheck, and production build must pass.
