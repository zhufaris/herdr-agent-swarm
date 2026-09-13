# Evidence-Based Quarantine Convergence Design

## Goal

Let startup safely close obsolete outbox quarantines from durable SQLite facts so
an already-delivered replacement Answer can unblock its current projection lane.
The recovery must never retry an external effect whose outcome is uncertain.

This is one vertical slice: after a restart, durable evidence is classified, the
old recovery and quarantine are settled atomically, obsolete pending snapshots
are compacted, the newest safe snapshot becomes claimable, and startup reports
the convergence result.

## Production evidence

The current production database contains four active quarantines. Three are
immutable `card_reply` effects that Lark explicitly rejected and that have no
pending successors. The fourth is an uncertain old Primary Answer update for
Prompt `1f2f678c-d481-4770-9eaf-d3eaedcd4401`. That old update targets message
`om_x100b656e97d94934c4412ba6227b6b8`, while a later replacement create is
durably delivered to message `om_x100b656f541210a0de76a54b5457272` and card
`7684743638101855865`. The current Run Card and active Answer page both identify
the replacement target. Five pending revisions for the current target remain
blocked behind the obsolete lane quarantine.

These facts show two distinct safe convergence cases. They do not justify a
general age-based release or retry. Production SQLite will not be edited by hand.

## Selected design

Extend `recoverStaleOutboxQuarantines()` with two narrowly proven transitions.
Both execute inside its existing SQLite transaction.

### Rejected immutable effect with no successors

An active immutable quarantine can be dismissed when all of these facts hold:

- the failed reply is a dead letter with `effect_certainty = 'rejected'`;
- the failed effect is an immutable `card_reply`;
- no pending reply exists in the quarantined lane.

Startup dismisses the failed reply, marks its delivery recovery dismissed when
present, releases the quarantine, and refreshes the lane head. An `uncertain`
effect never qualifies for this path.

### Superseded uncertain Answer target

An active quarantine around an uncertain old Answer update can be released only
when all of the following durable evidence agrees:

- the failed reply is a dead-letter `card_update` with `card_role = 'answer'`
  and a non-null old target message;
- the Run Card currently identifies a different Answer message and card, with a
  current page index;
- the Answer page at that index identifies the same message and card as the Run
  Card;
- a later `stream_card_create` for the same Prompt and page is delivered, and
  its delivered message and card checkpoints identify that current page;
- the replacement create has a greater delivery order than the failed reply;
- every pending reply behind the quarantine is unclaimed.

The transition records the replacement create as proof by moving the old
delivery recovery to `recovered`, setting its resolved reply/message identity,
and preserving the uncertain failed reply as a dead letter. It releases the old
quarantine without retrying that effect. Among pending snapshots for the current
Answer projection, it keeps only the greatest `snapshot_revision`, dismisses
older revisions, and refreshes the lane head so that newest snapshot can drain.

The pending rows must share one non-null projection key, point to the current
Answer message, be later than the failed effect, and be `card_update` Answer
work for the same Prompt. Any unrelated pending work, missing identity, claim,
or disagreement leaves the quarantine active and changes nothing.

## Alternatives

### Release quarantines after an age threshold

Age cannot prove whether an uncertain external update took effect or whether a
new target is authoritative. This would trade a visible degradation signal for
possible duplicated or reordered delivery.

### Release whenever the Run Card points to another message

The Run Card alone proves desired state, not successful external delivery. A
matching delivered create plus matching Answer page is required to establish an
end-to-end replacement identity.

### Leave all quarantines for manual operation

This is safe but leaves normal self-healing incomplete and allows obsolete lane
state to block current projections indefinitely. Durable evidence is sufficient
for the two selected automatic transitions.

## Atomic transition and failure behavior

Candidate selection and mutation occur in one transaction on the shared SQLite
context. Before changing a superseded Answer lane, recovery validates the whole
candidate set, including claim state. It then:

1. marks the old delivery recovery recovered with proof identity;
2. releases the quarantine with an explicit startup action;
3. dismisses all but the newest current-target pending snapshot;
4. refreshes the lane head.

If any predicate fails, no part of that candidate is changed. A process failure
cannot leave the recovery released while its lane remains blocked because the
outer transaction rolls back all mutations together.

## Invariants

- `effect_certainty = 'uncertain'` is never changed into permission to retry.
- An uncertain old Answer update remains a dead letter after supersession.
- A replacement is accepted only from delivered durable work, never from visible
  Lark card text or wall-clock age.
- Run Card, active Answer page, replacement create, Prompt, page, message, card,
  and delivery ordering must agree.
- Claimed pending work prevents automatic convergence.
- Snapshot compaction retains the highest current projection revision only.
- Frozen Answer pages and 9,000-character pagination behavior are unchanged.
- Existing FIFO, lane ordering, idempotency, and no-replay behavior remain intact.

## Observability

`StaleOutboxQuarantineRecovery` adds separate counts for dismissed rejected
immutable effects and superseded Answer targets. Startup logs these values and
wakes the outbox when either transition releases work. This separates evidence-
based automatic convergence from older terminal cleanup.

## Testing

Store tests cover:

- rejected immutable `card_reply` with no pending successor converges;
- uncertain or successor-bearing immutable replies remain blocked;
- a fully matching delivered replacement Answer releases the old quarantine,
  records proof, compacts revisions, and exposes the newest lane head;
- missing/mismatched replacement evidence leaves all state unchanged;
- any claimed pending snapshot leaves all state unchanged.

Startup workflow tests cover reporting and wake-up behavior. Run focused SQLite,
startup, outbox, and Answer tests, then typecheck, build, architecture checks,
and the full test suite. A production read-only query will count candidates and
show which predicates pass without changing service state.

## Non-goals

- No manual production database cleanup.
- No automatic retry of uncertain effects.
- No retention, vacuum, legacy Worker queue, or health-policy changes.
- No service installation or restart.
