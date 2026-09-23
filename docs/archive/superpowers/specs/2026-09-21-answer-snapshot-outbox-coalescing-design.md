# Answer Snapshot Outbox Coalescing

## Goal

Reduce avoidable Lark CardKit traffic for static and final Answer cards by
retaining only delivery-relevant durable snapshots. When several revisions are
reserved before delivery claims them, the outbox keeps the newest desired
snapshot while preserving every revision that may already have crossed the
Gateway boundary.

This change applies only to revisioned Answer `card_update` intents with a
non-null `projection_key`. It does not coalesce streaming content, stream
finish, continuation-card creation, Primary Main cards, Worker cards, immutable
messages, or records blocked by delivery recovery.

## Safety invariants

- Persist the newest Answer view and its delivery intent atomically.
- Never delete or rewrite a reply whose delivery may have begun. A reply is
  immutable once `claim_attempt_id` or `first_claimed_at` is non-null,
  `attempt_count` is non-zero, or `card_id_checkpoint` is present.
- Never infer delivery from a newer snapshot. Claimed or attempted replies keep
  their independent checkpoint, retry, dead-letter, and recovery lifecycle.
- Snapshot revisions remain strictly increasing for a projection key even when
  intermediate unclaimed rows are removed. Revision numbers are identities and
  are never reused.
- The existing lane order remains authoritative. An in-flight revision stays
  ahead of the newest desired revision, and no later lane item may bypass it.
- Answer coverage evidence remains attached only to a live reply. Deleting an
  eligible snapshot relies on the existing `ON DELETE CASCADE` foreign keys for
  its coverage and recovery-candidate rows.
- Frozen Answer pages are not patched. Existing page-state and recovery gates
  continue to decide whether a snapshot may be reserved.

## Chosen design

`SqliteProjectionStore.reserveAnswerSnapshot` remains the owner of revisioned
Answer snapshots because it already owns projection keys, revision selection,
and the surrounding transaction. Before it inserts a changed snapshot, it:

1. reads the greatest historical `snapshot_revision` for the projection key;
2. derives the next revision from that maximum;
3. deletes older `pending` rows for the same projection key only when they have
   never been claimed, attempted, or checkpointed;
4. inserts the newest snapshot with the derived revision; and
5. records coverage for that inserted reply when the static Answer path supplies
   source text.

The lookup remains inclusive of delivered, dead-lettered, dismissed, claimed,
and unclaimed rows. Therefore removal of a pending intermediate row cannot make
revision numbering move backward. The existing first revision whose legacy
`idempotency_key` equals the projection key is normalized to carry the explicit
`projection_key` before revision calculation and coalescing.

Deletion and insertion execute inside the existing outer SQLite transaction.
The existing `outbox_lane_heads_after_delete` and
`outbox_lane_heads_after_insert` triggers recalculate the exact lane head after
each mutation. No new manual lane-head mutation or schema migration is needed.

## A-B-A behavior

Payload equality is evaluated against the newest retained historical revision.
For an unclaimed burst A -> B -> A:

- A is reserved as revision 1;
- B removes revision 1 and is reserved as revision 2;
- the second A is different from the newest retained payload B, removes revision
  2, and is reserved as revision 3.

The resulting pending set contains only revision 3. This is intentional: the
current desired state is A, no deleted revision could have been observed by
Lark, and the revision identity still records forward progress.

If revision 1 was claimed before B and A were reserved, revision 1 remains
immutable and revision 2 may be coalesced into revision 3. The pending set then
contains the claimed revision 1 followed by the latest desired revision 3. A
late settlement for revision 1 remains valid only through its original frozen
claim token and snapshot revision.

## Failure and recovery behavior

- A transaction failure rolls back both deletion and insertion, leaving the
  former lane and evidence intact.
- A process crash cannot expose a state where eligible old snapshots disappeared
  without the newest intent being durable, because all changes share one SQLite
  transaction.
- Active outbox quarantine continues to suppress the lane head. Coalescing does
  not release quarantine or settle delivery recovery.
- An uncertain or rejected reply is not eligible because it is no longer an
  untouched pending row. Existing successor-based recovery continues to compare
  projection key and monotonically increasing revision.
- If the newest retained payload is identical to the requested payload, the
  reservation remains `waiting` and no deletion occurs.

## Testing

Focused tests must prove:

- an entirely unclaimed A -> B -> A burst leaves only revision 3 pending;
- when A is claimed, A -> B -> A retains claimed revision 1 and latest revision
  3 while removing untouched revision 2;
- delivered, dead-lettered, dismissed, attempted, actively claimed, and
  checkpointed rows are never deleted by coalescing;
- revision numbering remains monotonic after deleted intermediate rows;
- coverage and recovery-candidate rows for a deleted untouched snapshot cascade
  safely, while evidence for retained rows remains unchanged;
- lane heads point to the claimed/oldest retained revision or the newest revision
  as appropriate;
- identical payload reservation remains idempotent; and
- reopen/recovery behavior and existing uncertain-target recovery tests still
  pass.

Before handoff, run the focused Answer workflow and SQLite store tests, the full
Vitest suite, typecheck, build, architecture check, documentation audit, public
audit, and `git diff --check`.

## Non-goals

- No schema migration or retention policy.
- No mutation of claimed payloads or idempotency keys.
- No coalescing across projection keys, prompts, pages, messages, bindings, or
  Gateway lanes.
- No changes to CardKit sequence allocation, answer rendering, delivery retry
  policy, or quarantine recovery.
- No installation or service restart as part of implementation verification.
