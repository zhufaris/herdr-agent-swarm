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

The reader consumes `history_mutation.payload.items` and preserves source order.
It emits only externally safe records:

- assistant `message` items containing `output_text` become Markdown;
- `function_call` items become a neutral `tool` block with the declared tool
  name and JSON arguments;
- `function_call_output` items are paired by `call_id` and become a separate
  `text` block; and
- reasoning, developer/user/system messages, metadata, and unknown records are
  ignored.

The reader must not parse JavaScript orchestration strings inside `exec` calls
to infer shell commands or patches. A future native `command` or `patch` typed
record may map directly to `bash` or `diff`, but only from explicit fields.
Existing secret redaction and CardKit Markdown sanitization still apply.

## Integration and fallback

`PromptRunWorkflow` opens a transcript cursor before dispatch. On every runtime
observation it prefers non-empty typed transcript deltas. If typed identity,
file resolution, JSON parsing, or schema validation is unavailable, it uses the
existing terminal delta path. Typed reader failures are logged and degrade only
the current observer; they never fail or replay a TraeX prompt.

Final completion prefers accumulated typed Answer content, then accumulated
terminal content, then the final terminal extraction. Existing SQLite, outbox,
pagination, source offsets, frozen-page behavior, and prompt replay invariants
do not change.

## Verification

- unit tests cover identity validation, cursor behavior, partial JSONL records,
  typed message/tool pairing, unknown records, and redaction;
- adapter tests cover injected hook arguments and session reporting;
- workflow integration tests cover typed-first rendering and terminal fallback;
- a sanitized task-jz33 JSONL fixture covers real `exec` call/output shapes; and
- the full Vitest suite, typecheck, and production build must pass.
