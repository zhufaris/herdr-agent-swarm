# Durable Answer Page State Machine

## Purpose

Answer pages are the durable delivery boundary for a TraeX response. A long
response can span multiple Lark CardKit entities, and the bridge must converge
to the same visible result after a process exit at any point in card creation,
message attachment, content streaming, or finalization.

This design makes `answer_pages` the authority for that lifecycle and moves page
planning and transitions into one application workflow shared by live projection
and startup recovery.

## Scope

This change covers only Answer page lifecycle reliability. It does not change:

- the 9,000-character page limit;
- CardKit typewriter frequency or step configuration;
- `CardUpdateScheduler` retry behavior;
- health and status degradation rules;
- worktree-name resolution;
- prompt dispatch, steering, or Herdr observation semantics.

## Authority and compatibility

The `answer_pages` table is the source of truth for page identity and lifecycle.
Each row owns:

- prompt and zero-based page index;
- canonical answer source start offset;
- Lark message ID, CardKit ID, and Markdown element ID;
- the last durably reserved CardKit sequence; delivery acknowledgement remains
  represented by the corresponding outbox row;
- lifecycle state;
- timestamps needed for recovery and diagnosis.

The current-page fields on `run_cards` remain temporarily as a compatibility
read-model cache. They are updated from the authoritative page transition in the
same SQLite transaction. Workflows must not independently advance these mirror
fields. Existing readers can continue using them while later migration work
moves them to page-oriented queries.

## Lifecycle model

An Answer page has four persisted states:

```text
creating -> active -> frozen
                   -> finished
```

- `creating`: the durable page record and card-creation intent exist, but the
  Lark message/CardKit identities have not both been checkpointed.
- `active`: the page is the only mutable page for the prompt. Its CardKit element
  may receive monotonically increasing cumulative-content updates.
- `frozen`: the page reached its safe boundary and was finalized for continuation.
  It must never receive another content update.
- `finished`: the page is the terminal page of a completed or failed run and must
  never receive another content update.

The transition graph is monotonic. Recovery may retry an unacknowledged external
operation, but it must not move a page backward or reactivate a frozen/finished
page.

## Persisted delivery steps

Page state alone is not enough to distinguish every crash point. The workflow
therefore derives progress from the page row plus durable outbox rows and their
states. It does not add a second event log.

For an active page, convergence follows these steps:

1. Render the cumulative page snapshot from the canonical RunCard answer and the
   page's `source_start`. Markdown fence closing/reopening affects only this
   render copy.
2. If the required content sequence is not already pending or delivered, atomically
   reserve the next page sequence and insert the `stream_content` intent.
3. If all canonical content fits and the run is terminal, atomically insert the
   `stream_finish` intent using the next sequence. Delivery changes the page to
   `finished`.
4. If more content remains, atomically insert the current page's continuation
   `stream_finish`, create the next `creating` page, and insert its
   `stream_card_create` intent. Delivery of the create intent checkpoints the new
   identities, freezes the prior page, activates the new page, resets its element
   sequence to zero, and updates the RunCard compatibility mirror.
5. Repeat convergence against freshly loaded durable state. Never assume the
   preceding outbox operation completed merely because it was requested.

The transaction owner is `SqliteBindingStore`. The workflow requests semantic
operations; it does not compose several public store writes and hope they all
succeed.

## AnswerPageWorkflow

Create an application workflow with one public convergence operation:

```ts
interface AnswerPageWorkflowPort {
  converge(promptId: string): Promise<void>;
}
```

`converge` is idempotent and safe to call after every RunCard answer change, after
a CardKit checkpoint, and during startup. It reloads state after every durable
transition and stops when one of these conditions holds:

- the current desired intent is already pending delivery;
- the active page contains all currently available non-terminal content;
- the terminal page is finished;
- the prompt has no delivered Answer card identity yet;
- a bounded transition limit is reached, preventing a malformed record from
  spinning indefinitely.

The workflow depends on a narrow `AnswerPageStore` and an outbound wake-up port.
It does not call Lark directly. Card rendering remains pure and CardKit transport
remains in the Lark adapter and outbox dispatcher.

## Planning logic

Extract page rendering and the next required action into a deterministic planner.
Its input is a canonical RunCard snapshot, the authoritative current page, and
relevant pending/delivered intent facts. Its output is one of:

```ts
type AnswerPagePlan =
  | { type: "wait" }
  | { type: "stream-content"; content: string }
  | { type: "finish-terminal"; summary: "Completed" | "Failed" }
  | {
      type: "continue";
      currentSummary: string;
      nextPageIndex: number;
      nextPageStart: number;
      nextElementId: string;
      initialContent: string;
    };
```

The planner has no database, clock, logger, or Lark dependency. Unit tests cover
page boundaries, fenced Markdown, empty terminal answers, and multi-page content.

## Atomic store operations

The store exposes semantic methods rather than allowing the workflow to update
page rows, RunCard mirrors, and outbox rows separately. The implementation plan
will finalize exact TypeScript names, but the operations must provide these
guarantees:

1. **Reserve content update**: verify the expected active page and sequence,
   increment the durable sequence, and insert one idempotent `stream_content` row
   in one transaction.
2. **Reserve terminal finish**: verify the active page and insert one idempotent
   `stream_finish` row at the next sequence in one transaction.
3. **Reserve continuation**: verify the active page, insert its continuation
   finish, insert-or-validate the next `creating` page, and insert the stable
   page-create intent in one transaction.
4. **Checkpoint page creation**: after the idempotent Lark reply succeeds, record
   message/CardKit identity, freeze the expected prior page, activate the created
   page, reset its sequence, and update the RunCard mirror in one transaction.
5. **Checkpoint content or finish**: acknowledge the exact page and expected
   sequence. A stale row for another page is dismissed and cannot mutate page
   state.

Every operation uses compare-and-set predicates on prompt, page index, state, and
where relevant CardKit identity and sequence. A stale intent becomes a safe no-op
or `dismissed`; it does not become a retry loop.

## Live and startup integration

`ConversationViewProjector` continues reducing lifecycle events into durable
RunCard and TopicView snapshots. It then schedules
`AnswerPageWorkflow.converge(promptId)` instead of implementing stream pagination
itself.

`StartupViewConverger` retains root-card and non-streaming compatibility work. For
every streaming RunCard it calls the same Answer Page workflow. It contains no
special-case content, finish, or continuation algorithm.

After a continuation card is checkpointed, the outbox dispatcher requests another
convergence pass. This wake-up remains best effort because the new active page and
all delivery intent are durable and startup convergence can reconstruct the next
step.

## Recovery behavior by crash point

| Crash point | Durable evidence | Recovery action |
| --- | --- | --- |
| Before content intent commit | unchanged active page | reserve and enqueue the missing content update |
| After content intent commit | pending outbox row | wait for normal outbox delivery |
| After Lark accepted content, before local checkpoint | pending row with stable UUID/sequence | retry the same logical update |
| After continuation reservation | finish/create intents plus `creating` page | drain the ordered Answer lane |
| After CardKit entity creation, before message reply | `card_id_checkpoint` | reuse the entity and retry the idempotent message reference |
| After message reply, before page checkpoint | same idempotent reply intent | retry and checkpoint the returned logical message |
| After new page activation | frozen prior page and active next page | converge the next active page only |
| After terminal content, before finish | active terminal page | reserve or deliver the missing finish |
| After finish delivery | finished page | no action |

## Invariants

The schema and workflow preserve these invariants:

- A prompt has at most one `active` page and at most one `creating` successor.
- Page indexes and source offsets strictly increase.
- Only an `active` page receives `stream_content` or `stream_finish`.
- Each page element sequence is strictly monotonic and begins at one after card
  activation.
- A `frozen` or `finished` page is immutable.
- A continuation card uses the stable idempotency key
  `stream-card:<promptId>:<pageIndex>`.
- Retrying Lark delivery never repeats a TraeX prompt.
- Visible page content is derived from the canonical RunCard answer; render-only
  Markdown repairs never alter that answer.
- The 9,000-character rendered-page limit includes reopened and closing fence
  markers.

## Migration

Existing databases already contain `answer_pages`. Startup migration validates
and repairs only safe compatibility gaps:

- create a missing page-zero row from a RunCard that has an Answer card identity;
- align the RunCard mirror to the unique authoritative active page;
- canonicalize element IDs using the existing element-ID migration;
- preserve delivered, dead-letter, and dismissed outbox history.

Ambiguous states are not guessed. Examples include two plausible active pages or
a creating page whose predecessor identity conflicts with the RunCard mirror. Such
records remain unchanged, are surfaced through structured diagnostics, and require
operator inspection. The migration never patches Lark directly.

## Observability

The workflow emits structured records without answer content or card payloads.
Each record includes `promptId`, `bindingId`, `pageIndex`, transition/action, and
outcome. Useful outcomes include `intent_reserved`, `waiting_delivery`,
`page_activated`, `stale_dismissed`, `terminal_finished`, and
`invalid_state_detected`.

This slice does not change `/status`, but it must expose enough store/workflow data
for the later status slice to report stuck `creating` pages and unfinished terminal
pages.

## Testing strategy

Focused unit tests cover the deterministic planner and transactional store guards.
Integration tests run the workflow, SQLite store, durable outbox, and fake Lark
adapter together. Required scenarios are:

1. one-page streaming and terminal finish;
2. two- and three-page responses with no lost or duplicated source text;
3. fenced Markdown split across page boundaries;
4. restart at every crash point in the recovery table;
5. CardKit entity checkpoint reuse after reply failure;
6. stale old-page content dismissal after continuation activation;
7. strictly increasing sequences independently on every page;
8. repeated live and startup convergence producing no duplicate logical intent;
9. transaction rollback leaving neither a partial page transition nor a partial
   outbox intent;
10. compatibility migration from existing RunCard mirror data.

Before handoff, run the focused Answer stream, projector, startup convergence,
outbox dispatcher, and SQLite tests, followed by the full Vitest suite,
`npm run typecheck`, and `npm run build`.

## Acceptance criteria

- Live projection and startup recovery use one Answer Page workflow.
- A response of at least three pages converges after a restart at every externally
  visible delivery boundary.
- The final visible pages contain the complete canonical answer exactly once,
  apart from render-only fence close/reopen markers.
- Frozen pages receive no later content updates.
- CardKit sequences are monotonic within each page and reset only when a new page
  is activated.
- Page state, RunCard compatibility fields, and outbox intent cannot be partially
  committed.
- Existing prompt no-replay, ordered outbox, target validation, and 9,000-character
  pagination guarantees remain intact.
