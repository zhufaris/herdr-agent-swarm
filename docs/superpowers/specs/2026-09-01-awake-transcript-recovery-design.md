# Awake Transcript Recovery Design

## Goal

Add `/swarm awake` as an explicit, topic-scoped recovery command for a binding
blocked by an exact-owned detached prompt. The command projects Herdr turns that
already exist after the detached turn into new Answer Cards and then releases the
normal Feishu FIFO. It never submits text to TraeX.

## Command contract

- The command is valid only in an active binding with a live pane and a persisted
  TraeX session identity.
- The caller must be the binding creator, matching other recovery controls.
- The binding must have one running detached ordinary prompt with an exact
  `transcriptTurnId` and `transcriptTurnStartedAt`.
- Arguments are rejected. Repeated invocations are safe: transcript turn identity
  and the existing external-message idempotency key prevent duplicate prompts or
  cards.
- The immediate command reply states whether recovery was requested or why it was
  unnecessary. The actual recovered output is delivered through separate Answer
  Cards.

## Recovery flow

The transcript reader gains an exact-boundary open operation. It validates the
session file and finds the matching detached turn start. The cursor begins after
that turn's completion, or at the next distinct `task_started` when interruption
left no completion record. It must fail closed if the turn is absent, ambiguous,
mismatched by start time, has neither completion nor a later turn, or is outside
parser limits.

The prompt workflow serializes awake with the existing per-binding worker. It
drains complete observations from the recovery cursor in chronological order. The
first eligible later turn uses the existing strict supersession fence to terminalize
the detached prompt without replay. Further turns use normal external-turn adoption.
Each recovered turn gets its own durable prompt, run-card projection, Answer Card,
and completion event. Once recovery reaches EOF, the normal prompt scheduler is
woken so queued Feishu prompts can continue.

## Safety and failure handling

- No Herdr prompt, terminal write, interrupt, or approval action is issued.
- SQLite transitions and outbox reservations remain atomic and idempotent.
- Existing frozen Answer Cards are never patched; recovered turns use new cards.
- If no later complete turn with a user message exists, the detached prompt remains
  untouched and the command reports that no recoverable turn was found.
- A bounded scan failure leaves the prompt detached and reports a retryable failure;
  it never guesses a transcript or repairs SQLite from Lark state.

## Verification

Tests cover command parsing/routing, exact transcript-boundary reopening, completed
turns that predate service restart, multiple missed turns in order, idempotent repeat
invocation, missing/incomplete boundaries, no TraeX submission, and FIFO release.

