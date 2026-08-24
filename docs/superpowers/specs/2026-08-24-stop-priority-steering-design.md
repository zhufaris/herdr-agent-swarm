# Stop Priority Steering Design

## Scope and intent

Lark topic message `/stop` asks the currently working TraeX turn to stop by
injecting the literal `/stop` text through the existing Herdr steering channel.
It is not a Bridge process-kill, pane-close, permission, or remote approval
operation. Existing queued ordinary turns remain queued and retain FIFO order.

## Routing semantics

- `parseCommand` recognizes only the exact, case-insensitive `/stop` command
  after trimming surrounding whitespace. Arguments are rejected as help rather
  than forwarded.
- The command is valid only inside an active bound topic whose supervised turn
  is currently confirmed `working`.
- A valid `/stop` is durably accepted as a steering prompt linked to the active
  parent prompt, regardless of ordinary turns already queued for the binding.
  Steering claiming is independent of ordinary FIFO, so it is delivered first.
- `blocked`, `idle`, `done`, `unknown`, missing-turn, unbound, archived, and
  inactive cases receive a durable rejection card. `/stop` is never converted
  into an ordinary queued turn and therefore cannot stop a later task.
- Existing inbound-message and prompt idempotency prevent a duplicate Lark
  event from injecting `/stop` twice. If steering transport becomes uncertain,
  existing no-replay handling marks it failed for operator inspection.

## Persistence and presentation

The existing `prompt_jobs` steering representation, run-card projection, and
outbox are reused. No new table or prompt priority column is required: the
dedicated steering worker already runs independently from the ordinary turn
worker. The accepted command produces the normal steering lifecycle card, and
the rejection path explains that no confirmed working turn is available.

Help and Feishu usage documentation describe `/stop` as a cooperative TraeX
command and retain the rule that Bridge cannot remotely force-stop a pane or
approve high-risk work.

## Verification

- With a working parent and an ordinary turn already queued, `/stop` reaches
  `steerPrompt` before the queued turn starts; the queued turn later runs in its
  original order.
- Duplicate delivery of the same Lark message injects one `/stop`.
- With a blocked or absent active turn, `/stop` is rejected, never calls
  `steerPrompt`, and never creates a queued prompt.
- Parser tests cover exact, case-insensitive, and argument-bearing forms.
- Full Vitest, typecheck, build, and diff checks pass.

No service restart or push is part of this change.
