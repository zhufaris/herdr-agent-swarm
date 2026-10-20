# Inline Completion Actions Plan

Specification:
[`docs/spec-coder/specs/2026-10-01-inline-completion-actions.md`](../specs/2026-10-01-inline-completion-actions.md)

Workspace: in-place checkout on `main`, starting at
`06de52dd0d647b4967d84a58c4f63e4466a3e704`. Existing untracked
`.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
`docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
`handoff.md` are unrelated user-owned paths and remain outside this plan.

Baseline:

- `npm test`: 235 files and 3,270 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; build identity
  `sha256:324a7a170879363b285e674f5d33aa1c08e4af56ecdf8ba67afdff5d40814c18`.

Approval status: Gate 1 design approved; Gate 2 specification approved; Gate 3
ticket plan and implementation authorized.

## Tickets

- [x] **T1: Deliver one-shot completion actions inside the Primary Answer Card**

  **What to build:** Replace the Primary standalone completion-notification
  card with a durable Completion Action Set rendered in the final Answer Card.
  An eligible successful Prompt shows the resolved mention and the four fixed
  actions. A valid click atomically consumes the set and accepts exactly one
  ordinary same-Binding FIFO Prompt; ordinary later input supersedes the set
  and converges the old Answer Card without buttons.

  **Spec references:** SCN-1, SCN-3 through SCN-7; INV-1 through INV-10;
  Domain Model; Architecture; Behavior & Failure Modes.

  **Ownership and implementation path:** Conversation Projection owns the
  action-set lifecycle and final-card render DTO; Prompt Execution retains
  ordinary Prompt admission and canonical `(created_at, rowid)` ordering;
  Delivery and Operations retains CardKit sequence/lane ownership. Add the
  consumer-owned persistence and application interfaces needed to decide,
  render, supersede, and consume a Primary action set. Route one closed
  quick-action callback through the existing configured-chat allowlist and
  exact Binding/generation/card context. Reuse Prompt source identity and
  outbox interfaces; do not call native approval or terminal-input paths.

  **Acceptance criteria and verification:**

  - A Red renderer/workflow test proves the completed Primary currently emits
    a separate notification instead of an inline mention and four buttons.
  - Successful terminal projection with no later Human Message persists one
    available action set and reserves one sequenced final Answer snapshot with
    `default`, `批准`, `继续`, and `拒绝`; it reserves no standalone completion
    card.
  - Request actor, Binding-creator fallback, missing identity, non-success
    terminal states, wrong actor, stale Binding generation, wrong card ID, and
    frozen earlier pages produce the specified visible or rejected outcomes.
  - Each action maps to its exact fixed text and atomically creates at most one
    ordinary Prompt. Repeated callbacks and two-button concurrency return the
    existing/stale result without duplicate work.
  - A normal later Human Message versus click interleaving proves SQLite commit
    order, atomic supersession/consumption, and a newer same-card cleanup intent.
  - Save/reopen and startup convergence preserve the available/consumed/
    superseded/unavailable state without replaying a Prompt.
  - Run focused card renderer/action/parser, prompt admission, Answer page,
    startup, and SQLite tests plus `npm run typecheck` and `npm run build` before
    the atomic commit.

  **Blocked by:** None.

- [x] **T2: Apply the same inline completion-action contract to Worker Tasks**

  **What to build:** Replace the Worker standalone completion-notification card
  with the shared Completion Action Set on the final Worker Task Card. A valid
  action atomically creates one FIFO Worker follow-up associated with the
  completed Turn; normal later Worker Human input supersedes the set and removes
  the buttons from the same Task Card.

  **Spec references:** SCN-2 through SCN-7; INV-1 through INV-10; Domain Model;
  Architecture; Behavior & Failure Modes.

  **Ownership and implementation path:** Reuse the T1 Conversation Projection
  state machine and normalized render DTO. Worker Runtime remains authoritative
  for follow-up admission and validates Worker identity, runtime generation,
  Worker Session generation, parent Binding/generation/Pane, completed Turn,
  final card message, and mentioned actor. Delivery and Operations reserves
  Worker Task snapshots on the existing page lane and sequence. Do not share or
  mutate a Primary Prompt entity across the context seam.

  **Acceptance criteria and verification:**

  - A completed eligible Worker Turn renders one mention and all four buttons
    on its exact final Task Card and creates no standalone Worker completion
    card.
  - Every action creates exactly one `followup` Turn with the fixed text, exact
    actor, project, Worker/session identity, source card, and parent Turn.
  - Wrong user, stale Worker/runtime/session/parent generation, wrong source
    card, non-success terminal state, later Human work, and duplicate callback
    all fail closed without a new Turn.
  - Concurrent normal Worker input versus action and action versus action prove
    the same one-winner SQLite semantics as Primary.
  - Pagination, cleanup projection, delivery failure, and reopen tests prove no
    frozen prior Task page is changed and no Worker work is replayed.
  - Run focused Worker card/action/messaging, page workflow, startup, and SQLite
    tests plus `npm run typecheck` and `npm run build` before the atomic commit.

  **Blocked by:** T1.

- [x] **T3: Retire standalone completion notifications and reconcile legacy delivery state**

  **What to build:** Complete the expand/migrate/contract transition. Stop all
  new Primary and Worker standalone next-input card creation, reconcile only
  safely attributable unclaimed pending legacy notification intents into the
  current inline final-card state, preserve uncertain/delivered historical
  effects, remove obsolete notification renderers and interfaces, and update
  architecture/user documentation to describe inline completion actions.

  **Spec references:** SCN-6, SCN-7; INV-6 through INV-10; Compatibility &
  Migration; Delivery/recovery and architecture testing decisions.

  **Ownership and implementation path:** Delivery and Operations owns legacy
  intent classification, dismissal, audit preservation, startup ordering, and
  outbox recovery. Conversation Projection supplies only exact owner,
  generation, final-card, and current action-set evidence. Remove old
  `primary-next-input:*` / `worker-next-input:*` production paths after both
  execution contexts have migrated. Keep delivered, claimed, dead-lettered,
  and delivery-uncertain effects immutable; never infer absence from Lark.

  **Acceptance criteria and verification:**

  - Migration fixtures preserve existing owner/generation/audit evidence and do
    not backfill completed historical work into new available action sets.
  - Exact unclaimed pending legacy notification intents are dismissed only with
    sufficient current inline-convergence evidence; claimed, delivered,
    dead-lettered, and uncertain effects remain untouched and do not cause a
    second completion effect.
  - Repeated migration/startup is idempotent, uses the normal final-card
    convergence path, and submits no Prompt or Worker Turn.
  - Obsolete standalone notification renderers, DTOs, and composition wiring
    are absent; architecture/import checks confirm domain policy imports no
    SQLite or CardKit adapter.
  - Documentation states that quick `批准` is ordinary Human input and that
    native high-risk approval remains local to Herdr.
  - Run focused migration, recovery, startup, outbox, architecture, docs, and
    card suites plus `npm run typecheck`, `npm run build`, and the complete
    `npm test` suite before the atomic commit.

  **Blocked by:** T1, T2.

## Final Delivery Checks

- Review the complete three-ticket diff findings-first against every scenario,
  invariant, context responsibility, interface, and migration boundary in the
  approved specification.
- Confirm the four exact button labels/messages, mentioned-user authorization,
  stale-card behavior, and absence of native approval/process/Pane control.
- Confirm every completed ticket has one atomic Conventional Commit containing
  only task-owned paths and no `Trae CLI co-author attribution` trailer.
- Run `npm test`, `npm run typecheck`, and `npm run build` freshly after all
  repairs; do not run build concurrently with the full test suite.
- Confirm no unrelated initial untracked path, generated `dist/` output, debug
  instrumentation, credential, runtime state, or live database is staged.
- Do not install, restart, push, open a pull request, or publish external issues
  without separate user authorization.
