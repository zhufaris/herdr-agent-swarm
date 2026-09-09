# Worker Dispatch Settlement Race Design

## Goal

Prevent a late transport-level failure from moving a Worker turn back to
`dispatch-uncertain` after the exact TraeX transcript has already proved that
the turn started. Preserve the existing no-replay behavior when no exact turn
identity was observed.

Also make the new one-time Worker status snapshot acceptable to Lark CardKit.

## Failure

The Worker scheduler starts transcript observation before submitting the prompt.
The observer can claim a fresh turn, persist its `runtimeTurnId` and
`runtimeTurnStartedAt`, and project the turn as `running`. If the concurrent
`herdr agent prompt --wait` command later returns `agent_prompt_stalled`, the
scheduler currently overwrites that stronger evidence with
`dispatch-uncertain`. The Worker card then shows that delivery is still being
confirmed and the FIFO remains blocked even though the exact turn was observed.

Production evidence showed this ordering for the affected Worker: transcript
ownership and `running` were persisted first; `dispatch-uncertain` was persisted
about five seconds later for the same exact runtime turn.

Separately, the one-time snapshot renderer emits `update_multi: false`. Lark
rejects that card on creation with error `300302`, so the snapshot reply is
retried and eventually dead-lettered.

## Design

`InstanceWorkScheduler` will treat persisted exact runtime identity as stronger
evidence than a late transport receipt or thrown command error. After submission
settles, it will reload the turn. If both `runtimeTurnId` and
`runtimeTurnStartedAt` are present, the scheduler leaves transcript-owned state
unchanged and returns without projecting `dispatch-uncertain` or `failed`. The
existing observer and supervisor remain responsible for exact completion.

If exact identity is absent, behavior stays unchanged: ambiguous dispatches
become `dispatch-uncertain`, are not replayed, and continue to block later FIFO
work until authoritative evidence or explicit operator action resolves them.

The same evidence precedence applies to both a returned `delivery-uncertain`
receipt and a thrown driver error, because either can arrive after transcript
ownership. Terminal states remain protected by the existing early return.

The snapshot renderer will retain immutable snapshot semantics but use a
CardKit-compatible card configuration. `update_multi` controls whether a card
can be updated when shared or forwarded; it is not the mechanism that makes an
outbox `card_reply` immutable. The snapshot remains unbound to projection
invalidation and therefore still never updates automatically.

## Safety Boundaries

- Never infer delivery from pane idle state alone.
- Never replay a prompt that may have reached TraeX.
- Require both exact runtime turn ID and canonical start time before suppressing
  a late transport failure.
- Do not mutate historical production rows as part of the code change. Existing
  uncertain turns require a separate, evidence-backed operational recovery.
- Do not install, restart, or push as part of implementation verification.

## Verification

- A deterministic integration test makes transcript observation claim the exact
  turn before the driver returns `delivery-uncertain`; the turn must remain
  `running` and later complete from its exact transcript.
- The same ordering with a thrown driver error must also preserve `running`.
- An uncertain receipt without exact identity must still produce
  `dispatch-uncertain`.
- Snapshot rendering must not emit the rejected `update_multi: false` value and
  must remain free of Worker mutation actions.
- Run the affected integration/card tests, `npm run typecheck`, `npm run build`,
  and the full test suite.
