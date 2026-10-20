# Trace-End Next-Input Notification Implementation Plan

Specification:
[`docs/spec-coder/specs/2026-10-01-trace-end-next-input-notification.md`](../specs/2026-10-01-trace-end-next-input-notification.md)

Workspace:
`.trae/worktrees/trace-end-next-input-notification`

- Branch: `feat/trace-end-next-input-notification`
- Starting revision: `55cf73104f072bab4d6bd4bc5724c9bc0d553332`
- Initial isolated-worktree changes: none
- Baseline: `npm ci`, `npm run build`, `npm run typecheck`, and
  `npm run architecture:check` passed; `npm test` passed 235 files and 3,234
  tests. Build identity:
  `sha256:4627374e258f51b02608dae7b3481f508c4038d9cc44bd26649faf3c45f0286d`.
- Approval: Gate 1 design, Gate 2 specification, and Gate 3 ticket plan plus
  implementation authorization approved.

## Tickets

- [x] T1: Notify when a Worker completes and has no successor input

  **What to build**

  Deliver the complete Worker capability from an exact `turn.completed`
  transition through the existing parent Binding route to one immutable
  Feishu notification card. The completion transaction must suppress the card
  when the same Worker Session generation already has nonterminal successor
  work, otherwise atomically persist the completed Worker Turn projection and
  notification outbox intent. The card mentions the persisted Binding creator
  when valid, safely identifies the Worker/task/Pane, and retains the existing
  Worker Main Card navigation action when available.

  **Spec references**

  - SCN-2, SCN-3, SCN-4, SCN-5, and SCN-6
  - INV-1 through INV-6
  - Implementation Decisions / Domain Model, Architecture, Behavior & Failure
    Modes, and Compatibility & Migration

  **Ownership and implementation path**

  - Agent Work Coordination owns Worker Turn terminal eligibility and the
    same-generation successor query.
  - Extend the existing Worker Turn transition/projection transaction rather
    than checking queue depth in `WorkerTurnObserver`,
    `InstanceTurnSupervisor`, or `WorkerTurnDispatcher`.
  - Use the exact current Worker/parent Binding route and the existing
    `creatorOpenId` validation. A stale Worker generation, runtime Turn, or
    parent route reserves no notification.
  - Add the minimum internal notification input/result contract and pure
    CardKit renderer. Inject the renderer through the existing Worker
    presentation seam; do not import the Lark SDK into domain/store policy.
  - Reserve an existing immutable `card_reply`/`operation_result` outbox item
    with a stable Worker ID + Worker Session generation + Turn ID identity.
    Return reservation/mention outcome so coordinators can wake the existing
    outbound dispatcher and emit bounded structured logs.
  - Repeated terminal calls, observer recovery, restart, and transport retry
    must converge without another notification or Agent input.

  **Acceptance criteria and verification**

  - Red: card tests fail until valid creator mention, missing/invalid creator
    fallback, bounded/redacted task text, Pane identity, and Worker Main
    navigation render correctly.
  - Red: Worker store/integration tests fail until a current exact completion
    with an empty same-generation queue atomically creates exactly one
    notification intent alongside the completed Turn/card projection.
  - Red: already-accepted queued/claimed/dispatching/running/blocked or
    dispatch-uncertain same-generation successor work suppresses the intent;
    another Worker or generation does not.
  - Red: input-acceptance-before-completion suppresses notification, while
    completion-before-input creates one correct intent and later input remains
    accepted normally.
  - Red: duplicate completion, stale identity/route, aborted/cancelled/failed
    outcomes, store reopen, and delivery retry do not create a second intent or
    misclassify the terminal outcome.
  - Verify focused Worker card, SQLite store, Worker observer/supervisor,
    instance routing, recovery, and concurrency tests; then run
    `npm run typecheck`, `npm run build`, and `npm run architecture:check`.
  - Review imports/types/assembly to prove the renderer remains an injected
    presentation dependency and provider stop reasons do not enter Worker
    policy.

  **Blocked by:** None

- [x] T2: Notify when a Primary completes and has no successor input

  **What to build**

  Deliver the complete Primary capability for attached, detached, external,
  and projected-Core completion paths. A proven current-generation Primary
  completion atomically persists terminal Prompt/Run Card state and one
  immutable Feishu notification intent only when the same Binding has no
  accepted successor Prompt. The card mentions the persisted Binding creator
  when valid and states that the Primary completed its current request and is
  waiting for new input. Update current architecture/user documentation to
  describe the normalized event trigger and queue-suppression contract.

  **Spec references**

  - SCN-1, SCN-3, SCN-4, SCN-5, and SCN-6
  - INV-1 through INV-6
  - Implementation Decisions / Architecture, Behavior & Failure Modes,
    Compatibility & Migration, and Testing Decisions

  **Ownership and implementation path**

  - Agent Work Coordination owns Primary Prompt terminal eligibility and the
    same-Binding successor query.
  - Deepen the existing Primary terminal store seam so attached completion,
    detached observation, externally adopted turns, and projected-Core repair
    cannot terminalize successfully while bypassing notification eligibility.
  - Evaluate queued/submitted/running successor rows only after the completing
    Prompt has become terminal, inside the same SQLite transaction. Do not use
    event `queueDepth`, a runtime snapshot, or a coordinator pre-check.
  - Add the minimum Primary notification input/result contract and pure
    CardKit renderer, reusing existing redaction, Markdown bounds, Pane display
    identity, Feishu creator validation, presentation assembly, and outbox
    delivery abstractions.
  - Reserve an immutable `card_reply`/`operation_result` intent under the
    Binding root with a stable Binding ID + generation + Prompt ID identity.
    Return reservation/mention outcome for dispatcher wake-up and structured
    logging.
  - Preserve existing blocked Human Review requested/resolved notifications;
    abort/failure/cancellation/uncertainty must not use the next-input card.

  **Acceptance criteria and verification**

  - Red: Primary card tests fail until valid creator mention, missing/invalid
    creator fallback, bounded/redacted request text, and Pane/Prompt identity
    render correctly.
  - Red: Primary store/workflow tests fail until an exact successful completion
    with no same-Binding successor atomically creates one intent with terminal
    Prompt and Run Card state.
  - Red: queued/submitted/running successor Prompts suppress the intent, while
    work owned by another Binding or generation does not.
  - Red: both SQLite transaction orderings for concurrent input acceptance and
    completion produce the approved SCN-4 outcomes.
  - Red: attached, detached, external adoption, projected-Core recovery,
    duplicate terminal events, restart/reopen, and transport retry all converge
    to at most one notification. Stale generation/Pane/Session/Turn and every
    non-completion terminal outcome reserve none.
  - Existing blocked Human Review tests remain green and a blocked-to-completed
    turn can create exactly one distinct next-input notification when eligible.
  - Architecture and Feishu usage documentation state that Swarm consumes Core
    `turn_completed`, does not parse provider stop reasons, and suppresses
    notifications for accepted successors.
  - Run focused Primary card, SQLite, Prompt workflow, detached/external
    recovery, event integration, and concurrency tests; then run
    `npm run typecheck`, `npm run build`, and `npm run architecture:check`.
  - Review imports/types/composition and `npm run architecture:check` to prove
    source dependency direction and renderer injection.

  **Blocked by:** None

## Final Delivery Checks

- Reconcile SCN-1 through SCN-6 and INV-1 through INV-6 against completed
  tickets and fresh test evidence.
- Review the complete branch diff for exact terminal fencing, same-owner queue
  scope, atomic state/outbox behavior, stable idempotency, bounded Feishu data,
  and absence of raw stop-reason coupling.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`, and
  `npm test` freshly after both ticket commits.
- Run repository documentation/public audits required by the changed files.
- Verify each ticket is an atomic Conventional Commit with no unrelated paths
  and no automated CLI co-author trailer.
- Do not install, restart, deploy, push, open a PR, or run a live Feishu smoke
  without separate explicit authorization.
