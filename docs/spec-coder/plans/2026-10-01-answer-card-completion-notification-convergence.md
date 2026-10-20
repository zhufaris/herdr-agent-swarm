# Answer Card and Completion Notification Convergence Plan

Specification:
[`docs/spec-coder/specs/2026-10-01-answer-card-completion-notification-convergence.md`](../specs/2026-10-01-answer-card-completion-notification-convergence.md)

Workspace:
current checkout

- Branch: `main`
- Starting revision: `03ba41591b4269ba132cf5a8897f274b0e0bd502`
- Initial tracked changes: none.
- Protected user-owned untracked paths: `.tmp-core-build/`,
  `.tmp-core-worktrees/`, `.trae/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Workspace mode: in place. The tracked tree was clean and the existing
  untracked paths do not overlap this focused change.
- Fresh baseline: `npm ci`, `npm run build`, `npm run typecheck`, and
  `npm run architecture:check` passed; `npm test` passed 235 files and 3,258
  tests. Build identity:
  `sha256:e7dd8e303ef0341908bf3b25c49a88c4669238850c8bc9d88c6113dc084171da`.
- `npm ci` reported two existing high-severity dependency advisories;
  dependency changes remain out of scope.
- Approval: Gate 1 design, Gate 2 specification, and Gate 3 ticket plan plus
  implementation authorization approved.

## Tickets

- [x] T1: Deliver every mutable Answer surface through sequenced CardKit updates

  **What to build**

  Make Primary Answer and Worker Task Card pages visibly converge in Feishu by
  assigning every CardKit mutation a persisted, increasing provider sequence.
  Stream content, stream finish, timeline/full-surface replacement, and final
  static replacement must share the sequence owned by the exact page. A
  sequenced `card_update` must use CardKit entity update; only legacy
  unsequenced interactive messages retain message patch.

  **Spec references**

  - SCN-1, SCN-2, and SCN-6
  - INV-1 and INV-2
  - Implementation Decisions / Architecture, Behavior & Failure Modes, and
    Compatibility & Migration

  **Ownership and implementation path**

  - Conversation Projection owns page sequence allocation and reserves each
    outbox row with its `cardSequence` inside the existing SQLite transaction.
  - Delivery and Operations preserves per-page lane order and passes the
    sequence through the provider-neutral `surface.replace` intent.
  - The Feishu Gateway selects `updateCardKit` from the presence of a sequence,
    independently of `targetRole`; it retains `updateCard` only for legacy
    unsequenced surfaces.
  - Primary Answer and Worker Task projection paths use the same rule without
    importing the Feishu SDK into inner modules.

  **Acceptance criteria and verification**

  - Red: a Primary final fold currently produces an unsequenced
    `surface.replace` and calls legacy `updateCard`; the test requires a larger
    CardKit sequence and `updateCardKit`.
  - Red: Worker Task timeline/final replacements demonstrate the same failure
    and required behavior.
  - Content, finish, replacement, coalescing, retry, continuation, and startup
    repair tests prove monotonic page-local sequence allocation without target
    crossover.
  - Existing genuinely legacy unsequenced card tests continue to prove message
    patch compatibility.
  - Run focused Gateway, delivery-intent, Answer-page, event-card, Worker-card,
    and recovery tests; then `npm run typecheck`, `npm run build`, and
    `npm run architecture:check`.

  **Blocked by:** None

- [x] T2: Release a compact Primary completion notification after Answer delivery

  **What to build**

  Replace Primary's direct terminal notification outbox reservation with a
  durable completion-notification obligation. A successful Prompt completion
  creates one waiting obligation. The final Primary Answer delivery checkpoint
  releases or suppresses it atomically, and startup convergence repairs a crash
  gap. A released notification must mention the current Feishu Prompt actor,
  falling back to the Binding creator, and render the approved minimal card
  with an optional bounded final assistant-message preview.

  **Spec references**

  - SCN-1 and SCN-3 through SCN-7
  - INV-3 through INV-8
  - Implementation Decisions / Domain Model, Architecture, Behavior & Failure
    Modes, and Compatibility & Migration

  **Ownership and implementation path**

  - Prompt Execution supplies exact terminal success, Prompt actor provenance,
    generation, and successor identity.
  - Conversation Projection persists the obligation in the completion
    transaction and owns its state transition.
  - The Primary final-Answer checkpoint invokes the release seam only after T1
    establishes real CardKit delivery. Release revalidates terminal ownership,
    current routing, mention identity, assistant-message projection, and
    same-generation successor absence in one SQLite transaction.
  - `missing_mention_target` remains recoverable and creates no outbox row.
    Startup convergence calls the same idempotent release operation; it does
    not synthesize obligations for historical completions.
  - The renderer receives a required resolved mention, optional at-most-2,000
    character assistant preview, and compact Primary/Pane identity only.

  **Acceptance criteria and verification**

  - Red: terminal completion creates one waiting obligation and no next-input
    outbox row before final Answer checkpoint.
  - Red: final Answer checkpoint releases exactly one card; duplicate ACK,
    observer replay, and store reopen do not duplicate it.
  - Actor precedence, creator fallback, mandatory mention, recoverable missing
    identity, no-successor and successor-present races all match the spec.
  - The exact minimal Primary layout contains no request text, Prompt ID,
    generation, FIFO copy, or named content sections; its assistant preview is
    selected from visible assistant content, sanitized, optional, and capped at
    2,000 characters.
  - Transient/permanent Answer delivery failures and replacement-card recovery
    keep the obligation waiting until a final current checkpoint exists.
  - Migration and startup tests prove no historical notification backfill.
  - Run focused renderer, SQLite, Primary completion, outbox checkpoint,
    startup-view, detached/external recovery, and concurrency tests; then
    `npm run typecheck`, `npm run build`, and `npm run architecture:check`.

  **Blocked by:** T1

- [x] T3: Apply the same completion-notification contract to Worker Turns

  **What to build**

  Move Worker next-input notification creation onto the shared durable
  obligation and post-card-checkpoint release model. A completed Worker Turn
  must wait for its final Task Card, mention its exact Feishu human actor with
  Binding-creator fallback, show the approved minimal assistant-result preview,
  and retain Worker Main navigation. Successor, stale-route, missing-mention,
  retry, and restart behavior must match Primary semantics.

  **Spec references**

  - SCN-2 through SCN-7
  - INV-3 through INV-8
  - Implementation Decisions / Domain Model, Architecture, Behavior & Failure
    Modes, and Compatibility & Migration

  **Ownership and implementation path**

  - Worker Runtime supplies exact Turn completion, Worker Session generation,
    human actor provenance, parent route, and successor ownership.
  - Conversation Projection reuses the obligation state machine and release
    semantics introduced by T2 with Worker-specific identity and route checks.
  - Worker Task delivery checkpoint and startup convergence call the same
    release seam. No coordinator sends the notification directly.
  - The pure Worker renderer uses required mention identity, optional bounded
    assistant preview, compact Worker/Pane identity, and the existing Worker
    Main action.

  **Acceptance criteria and verification**

  - Red: Worker completion creates a waiting obligation and cannot enqueue a
    notification before the final Task Card checkpoint.
  - Final checkpoint, duplicate/replayed checkpoint, successor races,
    stale-parent routing, missing mention, retry, replacement, and restart
    cases converge to the specified one-shot outcome.
  - Human Feishu Turn actor wins over Binding creator; non-human or non-Feishu
    actors use the valid fallback and never become an invalid mention.
  - The exact minimal Worker layout contains the optional capped assistant
    preview and retains Worker Main navigation without request or generation
    detail.
  - Run focused Worker renderer, Worker projection/store, observer/supervisor,
    delivery checkpoint, startup recovery, and concurrency tests; then
    `npm run typecheck`, `npm run build`, and `npm run architecture:check`.

  **Blocked by:** T1, T2

## Final Delivery Checks

- Review the complete task diff against the approved specification and all
  ticket references.
- Run focused affected tests for Gateway delivery, Primary Answer pages,
  Worker Task pages, notification rendering, SQLite migration, completion,
  concurrency, and startup recovery.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run `npm run architecture:check`.
- Run the complete `npm test` suite.
- Inspect each ticket commit for task-only paths and Conventional Commit
  format. Do not install, restart, deploy, push, or open a pull request without
  separate authorization.
