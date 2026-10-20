# Feishu Rich-Text Edit-Limit Recovery Design

## Goal

Recover Primary and Worker Answer delivery when Feishu rejects an ordinary
rich-text message update with error `230072` because the message has reached
its edit limit. Recovery creates a continuation rich-text message in the same
thread and resumes from the last successfully delivered timeline cursor. It
never retries the Agent prompt and never edits the exhausted message again.

## Scope

- Apply only to `message.update.rich_text` delivery for Primary and Worker
  Answers.
- Treat `230072` as an explicit, rejected delivery effect: the failed update did
  not modify the remote message.
- Reuse the existing rich-text page, timeline checkpoint, continuation, outbox,
  and target-fencing mechanisms.
- Do not add an edit counter or predict Feishu's limit.
- Do not change the 9,000-character content budget, rendering, refresh cadence,
  CardKit behavior, or prompt execution.

## Recovery flow

```text
rich-text update -> Feishu 230072
  -> classify as message_edit_limit
  -> persist rejected delivery and recovery intent
  -> freeze the exhausted page locally
  -> create continuation from the last delivered timeline cursor
  -> checkpoint the new message identity
  -> continue ordinary rich-text updates on the new page
```

The failed snapshot is not considered delivered. The continuation begins at
the durable cursor covered by the last successful update on the exhausted page.
This may repeat some live status presentation in the new snapshot, but it must
not skip or duplicate canonical answer timeline items.

## Failure classification

The Feishu gateway maps provider code `230072` to a new recovery kind,
`message_edit_limit`, only when all of the following hold:

- the operation is `update_rich_text`;
- the delivery purpose is a Primary or Worker Answer; and
- the provider confirms the effect was rejected.

The error remains observable as a permanent provider rejection, but it is a
recoverable page-boundary condition. It must not remain an unresolved dead
letter once the continuation is reserved. The same code on another operation or
surface receives no automatic recovery.

## Durable transition

Recovery is one fenced SQLite transaction. It verifies the failed reply, the
current binding or Worker generation, exact turn, active `rich_post` page,
message ID, and recovery state. It then:

1. marks the active page `frozen` without advancing its delivered cursor;
2. creates the next `rich_post` page at the last delivered cursor;
3. reserves one idempotent rich-text reply for that continuation; and
4. links the failed update to the replacement recovery.

The transition is idempotent. Reprocessing the same `230072`, restarting the
service, or running startup recovery cannot create multiple continuation pages.
The existing answer lane preserves ordering between the failed update, recovery
transition, continuation creation, and later snapshots.

## Runtime behavior

The delivery executor records the classified failure through the existing
outbox failure path. The recovery policy recognizes `message_edit_limit` and
invokes the page rollover transition. After the continuation message is
checkpointed, normal Answer convergence regenerates the current snapshot from
the canonical timeline and updates only the new message.

If continuation creation fails transiently, the durable reply retries normally.
If the binding/turn/page fence is stale, recovery stops without touching another
page. If continuation creation is permanently rejected, it follows the existing
dead-letter workflow rather than recursively creating more pages.

## Observability

Emit a bounded structured recovery record containing `bindingId`, `promptId` or
Worker turn ID, exhausted page index, failed reply ID, provider code, replacement
page index, and outcome. Operational summaries should show the original failure
as recovered after the continuation has been reserved or delivered, rather than
as an unresolved delivery failure.

## Verification

- Gateway classification tests prove `230072` maps to `message_edit_limit` only
  for Answer rich-text updates.
- Primary and Worker workflow tests inject `230072` after successful updates and
  assert that exactly one continuation is created.
- Store tests prove the old page is frozen, the new page starts at the last
  successfully delivered cursor, and repeated recovery is idempotent.
- Restart tests prove an interrupted recovery resumes without duplicate pages or
  prompt replay.
- Delivery tests prove later snapshots target only the continuation message and
  that the recovered failure is removed from unresolved operational counts.
- Existing pagination, frozen-page, outbox ordering, and full test suites remain
  green.
