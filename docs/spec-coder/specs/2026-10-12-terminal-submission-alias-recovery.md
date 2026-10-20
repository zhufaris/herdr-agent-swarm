# Terminal Submission Alias Recovery

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The current Core session ring for Pane `wN:p5X` emits Human Message event
`246939088205db706005dd86688be037c315a430190cca4634c18ff1b15ad903`
with submission `0c53be7f-3134-4c51-91e9-37906b4db2b0`, while SQLite retained
the same event under submission `f99acbac-f3dc-4384-9c70-1e23a2602500`.
Both immutable Submission Intents are terminal and their durable Core receipts
identify the same completed turn, start time, Pane, terminal, Agent kind and
session. Their actor, owner, generation, route and text also match.

The inbox currently rejects every differing pair when the prior submission has
an intent. That fail-closed rule is correct for ordinary identity conflicts, but
it cannot recognize two submission IDs that Core proves are aliases for one
external effect. The exact session checkpoint therefore remains at
`epoch-2:41642`, later canonical events cannot be projected, and Agent Input
readiness reports `Core event identity conflict`.

## Solution

Allow a canonical submission correction when the prior and incoming Submission
Intents plus their durable receipts prove exact terminal-turn equivalence. This
strict two-intent alias rule applies when the prior submission has a durable
intent; the pre-existing legacy compatibility path remains allowed when the old
tag has no durable intent and the incoming intent has the exact Agent/session
fence. The alias equality fence covers owner, actor, text, expected and observed
runtime identities, valid immutable intent creation times, turn, started-at
time, terminal state, nonnegative integer receipt timestamps and event turn.
Exact aliases converge monotonically to the newer immutable intent: a newer
incoming alias replaces the stored correlation, while an older or equal replay
is accepted as a duplicate and preserves the stored event, ledger and Segment
correlation without projection or another delivery effect. Any missing or
unequal alias evidence retains the existing identity conflict.

Within the existing inbox transaction, adopt a newer submission ID carried by
the current Core event, update the canonical Human Message ledger and stored
event, and align an already-projected Conversation Segment for the same Human event.
Preserve the Segment ID, pages, card identity, root route and historical visible
content. The correction changes correlation only and never submits Agent Input
or creates another Segment/Card.

## User Stories

### SCN-1: An exact terminal-turn alias converges

When two immutable intents have different submission IDs but every route,
owner, content and terminal Core receipt field proves one exact turn, ingestion
adopts a newer incoming intent and advances the checkpoint. An older or equal
incoming alias advances as an ignored duplicate without replacing canonical correlation.

### SCN-2: An ambiguous submission conflict remains blocked

When the prior durable intent exists, either intent or receipt being absent,
non-terminal, malformed, or differing in actor, owner, text, Pane, terminal,
Agent kind, session, invalid intent creation time, turn, started-at time, invalid
receipt timestamps or terminal outcome causes `Core event identity conflict` and preserves all prior durable
state. The pre-existing old-tag-with-no-durable-intent compatibility path is
unchanged.

### SCN-3: Existing historical presentation remains stable

When the corrected Human event already owns a Conversation Segment, the Segment
adopts the corrected submission correlation without changing its ID, pages,
messages, root route, timeline or terminal state. No new Lark effect is reserved.

## Implementation Decisions

### INV-1: Core current event identity is authoritative only with exact alias evidence

Core JSONL remains conversation-order authority, but a changed submission ID is
not accepted merely because it is newer. When the prior durable intent exists,
`SqliteCoreEventInboxStore` owns the terminal-turn alias predicate and requires
matching immutable intent and receipt evidence before permitting canonical
correction. Exact aliases converge monotonically by immutable intent creation
time: only a newer incoming intent replaces stored correlation, while an older
or equal replay is a preserved duplicate. The existing old-tag-with-no-durable-intent
correction remains a separate compatibility path.

### INV-2: Alias recovery never repeats an external effect

Both intents must already have terminal receipts for the same exact Core turn.
The recovery path updates only SQLite correlation and checkpoint state; it never
calls Core submission, changes intent state, or retries an external effect.

### INV-3: Correction is one durable transaction

Canonical ledger rebinding, stored event/discriminator update, existing Segment
correlation and lane checkpoint advancement succeed or roll back together under
the existing inbox transaction. A uniqueness conflict or failed Segment fence
aborts the whole batch.

### INV-4: Ordinary conflicts stay fail-closed

The existing no-correction path and tests remain authoritative. When the prior
durable intent exists, different turns, runtime routes, actors, owners, text,
terminal outcomes, incomplete receipts and submission IDs already bound to
another event are rejected. The old-tag-with-no-durable-intent compatibility
path remains unchanged.

### ARCH-1: Keep the rule local to existing persistence owners

No new table, public port, service or recovery worker is introduced. The inbox
store evaluates alias evidence and owns the canonical event mutation. The
Conversation Segment store only accepts the changed correlation after the
canonical ledger already names the incoming submission for that Human event.

## Testing Decisions

Add a focused inbox-store Red test reproducing two terminal intents whose
receipts identify the same exact turn. It must initially throw, then pass by
updating the canonical ledger, event JSON/discriminator and checkpoint without
creating another external effect.

Add rejection cases for a different turn and at least one differing immutable
intent/runtime field, while retaining the existing generic conflicting
submission test. Add a Conversation Segment test proving an existing Segment
changes only its submission correlation and preserves its stable ID, page/card
state, root route and terminal state.

Affected verification includes both focused test files, typecheck, build,
architecture checks and the full Vitest suite. The live red-capable command is
`curl -sS --max-time 30 http://127.0.0.1:8788/ready | jq -e
'.components.agentInput.ok == true'`. After deployment it must pass, the exact
lane checkpoint must advance beyond `epoch-2:41642`, and Submission Intent
attempt counts/states must show no replay.

Fresh baseline evidence on clean revision
`9bc26cbb69b05a6170c85d18648bdfb86502f653`:

- `cd259a6266a046ac84ec170d75a67e58`: 2 focused files / 135 tests passed.
- `e5f393e0d59a4ca38eaecb10fdab3ca2`: `npm run typecheck` passed.

## Out of Scope

No schema migration, generic latest-ID-wins policy, production SQLite edit,
Core event deletion, Agent Input replay, Segment/page recreation, historical
Lark message movement, status-timeout change, or unrelated identity recovery is
included.

## Further Notes

Three approaches were compared. Skipping/quarantining the event would unblock
the lane while leaving Core and SQLite canonical identity inconsistent. Letting
every newer submission replace an older one would weaken the no-replay fence.
The selected exact terminal-turn alias correction is the only approach that
both converges to current Core evidence and retains strict rejection elsewhere.

Workspace mode is in-place inside the existing isolated deployment worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `9bc26cbb69b05a6170c85d18648bdfb86502f653`. The worktree was clean,
locked dependencies were present, and the original user checkout is untouched.
The bounded design and implementation continuation were authorized by the
user's current `继续` directive.
