# Goal Continuation Answer Ownership Design

## Scope

Keep every safe, user-visible message from one TraeX goal run in the same
Feishu Answer, even when TraeX automatically continues the goal in several
runtime turns. Preserve exact-turn isolation: a manual pane turn, a new user
message, or an unclassified turn must never be appended to the preceding
Feishu Prompt.

This change spans Herdr Agent Swarm's metadata-only lineage probe and durable
Prompt ownership. Herdr Core's normalized agent-event stream remains the sole
authority for Answer-visible content. The change does not alter Answer rendering,
tool folding, title placement, or the rule that private reasoning bodies remain
hidden.

## Verified failure

Prompt `9cef9734-9891-445a-910d-6eea70519dc1` owns runtime turn
`ce02430c-1ed2-4f7a-9b8e-0847e75544c7`. TraeX automatically continued the
same goal through turns `ba6240c0-5298-44b0-832e-5fbd746cf9f3` and
`de11914c-99c6-4107-8ad2-3dec8b3869e9`. Each transition has this native
shape:

```text
task_complete(parent turn)
task_started(child turn)
history_mutation append:
  one developer message whose text is the goal-continuation envelope
```

There is no user message between those boundaries. The continuation envelope
starts with `Continue working toward the active thread goal.`, contains one
`<untrusted_objective>` block, and carries the goal budget and audit contract.
This shape also occurs across multiple independent TraeX sessions.

Herdr Core currently emits unrelated `turn_started` events for all three turns
and intentionally filters developer records. Swarm stores one
`transcript_turn_id` on the Prompt and correctly rejects every later turn as
`transcript-turn-conflict`. The first turn reaches the Answer; the continuation
output is therefore absent before rendering begins.

## Design decision

Swarm will derive native TraeX turn lineage through a bounded, metadata-only
probe over the already validated transcript path. It will not infer continuation
from elapsed time or session adjacency. Herdr Core events remain the only source
for assistant messages, Tool activities, lifecycle output, and Answer rendering.

The probe returns only this internal lineage record:

```text
turnId: string
startedAt: string
origin: "prompt" | "runtime_continuation" | "unknown"
parentTurnId: string | null
chainId: string | null
```

For an ordinary root turn, `origin` is `prompt`, `parentTurnId` is null,
and `chainId` equals the root turn ID. A proven automatic child has
`origin=runtime_continuation`, identifies its immediate parent, and
inherits the parent's chain ID. If classification is unavailable or ambiguous,
the probe emits `unknown` with no parent or chain.

## Metadata-only lineage classification

The probe reads only bounded JSONL envelope headers, `task_started`, terminal
events, and the first developer or user message for each candidate turn. It
never reads assistant messages, Tool calls/results, reasoning records, or their
contents. It validates the path through the existing transcript locator: a
resolved real path beneath the configured root with a matching session header.
The probe classifies a candidate turn as follows:

- `runtime_continuation` only when the immediately preceding turn completed
  normally and the first semantic input is exactly one developer message that
  parses as the complete goal-continuation envelope, its normalized objective
  fingerprint equals the active goal fingerprint, and its cumulative time and
  token counters do not move backward;
- `prompt` when the first semantic input is a user message or other recognized
  explicit prompt input, or when a goal envelope has no matching active goal;
- `unknown` for malformed envelopes, mixed messages, missing input, aborted
  parents, source attachment in the middle of a turn, or any other ambiguity.

The envelope parser checks structure, role, required fixed clauses, a single
bounded objective block, parseable nonnegative budget counters, and the absence
of user content. The probe retains only a bounded hash of the normalized
objective and the last counters; it does not persist or emit the objective body,
compare it with card text, or expose the developer message as Answer content.
Wall-clock spacing is diagnostic evidence only and is never an ownership
condition. A new goal with the same objective is still a root when its counters
reset instead of advancing.

The probe has no independent content checkpoint. It re-scans a bounded window
from the exact parent turn boundary when an events cursor reports a later turn.
The durable ownership table is its recovery checkpoint. A truncated, replaced,
ambiguous, oversized, or otherwise unverifiable source produces `unknown` and
cannot adopt a child.

## Swarm durable ownership

Add `prompt_transcript_turns` as an append-only ownership table:

```text
prompt_id
binding_id
binding_generation
turn_id
started_at
chain_id
parent_turn_id
origin
ordinal
created_at
PRIMARY KEY (prompt_id, turn_id)
UNIQUE (turn_id)
```

Existing `prompt_jobs.transcript_turn_id` and
`transcript_turn_started_at` remain the root-turn compatibility fields. A
migration backfills one root ownership row for every Prompt with a complete
stored identity. Backfilled rows use the root turn ID as the chain ID and
`prompt` as the origin.

The first turn is claimed through the existing dispatch-time and exact-start
fences. A later turn is appended transactionally only when all of these are
true:

1. the Prompt is still the active running Prompt for the same Binding;
2. the Binding generation, pane, terminal, agent kind, and native session have
   not changed;
3. the metadata-only probe reports `runtime_continuation` with non-null parent
   and chain IDs;
4. the parent ownership row already belongs to this Prompt;
5. the child chain ID equals the root ownership row's chain ID;
6. no other Prompt owns the child turn.

The append and Prompt observation-state check are one SQLite transaction. A
duplicate event is idempotent. A different owner, missing parent, changed
generation, or missing lineage is a conflict and remains excluded. No prompt is
replayed as part of adoption.

## Observation and completion

`ExactTurnObserver` becomes an exact-chain observer for a Prompt-owned ordered
set of turns. It still applies exact `(turn_id, started_at)` checks to every
individual turn. Accepted child turns reset only per-turn projection state; the
durable Answer timeline and its sequence continue monotonically.

An attached observer does not complete the Prompt on an owned turn's
`turn_completed` event alone. It reads through the next classified boundary:

- a valid owned continuation keeps the Prompt running and appends its output;
- a prompt or unknown turn ends observation without adopting that turn;
- process settlement with no later boundary completes the Prompt.

The existing Herdr agent wait remains the settlement signal. The observer drains
the Core journal after settlement, so a continuation already emitted before the
pane becomes idle is consumed. There is no arbitrary sleep-based grace period.

Detached recovery loads all ownership rows in ordinal order, opens at the root
turn, and replays only events from those exact identities. It can transactionally
adopt a newly proven child whose parent is already owned. A later unrelated turn
retains the existing external-turn supersession behavior. Restart never resends
the original Prompt.

Turn control targets the latest active owned runtime turn, not permanently the
root ID. This keeps `/swarm steer` and exact-turn stop fenced to the currently
running continuation. If no owned turn is active, control fails closed.

## Presentation behavior

All owned-turn timeline items append to the same logical Answer and use the
existing rich-text pagination rules. The Answer title appears exactly once per
page according to the current title contract. Assistant commentary, final
Markdown, and tables remain complete. Tool results remain the only folded
content, using the first-three/last-three-line preview and exact omitted count.
Skill output and empty control tools remain hidden. Reasoning contributes only
the existing safe heading.

Turn boundaries themselves are not rendered as noisy rows. They are available
in logs and durable ownership records for diagnosis.

## Compatibility and rollout

The feature is self-contained in Swarm. If the probe cannot validate lineage,
Swarm continues the current exact-single-turn behavior. It never treats missing
or malformed metadata as continuation.

Deployment order:

1. build and validate Swarm with the ownership migration;
2. force-restart Swarm only after inspecting active Prompt/outbox state;
3. submit a fresh multi-turn goal and compare pane, Core events, SQLite timeline,
   outbound payload, and delivered Answer.

If lineage metadata is absent or malformed, the safe rollback is to keep Swarm
on single-turn ownership. Existing cards, cursors, and ownership rows remain
valid.

## Verification

Swarm tests must prove:

- a Prompt atomically owns a root plus multiple valid child turns;
- duplicate child adoption is idempotent and cross-Prompt ownership conflicts;
- a metadata-only probe never exposes assistant, Tool, or reasoning text and
  never persists the developer objective body;
- a user-authored next turn, malformed envelope, mixed semantic input, aborted
  parent, reset counters, changed objective, repeated new goal, source
  replacement, and mid-turn attachment are never classified as continuation;
- changed pane/session/generation, missing parent, unknown origin, or mismatched
  chain fails closed;
- attached and detached observers append every safe item in order and complete
  only after the chain settles;
- restart recovery resumes from durable ownership without replay;
- external manual turns remain separate Answers;
- turn control resolves the latest active owned child;
- title, full assistant Markdown, Tool folding, hidden Skill output, empty-tool
  suppression, and safe thinking headings remain unchanged.

Final acceptance uses one fresh real goal that produces at least two runtime
turns. For every pane-visible safe assistant message and Tool activity, record
the matching Core event, SQLite timeline item, outbound Answer payload, and
delivered card content. Any unexplained missing, duplicated, reordered, or
misclassified item fails acceptance. Private reasoning bodies, raw Skill output,
and folded Tool middle lines are intentional exclusions.
