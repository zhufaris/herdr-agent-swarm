# Canonical Human Turn Card Implementation Plan

Specification:
`docs/spec-coder/specs/2026-10-04-canonical-human-turn-card.md`

Workspace: `/tmp/herdr-agent-swarm-unified-human-turn-card`

Branch: `feat/unified-human-turn-card`

Starting revision: `01584cbc3eb4b5deac2a777b62e77e8ed905710c`

Workspace mode: registered isolated worktree. This preserves unrelated
user-owned changes in the primary checkout and contains only task-owned
Pending-first Task 9 repair changes that this plan will replace or retain
selectively.

Baseline at planning boundary:

- focused Agent Input/Turn Card suites: 5 files, 43 tests passed;
- full suite: 272 files, 3,870 tests passed;
- `npm run typecheck`: passed;
- `npm run architecture:check`: 494 source files passed;
- `npm run build`: passed with
  `sha256:77c05489af0a4d938663687b1a7e88a41d0946afbc87cb35b7c8e7dd3651d11f`.

Approval status: canonical-only design approved at reopened Gate 1; written
specification approved at Gate 2; ticket set and implementation authorized at
Gate 3 on 2026-10-04. T1 through T4 are complete. Delivery review found and
repaired the missing route-gap evidence in `e1bbe481`; the fresh full
verification gate passed on 2026-10-04.

## Tickets

- [x] **T1: Create the first Turn Card only from a canonical Human Message**

  **What to build:** Stop all new admission-time Input/Turn Card writes while
  preserving immutable Submission Intent admission and no-replay behavior.
  Add one canonical Human projection transition that, for Primary, Worker,
  exact-turn steering, or direct-Herdr input, atomically closes the preceding
  segment, creates or resolves the new segment and Working page zero, reserves
  exactly one ordinary `card_reply`, links that exact reply, and settles the
  Core projection cursor. Duplicate and competing projection converge on the
  same aggregate/effect; definite pre-effect rejection may emit one bounded
  operation result, while uncertain submission remains query-only.

  **Spec references:** SCN-C1, SCN-C2, SCN-C3, SCN-C7, SCN-C8; INV-C1,
  INV-C2, INV-C3, INV-C4, INV-C7, INV-C8; Domain Model; Agent Input module;
  Canonical Human projection module; Admission; Canonical adoption.

  **Ownership and implementation path:** Agent Input retains Submission Intent
  and receipt/effect-certainty ownership but drops the presentation
  reservation from its new-write interface. Conversation Projection owns the
  canonical transition behind its existing domain/store port; the SQLite
  adapter hides unique-conflict handling, segment/page persistence, outbox
  reservation, reply linking, and cursor settlement in one transaction. Core
  inbox/projector callers pass normalized canonical identity and exact
  producer/session/generation fences. The Feishu adapter is not involved in
  deciding segment ownership. Preserve existing configured-chat, actor, route,
  redaction, and generation checks.

  **Acceptance criteria and verification:**

  - admission persists one Submission Intent and zero Conversation Segments,
    pages, legacy Input Cards, and Turn Card outbox rows;
  - an exact canonical Human Message atomically creates one Working segment,
    page zero, ordinary create reply, exact page-to-reply link, and cursor
    settlement;
  - injected reservation or settlement failure rolls back the complete
    transition;
  - duplicate live/recovery delivery and competing SQLite handles create no
    duplicate aggregate or effect; changed immutable identity fails closed;
  - Primary, Worker, steering, and direct-Herdr fixtures all exercise the same
    canonical transition and preserve exact Core order;
  - definite pre-effect rejection and uncertain/no-replay behavior remain
    covered, and later independent input remains eligible;
  - focused Agent Input, Core ingestion/inbox, Conversation Segment,
    Worker/steering/direct-Herdr, and architecture-boundary suites pass;
  - `npm run typecheck`, `npm run architecture:check`, `npm run build`, and
    `git diff --check` pass before the atomic Conventional Commit.

  **Blocked by:** None.

- [x] **T2: Reconcile every Turn Card delivery monotonically**

  **What to build:** Replace create-only page recovery with one exact
  pending-reply reconciliation path for create, snapshot, and finalize. Make
  acknowledged view version/cursor monotonic so a callback wake at the same or
  older desired state is `noop`, while a genuinely newer state reserves
  exactly one effect. Keep ordinary message-only receipts valid and surface
  IDs nullable; retain real surface requirements for streaming operations.

  **Spec references:** SCN-C4, SCN-C5, SCN-C6, SCN-C9; INV-C4, INV-C5,
  INV-C6, INV-C8, INV-C9; Turn Card convergence module; Delivery adapter;
  Delivery and checkpointing; Generic pending-reply recovery.

  **Ownership and implementation path:** Conversation Segment/Page remains the
  aggregate enforcing exact reply identity, acknowledged sequence/cursor, and
  immutable targets. Its store port exposes a small reconciliation/convergence
  result rather than transport states. The SQLite adapter interprets exact
  linked outbox evidence transactionally. `TurnCardWorkflow` reconciles before
  reserving and does not infer state from the latest card. The outbound
  executor normalizes Gateway receipts into exact `replyId`, `messageId`, and
  nullable `cardId`; composition wires the callback without Feishu types
  entering domain interfaces.

  **Acceptance criteria and verification:**

  - production-shaped ordinary `card_reply` callbacks containing message ID
    but no surface ID checkpoint successfully;
  - SQLite close/reopen tests adopt uniquely linked delivered create, snapshot,
    and finalize replies without replacement delivery;
  - undelivered/retryable effects remain waiting on the same reply;
    retryable dead letters are not mislabeled as identity conflicts;
  - uncertain, missing, malformed, or conflicting evidence opens an exact
    projection gap and emits no replacement effect;
  - callback -> checkpoint -> converge at an equal version/cursor returns
    `noop` and leaves no delivered reply reattached as pending;
  - a newer desired version reserves exactly one next reply, and duplicate
    callbacks remain idempotent;
  - frozen pages remain immutable, 9,000-character continuation stays within
    the same segment, and late facts remain on their canonical old segment;
  - focused Turn Card workflow/store, outbound executor/dispatcher, startup
    convergence, pagination, and recovery suites pass;
  - `npm run typecheck`, `npm run architecture:check`, `npm run build`, and
    `git diff --check` pass before the atomic Conventional Commit.

  **Blocked by:** T1, because the new canonical page-zero transition defines
  the exact reply link and acknowledged-state shape that generic reconciliation
  consumes.

- [x] **T3: Contract Pending-first behavior to compatibility-only recovery**

  **What to build:** Remove remaining new-write assumptions that a Submission
  Intent owns an Input Card or pending Segment, while preserving bounded
  readers/recovery for historical Pending-first rows. Update current domain,
  architecture, operator, and Feishu usage documentation so new Turn Cards
  begin at Working after canonical evidence. Add regression guards that no
  ordinary admission path can reintroduce a speculative card. Preserve
  historical external cards and legacy rows without automatic cleanup.

  **Spec references:** SCN-C1, SCN-C7, SCN-C8; INV-C2, INV-C7, INV-C8,
  INV-C9; Compatibility & Migration; Out of Scope; all context ownership and
  source dependency decisions.

  **Ownership and implementation path:** Agent Input domain documentation and
  interfaces describe Submission Intent only. Conversation Projection owns
  new visible Turn Cards. Delivery and Operations continues to report receipt,
  projection, outbox, and compatibility recovery evidence. Legacy adapters may
  read and converge historical pending-first state, but no Primary, Worker,
  steering, direct-Herdr, setup, or recovery new-write entry point may call
  that path. Update `docs/architecture.md`, context docs,
  `docs/architecture-reference.md`, `docs/feishu-group-usage.md`, and the
  superseded design status where required by documentation tests.

  **Acceptance criteria and verification:**

  - repository search and architecture tests prove every new ordinary input
    entry path creates only a Submission Intent before canonical evidence;
  - historical pending-first fixtures still reopen/recover without card
    deletion, target guessing, Agent Input replay, or manual SQLite mutation;
  - documentation consistently distinguishes Submission Intent from canonical
    Turn Card and contains no current-authority claim that admission creates a
    pending card;
  - Primary, Worker, steering, direct-Herdr, startup recovery, docs-audit, and
    public behavior suites pass together;
  - `npm run typecheck`, `npm run architecture:check`, `npm run build`, and
    `git diff --check` pass before the atomic Conventional Commit.

  **Blocked by:** T1 and T2, because compatibility contraction documents and
  verifies the final new-write and recovery interfaces rather than temporary
  expand-phase shapes.

- [x] **T4: Fail closed when canonical Human evidence has no reply route**

  **Repair scope:** Preserve the canonical Conversation Segment and ordered
  Human item, but create no page zero or delivery intent when neither an exact
  Submission Intent nor a unique live session route supplies a Feishu reply
  root. This keeps direct convergence non-actionable and prevents an empty-root
  `card_reply` without guessing or repairing delivery identity.

  **TDD evidence:** The focused regression first failed because explicit
  `TurnCardWorkflow.converge` created one outbound reply for the route-less
  segment. After the projection guard, the same regression proves zero pages,
  zero outbound replies, no actionable segment, and one durable
  `missing_initial_reply_route` projection gap. The focused Turn Card suites
  pass 30 tests; typecheck, architecture check, and build also pass.

  **Spec references:** INV-C1, INV-C4, INV-C6, INV-C8; Canonical Human
  projection module; Turn Card convergence module.

  **Blocked by:** T1, because the canonical projection transition owns page
  zero and its exact delivery route.

## Coverage Check

| Requirement | Responsible ticket(s) |
| --- | --- |
| SCN-C1 | T1, T3 |
| SCN-C2 | T1 |
| SCN-C3 | T1 |
| SCN-C4 | T2 |
| SCN-C5 | T2 |
| SCN-C6 | T2 |
| SCN-C7 | T1, T3 |
| SCN-C8 | T1, T3, T4 |
| SCN-C9 | T2 |
| INV-C1 | T1, T4 |
| INV-C2 | T1, T3 |
| INV-C3 | T1 |
| INV-C4 | T1, T2, T4 |
| INV-C5 | T2 |
| INV-C6 | T2, T4 |
| INV-C7 | T1, T3 |
| INV-C8 | T1, T2, T3, T4 |
| INV-C9 | T2, T3 |

Every ticket delivers an observable, independently green capability. T2
depends on T1's final canonical page/reply contract; T3 deliberately follows
both to contract compatibility paths and documentation only after their target
interfaces are stable. There are no cycles or missing ticket references.

## Final Delivery Checks

After all ticket checkboxes are complete and each ticket has one atomic
Conventional Commit:

1. review the complete starting-revision-to-HEAD diff against the approved
   specification, context ownership, architecture, security constraints, and
   user-visible behavior;
2. run fresh `npm test`, `npm run typecheck`,
   `npm run architecture:check`, `npm run build`, and `git diff --check`;
3. run delivery-coder findings-first review and route every material finding
   through the owning ticket's TDD repair;
4. inspect commit boundaries and messages; do not push;
5. install the immutable release, evaluate restart safety, restart only through
   the supported lifecycle command, and validate readiness plus a real Feishu
   input that produces no speculative Pending card and exactly one canonical
   Working-to-Answer Turn Card.

Delivery evidence on 2026-10-04:

- cumulative implementation review completed against the specification,
  context ownership, architecture, security constraints, and T1-T4;
- findings-first review identified one missing `INV-C6` projection gap, then
  repaired it through Red-Green TDD in `e1bbe481`;
- `npm test` passed 272 files and 3,883 tests;
- `npm run typecheck`, `npm run architecture:check` (494 source files),
  `npm run build`, and cumulative `git diff --check` passed;
- commit boundaries and trailers were inspected, with no push performed;
- installation, restart, readiness validation, and real Feishu validation were
  intentionally not performed because this delivery run did not authorize a
  deployment.
