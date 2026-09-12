# Primary Prompt Dispatch and Answer Card Catch-up Implementation Plan

**Goal:** Restore FIFO liveness when direct Herdr work races with Primary prompt
dispatch, and guarantee that a newly created Answer Card catches up to the latest
durable queued view.

**Architecture:** Keep Herdr as live runtime authority and SQLite as workflow
authority. Add a pre-dispatch observation fence and retain the existing
compare-and-swap stale-claim recovery as the crash backstop. Extend successful
Answer create settlement to reserve a latest-version update in the same SQLite
transaction.

## Test seams

- `PromptRunWorkflow` through its public wake/start behavior.
- `HerdrCliAdapter.runPrompt` through its dispatch callback contract.
- `PromptRunStore` and `PromptSafetyScanner` through their public recovery APIs.
- Outbox delivery settlement through the existing SQLite store capability.

## Task 1: Protect dispatch from an already-active external turn

- Add a failing workflow integration test where a queued prompt is claimed while
  the bound Herdr pane already owns a different active turn.
- Assert the Bridge does not submit the claimed prompt.
- Add an atomic, claim-fenced store operation that returns only a provably
  unstarted claim to queued state and restores its Run Card phase.
- Invoke external-turn handoff, then let the normal scheduler retry the binding.
- Keep changed generation, pane, or dispatch evidence as fail-closed outcomes.

## Task 2: Persist dispatch at the earliest authoritative receipt

- Verify the installed Herdr CLI contract for prompt acceptance versus waiting.
- Add an adapter test that holds completion open and asserts the dispatch callback
  has already run when authoritative acceptance is observed.
- Preserve existing explicit pre-dispatch rejection behavior.
- Preserve uncertain post-acceptance handling as detached-without-replay.
- Make the minimal adapter/executor change required by the live CLI contract.

## Task 3: Keep stale-claim recovery as a safe backstop

- Add or strengthen a scanner/store test for an unowned stale
  `running + not_started` claim with no dispatch evidence.
- Assert an in-process owned claim is not recovered.
- Assert any prompt carrying `dispatched_at` or transcript identity is not
  requeued.
- Ensure recovery wakes only affected bindings and emits redacted diagnostics.

## Task 4: Catch up Answer state after card creation

- Add a failing SQLite/outbox test that advances a queued Run Card while its
  `stream_card_create` delivery is in flight.
- Settle create successfully and assert one latest-version update is reserved.
- Assert duplicate settlement is idempotent.
- Assert frozen or superseded Answer pages are not patched.
- Implement catch-up inside the same transaction as create settlement using the
  existing Answer lane and idempotency key format.

## Task 5: Validate and assess live recovery

- Run each focused test after its red/green cycle.
- Run `npm run typecheck`, `npm run build`, affected integration tests, and
  `git diff --check`; run the full suite because workflow and persistence both
  change.
- Re-run the read-only production red-light query.
- Do not edit production SQLite directly or interrupt the active pane.
- Install/restart only with separate explicit authorization after code is green.
