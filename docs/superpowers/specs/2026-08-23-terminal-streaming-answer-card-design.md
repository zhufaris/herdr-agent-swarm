# Terminal Streaming Answer Card Design

## Goal

Preserve the useful visible TraeX terminal stream in Feishu without repeatedly
re-rendering the Answer card. New prompts initially create one Answer card: the
user's Feishu message is already the durable request record, so a duplicate
Request card is unnecessary. Continuation Answer cards are created only when the
active card reaches its safe content limit. Text authored by a Feishu user must
reach TraeX unchanged.

This design supersedes the earlier Request-card progress and answer-rendering
designs. Their queueing and binding rules remain in force unless explicitly
changed here.

## Answer-card ownership

Each new ordinary prompt owns an ordered Answer-card chain. Its original Feishu
message already contains the request text and remains immediately above the first
reply in the topic. No Request card is created, patched, or required before
execution. The chain normally contains one card and grows only through limit
rollover.

The Answer card contains one fixed Markdown element whose element ID is stable
and unique to the request. It is created as a CardKit card entity with
`update_multi: true` and `streaming_mode: true`, then sent by `card_id`. During a
turn, only that Markdown element is updated through
`cardkit.v1.cardElement.content`; the complete Answer card is not patched for
each observation. Space, Pane, queue/lifecycle state, approval notices, failure
notices, elapsed time, and visible terminal output all live in this one stream.

## Transparent prompt delivery

The coordinator submits exactly the persisted user body to Herdr. It does not
append task instructions or any other bridge-owned suffix. Steering text follows
the same rule.

## Terminal stream extraction

Herdr observations remain snapshots containing agent state and recent terminal
output. For each active prompt, the bridge compares the current normalized
snapshot with the last observed snapshot and derives a monotonic display delta.
It preserves user-relevant visible terminal content, including:

- TraeX status lines such as `Working`;
- file reads, searches, edits, and shell-tool activity;
- tool-call summaries and bounded serialized arguments;
- shell command output;
- approval prompts and their visible choices;
- spinner or transient status text after normalization;
- intermediate commentary and `◆` answer blocks; and
- the final answer.

ANSI sequences, cursor-control instructions, duplicated terminal redraws, input
echoes, decorative separators, and bridge protocol blocks are not displayed.
Carriage-return redraws are normalized into the latest visible line rather than
appended as repeated frames. Snapshot overlap is removed before persistence, so
polling the same screen twice is a no-op. If the terminal window rolls over or
is rewritten and a safe overlap cannot be established, the bridge appends a
short boundary marker and the new visible tail instead of replacing previously
delivered text.

Output is rendered as readable Markdown. Tool and shell material uses bounded
code blocks where doing so does not break the stream. Individual observations
have explicit limits, and a clipped observation ends with an omission marker.
The cumulative Answer stream is not truncated. Before the active card reaches
the CardKit Markdown-element limit, it rolls over to a continuation Answer card.
The full prior card is frozen and all remaining plus newly arriving content is
written to the continuation card. Previously delivered history is never deleted
or moved between cards.

## Unknown-state completion fallback

Herdr may report `agent_status: unknown` for a TraeX pane even when a submitted
turn has completed. The bridge must not require observing the short-lived
`working` state before it can recognize completion. After prompt text is visibly
confirmed and Enter is delivered, the bridge considers the turn submitted.

Structured Herdr state remains authoritative when it is available. When state
stays `unknown`, the bridge uses a conservative terminal fallback and completes
only after all of these conditions hold:

- terminal output changed after submission;
- the TraeX idle composer is visible again;
- consecutive polls show the same completed screen; and
- process metadata shows no active turn helper beneath TraeX.

The fallback requires multiple stable polls so a transient redraw cannot finish
a live turn. A visible approval or blocked prompt keeps the turn open. If neither
structured state nor the fallback proves completion, the existing turn timeout
still fails the prompt explicitly.

## Redaction

Potential secrets are retained in context but their values are replaced with
`[REDACTED]`. Redaction runs before terminal content enters SQLite, logs, the
outbox, or CardKit payloads. It covers at least:

- `Authorization` and proxy-authorization headers;
- bearer and common access-token forms;
- variables or JSON fields named token, secret, password, API key, or private
  key;
- sensitive URL query parameters; and
- PEM private-key bodies.

Detection is value-oriented rather than all-or-nothing: a line such as
`Authorization: Bearer abc` becomes `Authorization: Bearer [REDACTED]` instead
of causing the entire terminal update to disappear. Reasoning tags such as
`<think>` and `<reasoning>` remain hidden rather than redacted because they are
not user-visible model output. Malformed internal protocol blocks are also
hidden.

## Streaming state and delivery

The run-card projection persists the sanitized cumulative Answer stream and the
last normalized Herdr snapshot. Answer delivery is represented by ordered page
records. Each page stores its page index, `card_id`, message ID, fixed
`element_id`, monotonically increasing CardKit `sequence`, source start offset,
delivered offset, and lifecycle state (`active`, `freezing`, or `frozen`). This
state makes rollover, retry, and restart deterministic. Exactly one page may be
active for a prompt.

Although the bridge computes and stores only new deltas, Feishu's content API
accepts the full current text for the element. Each update therefore sends the
current cumulative snapshot for that element. Because the previous content is
always its prefix, Feishu renders only the suffix with the native streaming
effect. Updates for one Answer card are serialized and sequence numbers never
decrease. A repeated idempotency key or retry sends the same cumulative
snapshot without duplicating visible text.

The durable outbox gains a streaming-element operation distinct from full-card
updates. Pending stream operations for the same card may be coalesced to the
newest cumulative snapshot, but an in-flight operation must finish before the
next sequence is sent. Failures retain the newest desired snapshot for retry.
Answer-stream delivery for one request cannot block unrelated bindings.

When the active page reaches its safe limit, the bridge splits at a Markdown-safe
newline boundary, flushes and finishes that page, marks it frozen, creates the
next continuation card, and streams the uncommitted remainder there. If a code
fence crosses the boundary, the frozen page receives a synthetic closing fence
and the continuation page receives the matching opening fence; source offsets
still refer to the unsynthesized canonical Answer stream. A frozen page is never
patched again.

Page creation and rollover are durable. If continuation-card creation fails, the
remainder stays pending in the outbox and no source offset advances. Retries reuse
the same page index and idempotency key. They cannot create duplicate pages or
overwrite a newer page. Independent prompts and bindings continue draining while
one page is retrying.

On completion or failure, pending output is flushed first. The bridge then turns
off `streaming_mode` for the active page and updates only the minimal lifecycle
metadata needed for the terminal state. It does not replace a Markdown element,
reconstruct frozen content, or rebalance earlier pages.

## Creation and migration

New Answer cards use the recommended CardKit flow:

1. create a card entity and retain its `card_id`;
2. send an interactive message referencing that card entity;
3. record the returned message ID and card ID atomically with outbox delivery;
4. stream the fixed Markdown element by card ID and sequence.

Existing active prompts may have separate inline Request and Answer cards. They
continue through the legacy full-card path until reaching a terminal state. New
prompts create only a CardKit Answer entity. Old Request cards remain as inert
history and are neither deleted nor updated. No attempt is made to convert an
old Answer card mid-turn, avoiding prefix and sequence ambiguity.

Database migration is additive and idempotent. Existing answer text is
preserved. Legacy task-card IDs, delivered versions, and progress-event columns
may remain temporarily for schema compatibility, but new prompts do not create
or update a task card and new observations do not populate progress events. A
later cleanup may remove those columns after all supported databases migrate.

## Failure behavior

- If Answer-card entity creation or initial send fails, the prompt remains
  queued and the durable outbox retries it.
- If a stream update fails transiently, the newest cumulative snapshot remains
  pending and later updates coalesce into it.
- If CardKit streaming is permanently rejected, the Answer card shows a
  bounded failure notice and the run continues; the bridge does not fall back
  to repeatedly patching the full Answer card.
- If output cannot be normalized without risking secret exposure, that fragment
  is replaced with `[OUTPUT REDACTED]`; prior content remains intact.
- If the current card approaches the configured element limit, it freezes and a
  continuation CardKit card receives both the remainder and all subsequent
  deltas. No cumulative Answer content is discarded.
- A process restart resumes with the persisted sequence and delivered content;
  it never re-appends already acknowledged content. Existing restart policy for
  an interrupted running prompt remains unchanged.

## Verification

Tests must prove:

1. ordinary and steering prompts reach Herdr byte-for-byte unchanged;
2. no bridge progress protocol is injected or rendered;
3. a new prompt initially creates exactly one Answer card and no Request card;
4. queue and lifecycle notices append into the same Answer stream;
5. Working, Read, Edit, Bash, tool summaries, shell output, approval text,
   commentary, and final answers enter the sanitized Answer stream;
6. ANSI, terminal redraw duplication, prompt echo, reasoning, and internal
   protocol markup do not enter the stream;
7. secrets are replaced in place with `[REDACTED]` rather than dropping the
   surrounding message;
8. repeated and overlapping pane snapshots append each visible character once;
9. Answer creation stores a CardKit `card_id` and stable element ID;
10. live observations call only the CardKit element-content API and never the
   full-message patch API;
11. sequences are monotonic across coalescing, retries, and restart;
12. completion flushes content before disabling streaming;
13. element-limit rollover freezes prior cards and places the unsent remainder
    plus the latest output in a new card without truncation;
14. rollover retries are idempotent and preserve monotonic page order;
15. `unknown` panes complete after a submitted turn reaches a stable idle
    composer even when polling never observes `working`;
16. `unknown` panes do not complete during redraws, active helpers, or approval
    prompts;
17. legacy active cards complete safely without mid-turn conversion; and
18. focused tests, the full suite, typecheck, and build all pass.
