# Terminal Streaming Answer Card Design

## Goal

Preserve the useful visible TraeX terminal stream in Feishu without repeatedly
re-rendering the Answer card. The Request card remains a compact lifecycle
record and no longer presents an execution plan. Text authored by a Feishu user
must reach TraeX unchanged.

This design supersedes the Request-card progress and answer-rendering portions
of `2026-08-22-request-step-progress-design.md`,
`2026-08-22-transparent-prompt-native-progress-design.md`, and
`2026-08-22-stable-answer-segments-design.md`. Their queueing, binding, and
two-card ownership rules remain in force unless explicitly changed here.

## Card responsibilities

Each ordinary prompt continues to own two sibling messages.

The Request card contains only:

- the original request;
- Space and Pane identity;
- queue position or lifecycle state;
- an approval or failure notice when relevant; and
- elapsed duration.

It has no execution-plan panel and stores or renders no progress steps. Agent
state changes may update this card using the existing full-card patch path
because they are infrequent lifecycle transitions.

The Answer card contains one fixed Markdown element whose element ID is stable
and unique to the request. It is created as a CardKit card entity with
`update_multi: true` and `streaming_mode: true`, then sent by `card_id`. During a
turn, only that Markdown element is updated through
`cardkit.v1.cardElement.content`; the complete Answer card is not patched for
each observation.

## Transparent prompt delivery

The coordinator submits exactly the persisted user body to Herdr. It does not
append `<herdr_control>`, `<herdr_progress>`, task instructions, or any other
bridge-owned suffix. Steering text follows the same rule.

The output sanitizer still recognizes and removes any historical or accidental
`<herdr_control>` and `<herdr_progress>` blocks, including incomplete blocks.
They are internal protocol debris and must never appear in Feishu. The bridge
does not generate or depend on either block.

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
and cumulative content both have explicit limits. A clipped observation ends
with an omission marker. The first Answer card rolls over to a continuation
Answer card before the CardKit Markdown-element limit is reached; streaming
continues there instead of deleting already delivered history.

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
last normalized Herdr snapshot. It also persists the active Answer `card_id`,
fixed `element_id`, monotonically increasing CardKit `sequence`, delivered
character offset, and optional continuation index. This state makes retry and
restart behavior deterministic.

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
Request-card delivery and Answer-stream delivery cannot block unrelated
bindings.

On completion or failure, pending output is flushed first. The bridge then
turns off `streaming_mode` through CardKit settings and updates only the minimal
card lifecycle metadata needed for the terminal state. It does not replace the
Markdown element or reconstruct its content.

## Creation and migration

New Answer cards use the recommended CardKit flow:

1. create a card entity and retain its `card_id`;
2. send an interactive message referencing that card entity;
3. record the returned message ID and card ID atomically with outbox delivery;
4. stream the fixed Markdown element by card ID and sequence.

Existing active Answer cards were sent as inline interactive JSON and may not
have a stored card ID or stable element ID. They continue through the legacy
full-card path until their prompt reaches a terminal state. New prompts always
use CardKit entities. No attempt is made to convert and stream into an old card
mid-turn, avoiding prefix and sequence ambiguity.

Database migration is additive and idempotent. Existing answer text is
preserved. Progress-event columns may remain temporarily for schema
compatibility, but new observations do not populate them and Request rendering
ignores them. A later cleanup may remove those columns after all supported
databases have migrated.

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
- If the current card approaches the configured element limit, a continuation
  CardKit card is created and subsequent deltas stream there.
- A process restart resumes with the persisted sequence and delivered content;
  it never re-appends already acknowledged content. Existing restart policy for
  an interrupted running prompt remains unchanged.

## Verification

Tests must prove:

1. ordinary and steering prompts reach Herdr byte-for-byte unchanged;
2. no bridge progress protocol is injected or rendered;
3. the Request card contains lifecycle information but no plan section;
4. Working, Read, Edit, Bash, tool summaries, shell output, approval text,
   commentary, and final answers enter the sanitized Answer stream;
5. ANSI, terminal redraw duplication, prompt echo, reasoning, and internal
   protocol markup do not enter the stream;
6. secrets are replaced in place with `[REDACTED]` rather than dropping the
   surrounding message;
7. repeated and overlapping pane snapshots append each visible character once;
8. Answer creation stores a CardKit `card_id` and stable element ID;
9. live observations call only the CardKit element-content API and never the
   full-message patch API;
10. sequences are monotonic across coalescing, retries, and restart;
11. completion flushes content before disabling streaming;
12. element-limit rollover preserves prior cards and continues in a new one;
13. legacy active cards complete safely without mid-turn conversion; and
14. focused tests, the full suite, typecheck, and build all pass.
