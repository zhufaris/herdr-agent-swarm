# Primary Main Card Recent Conversation

## Goal

Replace the Primary Main Card's six-line tail preview with the latest five
conversation messages. User requests and Agent replies each count as one
message. The card presents the retained messages in chronological order with an
explicit `用户` or Agent label.

This is a compact operational preview, not a replacement for Request or Answer
Cards. Those cards remain the authoritative full-content surfaces.

## Scope

The change affects only the Primary Main Card. Pane entry cards may reuse the
same passive Main Card body because they are derived from that card, but Answer
Cards, Worker Cards, request cards, routing, prompt execution, and delivery
semantics do not change.

The preview contains at most five individual messages across both roles. For
example, three completed prompt turns produce six possible messages, so the
oldest request is omitted and the newest five messages remain.

## Durable conversation projection

`TopicViewState` gains a `recentConversation` array. Each entry contains:

- a stable key derived from the prompt ID and role;
- the role, `user` or `agent`;
- bounded display content;
- the durable activity timestamp.

The request entry is upserted from the durable `RunCardView.requestText`. An
Agent entry is created only after visible answer content exists. Streaming
updates replace the Agent entry for the same prompt instead of appending a new
message. Completion replaces that same entry with the final answer. Failed or
blocked runs do not synthesize a fake Agent message from notices.

After each upsert, entries are sorted deterministically by timestamp and stable
key, then trimmed to the newest five. Message content is bounded before it is
stored in the Topic View so repeated Main Card projections do not grow the JSON
state without limit.

The existing `answer` tail remains available for compatibility during rollout,
but the Main Card uses `recentConversation` whenever it is non-empty.

## Startup backfill

Existing bindings must show history immediately after deployment. Startup view
convergence reads the newest relevant Primary run cards for each binding,
derives user and non-empty Agent messages, and projects the newest five into the
Topic View before reserving the Main Card update.

Backfill is deterministic and idempotent. Re-running startup convergence with
unchanged run cards does not increment the Topic View version or enqueue a
duplicate Main Card update. Legacy Topic Views with no `recentConversation`
hydrate with an empty array.

## Rendering and bounds

The Main Card section is titled `💬 最近对话`. Entries are rendered oldest
to newest with role labels, for example:

```text
**用户**
检查部署状态

**Agent**
服务已就绪。
```

The five entries share the existing approximately 3,000-character Main Card
preview budget. When content must be shortened, each entry retains its newest
portion and the renderer preserves message boundaries and role labels. Empty or
whitespace-only content is omitted.

When no projected conversation history exists, the renderer temporarily falls
back to the existing latest-answer preview. This protects legacy and partially
recovered state until startup backfill converges it.

Blocked, error, degraded, orphaned, draining, and archived states keep the
existing recovery-first behavior: their actionable notice replaces the
conversation preview so the required operator action remains prominent.

## Consistency and safety

- Main Card rendering remains a pure function of `TopicViewState`; it never
  queries SQLite or Herdr.
- Run Card remains the durable source for request and answer content. Topic View
  stores only the bounded five-message projection.
- A repeated stream snapshot updates one Agent entry and cannot create duplicate
  messages.
- Stable keys and deterministic ordering make restart/backfill idempotent.
- The existing outbox remains the only Lark publication path, so retries do not
  repeat prompts.
- Existing terminal-output sanitization and Lark Markdown normalization remain
  in force. The preview does not read reasoning/protocol text or Worker-private
  output.

## Verification

Focused tests cover:

1. A queued prompt adds one user message.
2. Streaming output adds and then updates one Agent message for that prompt.
3. Completion finalizes the same Agent message.
4. The aggregate retains exactly the newest five messages in deterministic
   chronological order.
5. Legacy Topic Views hydrate with an empty history.
6. Startup backfill reconstructs five messages from existing run cards and is
   idempotent.
7. Main Card rendering shows role labels, preserves message boundaries, and
   stays within the shared preview budget.
8. Empty history retains the current latest-answer fallback.
9. Answer Cards and Worker Cards remain unchanged.

Verification runs focused reducer, projection, startup convergence, store, and
card tests, followed by `npm run typecheck`, `npm run build`, and `npm test`.
Deployment uses the existing active-work safety gate and never forces a restart.
