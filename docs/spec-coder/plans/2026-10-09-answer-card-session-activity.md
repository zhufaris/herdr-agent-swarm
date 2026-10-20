# Answer Card Subagent Activity and Human Review Repair Plan

Specification:
[Answer Card Subagent Activity and Human Review Repair](../specs/2026-10-09-answer-card-session-activity.md)

## Workspace, authorization, and baseline

- Workspace mode: in-place, serial. Workspace:
  `<repo>`; branch: `main`; starting
  revision: `4bafce330f4463573d3af717c1f7349e737100c5`.
- In-place work is safe because task-owned spec, plan, source, and test edits
  can be path-scoped and the session currently prohibits proactive subagent
  delegation. No parallel mutating worker is planned.
- Preserve and exclude the pre-existing modified `AGENTS.md` and untracked
  `.tmp-build/`, `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- All four implementation tickets are approved and complete. ASA-R4 preserves
  canonical Tool history in the Answer Timeline while Session Activity owns
  only the latest Subagent state.
- Fresh baseline passed 90 tests across `tests/turn-card-workflow.test.ts`,
  `tests/turn-card.test.ts`, `tests/conversation-segment-store.test.ts`, and
  `tests/session-activity-store.test.ts`; `npm run typecheck` and
  `npm run build` also passed.
- Installation, restart, real Feishu smoke, production SQLite mutation, push,
  PR creation, and deployment remain unauthorized.

## Ticket dependencies and execution waves

The tickets have no functional dependency edges. They are deliberately run as
four one-ticket main-local waves because they touch adjacent contracts and T2
and T3 both modify Conversation Segment projection code.

```text
Wave 1: ASA-R1  Goal, Task List-style Subagents, Compaction, and visibility
    |
    v
Wave 2: ASA-R2  Latest-segment and frozen-cursor consistency
    |
    v
Wave 3: ASA-R3  Choice-gated Human Review and final requester notification
    |
    v
Wave 4: ASA-R4  Tool history and latest Subagent-state separation
    |
    v
Independent review and full verification
```

The arrows encode the safe serial implementation order, not artificial
business dependencies. Each completed ticket must leave the repository green
and receive its own atomic commit.

## Tickets

### - [x] ASA-R1: Render bounded Answer activity below the existing Goal

| Field | Plan |
| --- | --- |
| What to build | Preserve the existing Goal, narrow shared Session Activity display to Subagent status plus Compaction count, render `Subagents` directly below Task List with the same compact/collapsible timeline, and render Compaction below Subagents. Remove the visible `Session Activity`/Tools presentation. Move Subagent-and-Compaction fingerprint ownership into `SessionActivityStore`; return `{ outcome, visibleChanged }`; let Capability Graph invalidate only from that evidence. Visible stale-producer cleanup is `outcome: "projected", visibleChanged: true`; non-visible duplicate/stale/ignored/projected inputs do not deliver. |
| Spec references | SCN-1, SCN-2, SCN-6; INV-1, INV-3, INV-6; ARCH-1, ARCH-2, ARCH-9; Compatibility and Migration. |
| Dependencies | None. |
| Delegation eligibility | Technically bounded and testable through pure renderer/store seams, but the active session policy prohibits proactive subagent delegation. |
| Delegation mode | Main-local, one-ticket wave. Reason: explicit current no-delegation policy. |
| Ownership and implementation path | Conversation Projection continues to own the existing Goal. Session Activity Projection owns canonical reduction, producer cleanup, the derived Subagent/Compaction display, and visible equality. Capability Graph consumes the typed result and remains orchestration only. Card renderers consume bounded display data and remain pure; after the completion block, Answer Card orders Goal, Task List, Subagents, then Compaction. Existing stored non-visible facts remain compatible but cannot affect this display fingerprint. |
| Mutation ownership | `src/domain/session-activity.ts`, `src/domain/ports/session-activity.ts` if its public result type is declared there, `src/cards/session-activity.ts`, `src/store/sqlite/session-activity-store.ts`, `src/store/sqlite/capability-graph.ts`, directly affected Main/Pane card adapter code only if required by the narrowed shared type, `tests/session-activity-store.test.ts`, and renderer tests in `tests/turn-card.test.ts` or the existing Main/Pane card test. |
| Exclusions | No Conversation Segment page-selection/cursor changes; no Human Review changes; no deletion/migration of stored activity facts; no Core event/schema, SQLite schema, Outbox, or Delivery Ring changes; preserve user-owned files. |
| Isolation | Serial/shared in the current in-place workspace. No parallel mutation or separate worktree is needed. |
| Concurrency conflicts | Must not overlap ASA-R2 because both meet in Capability Graph/convergence behavior; must not overlap ASA-R3 because both affect Turn Card assertions. |
| Verification seam | Red/Green assertions on `SessionActivityProjectionResult`, stale-producer cleanup, no-delivery cases, and pure CardKit output. Separate structural evidence: TypeScript public type consumers and composition compile without Capability Graph fingerprint reads. |
| Host capacity | One local execution slot. No child capacity required; live capacity is irrelevant for this main-local wave. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn another agent, mutate, stage, or commit. No child is planned. |
| Acceptance criteria and verification | Existing Goal remains visible. Subagent dispatch/state/termination produces `Subagents` directly below Task List with the same compact/collapsible presentation; its optional model is shown and Compaction appears below it. `Session Activity`, Tools, running/completed `exec` rows, standalone Primary model, turn, and token/context are absent from this activity presentation. Empty Subagents are omitted while Compaction keeps its own rule; Main/Pane shared consumers use the narrowed contract. Visible Subagent cleanup or Compaction change yields `visibleChanged: true` and one invalidation. Duplicate/stale/ignored/invisible changes yield `visibleChanged: false` and no delivery. Run focused Session Activity and card tests, `npm run typecheck`, and `git diff --check`. |
| Blocked by | None. |

Suggested atomic commit:
`fix(session-activity): project visible subagent changes`

### - [x] ASA-R2: Keep latest-segment invalidation and frozen cursors consistent

| Field | Plan |
| --- | --- |
| What to build | Select the newest fenced Primary segment before checking page eligibility, preventing fallback to an older final card. Refactor `TurnCardWorkflow` so every reserved card persists the cursor from that exact render plan; an activity-free frozen plan supplies both frozen card and continuation start, including the end-of-timeline/activity-only continuation edge. |
| Spec references | SCN-3, SCN-4, SCN-6; INV-1, INV-2, INV-4, INV-6; ARCH-3, ARCH-4, ARCH-9; Behavior and Failure Modes. |
| Dependencies | None. It consumes the existing Session Activity read seam already present at baseline; the serial order after ASA-R1 is for conflict control. |
| Delegation eligibility | Bounded and independently testable through Conversation Segment store and workflow fakes, but proactive subagent delegation is currently prohibited. |
| Delegation mode | Main-local, one-ticket wave. Reason: explicit current no-delegation policy and overlap with projection/card tests. |
| Ownership and implementation path | Conversation Projection owns latest-segment identity and page eligibility as ordered checks. `TurnCardWorkflow` owns render planning and cursor globalization; a planned card and its cursor form one reservation boundary. Existing page state, outbox reservation, checkpoint, notifier, and recovery semantics remain authoritative. |
| Mutation ownership | `src/store/sqlite/conversation-segment-store.ts`, `src/coordinator/turn-card-workflow.ts`, `tests/conversation-segment-store.test.ts`, and `tests/turn-card-workflow.test.ts`. A small local planning type/helper may be changed only within the workflow/card boundary if Red tests require it. |
| Exclusions | No Session Activity display/result redesign beyond consuming ASA-R1; no Human Review behavior; no schema migration unless evidence contradicts the approved specification and reopens design; no recovery/quarantine policy change; preserve user-owned files. |
| Isolation | Serial/shared in the current in-place workspace. No parallel mutation or separate worktree is needed. |
| Concurrency conflicts | Cannot share a mutation wave with ASA-R1 due to convergence assertions or ASA-R3 due to `conversation-segment-store.ts` ownership. |
| Verification seam | SQLite regression with an older final segment plus newer page-less segment; workflow fake returning distinct activity-bearing and activity-free cursors/cards; restart/idempotent convergence assertion. Separate structural evidence: reservation calls pair card/cursor from one plan and currentness SQL orders segments before page lookup. |
| Host capacity | One local execution slot. No child capacity required. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn another agent, mutate, stage, or commit. No child is planned. |
| Acceptance criteria and verification | A newer page-less Primary segment causes a no-op and the older final card is untouched. The frozen card and saved cursor come from the activity-free replan; continuation begins at exactly that cursor. If frozen planning consumes all timeline content, a continuation still owns live activity without skipped/duplicated timeline content. Repeated/restarted convergence is idempotent and frozen pages remain immutable. Run the two focused test files, affected integration tests, `npm run typecheck`, `npm run build`, and `git diff --check`. |
| Blocked by | None. |

Suggested atomic commit:
`fix(turn-card): align frozen plans and current segments`

### - [x] ASA-R3: Unify choice-gated review and trusted final mentions

| Field | Plan |
| --- | --- |
| What to build | Make Human Review render state exist only for a valid persisted canonical completion choice belonging to the exact current owner/generation/final card. Place its question, buttons, and mention immediately after the Answer Timeline and before Goal. Add bounded recognition of the exact `@_user_1` marker in canonical final Markdown outside code, remove it from visible answer text, resolve only the trusted segment requester, render one native mention in that completion block, and release one ACK-gated native notification. Coalesce final-request and Human Review intent so they never duplicate the mention or notification. |
| Spec references | SCN-5 through SCN-7; INV-5 through INV-8; ARCH-5 through ARCH-9; Behavior and Failure Modes; Compatibility and Migration. |
| Dependencies | None. The serial order after ASA-R2 avoids shared Conversation Segment mutation. |
| Delegation eligibility | Bounded and independently testable through completion-state persistence and pure rendering seams, but proactive subagent delegation is currently prohibited. |
| Delegation mode | Main-local, one-ticket wave. Reason: explicit current no-delegation policy. |
| Ownership and implementation path | Conversation Projection owns final-channel marker extraction, stable segment/final-event intent, validated choice persistence, trusted requester resolution, and exact owner/generation/card eligibility. Reuse the existing completion notification obligation rather than introduce another notification aggregate. The read model exposes one completion-block reason (`human_review`, `final_request`, or both). Answer Card Presentation places question/buttons/mention immediately after the timeline, before Goal/Task List/Subagents/Compaction, and fabricates no identity or controls. Completion notification release verifies exact ACK payload evidence and selects Human Review wording when both reasons coexist. |
| Mutation ownership | `src/domain/` for one bounded Markdown marker extractor or completion-block type, `src/store/sqlite/conversation-segment-store.ts`, `src/store/sqlite/completion-notification-store.ts`, `src/cards/turn-card.ts`, `src/cards/completion-actions.ts` only if needed for a single ordered render group, `tests/conversation-segment-store.test.ts`, `tests/turn-card.test.ts`, and the nearest completion-notification/integration tests. No migration/schema file is owned. |
| Exclusions | No new choice/event/SQLite schema, Core protocol, arbitrary alias or `open_id` parsing, commentary/non-final notification, generic fallback action, remote approval, notification transport redesign, Session Activity logic, historical backfill, or deployment; preserve user-owned files. |
| Isolation | Serial/shared in the current in-place workspace. No parallel mutation or separate worktree is needed. |
| Concurrency conflicts | Cannot overlap ASA-R2 because both mutate `conversation-segment-store.ts`; cannot overlap ASA-R1 because Turn Card output assertions may move. |
| Verification seam | Persistence tests for valid/absent/invalid/stale/wrong-owner choices and exact requester fences; pure extractor tests for outside-code versus inline/fenced-code tokens; serialized CardKit order assertions; ACK/retry/restart tests for one notification. Separate structural evidence: the read type distinguishes Human Review from final-request completion-block intent and carries no Agent-controlled identity. |
| Host capacity | One local execution slot. No child capacity required. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn another agent, mutate, stage, or commit. No child is planned. |
| Acceptance criteria and verification | Immediately after Answer Timeline, a valid choice renders question, business/Ignore buttons, then one mention; Goal follows. Without choice, no Human Review UI or fallback appears. A valid final marker outside code is removed and renders one trusted mention in that same position; after exact card ACK it releases one native notification. Repeated markers, replay, retry, restart, or replacement remain single-shot. Tokens in code/commentary, unknown aliases, raw IDs, stale owners, or missing requesters cannot notify. Combined choice and marker produce one action block and one Human Review notification. Existing action callback fencing and terminal Conversation state remain green. Run focused card/store/notification/integration tests, `npm run typecheck`, `npm run build`, and `git diff --check`. |
| Blocked by | None. |

Suggested atomic commit:
`fix(turn-card): deliver trusted requester mentions`

### - [x] ASA-R4: Separate canonical tool history from latest Subagent state

| Field | Plan |
| --- | --- |
| What to build | Keep every supported canonical `tool_call`/`tool_result` in the Answer Timeline, including collaboration calls categorized as `Agent`. Stop projecting `agent_activity` into the Answer Timeline; continue reducing it into the current `Subagents` presentation with optional model. Preserve `update_plan` as Task List-only. |
| Spec references | SCN-8; INV-9; ARCH-10; Compatibility and Migration. |
| Dependencies | None. ASA-R1 is already complete and supplies the independent Session Activity/Subagents path. |
| Delegation eligibility | Bounded and independently testable, but the active session policy prohibits proactive subagent delegation. |
| Delegation mode | Main-local, one-ticket wave. Reason: explicit current no-delegation policy. |
| Ownership and implementation path | `HerdrEventProjector` owns translation of canonical Core tool and lifecycle events into Answer Timeline deltas. `isAnswerVisibleToolActivity` owns tool-category visibility. Session Activity Projection independently owns latest `agent_activity` state. No persistence or renderer contract changes are required. |
| Mutation ownership | `src/runtime/tool-activity-projector.ts`, `src/runtime/herdr-events/event-projector.ts`, `tests/tool-activity-projector.test.ts` if needed, `tests/herdr-event-projector.test.ts`, and the nearest existing integration test only if focused coverage cannot prove the cross-projection boundary. |
| Exclusions | No Core protocol, SQLite schema, Conversation Segment persistence, card renderer, Delivery Ring, Human Review, mention, deployment, or historical frozen-card changes; preserve user-owned files. |
| Isolation | Serial/shared in the current in-place workspace. No parallel mutation or separate worktree is needed. |
| Concurrency conflicts | No concurrent mutation is permitted. The ticket follows the already committed ASA-R1 through ASA-R3 work. |
| Verification seam | Red/Green projector tests prove collaboration/Agent tool call and result deltas are present and stable while `agent_activity` yields no timeline delta. Existing Session Activity tests prove the same lifecycle event still updates Subagents with model. Separate structural evidence comes from typecheck and architecture import checks. |
| Host capacity | One local execution slot. No child capacity required. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn another agent, mutate, stage, or commit. No child is planned. |
| Acceptance criteria and verification | `exec`, `collaboration__list_agents`, and `collaboration__followup_task` calls appear in Answer Timeline and matching results update the same logical tool item. `agent_activity` no longer creates a timeline status item but still produces the latest Subagent status/model. `update_plan` remains absent from tool history and present through Task List. Run focused projector/session tests, `npm run typecheck`, `npm run architecture:check`, `npm run build`, `git diff --check`, then the full suite. |
| Blocked by | None. |

Suggested atomic commit:
`fix(answer-timeline): retain agent tool history`

## Coverage check

| Approved requirement | Responsible ticket(s) |
| --- | --- |
| SCN-1 Goal plus Task List/Subagents/Compaction ordering | ASA-R1 |
| SCN-2 typed visible-change semantics | ASA-R1 |
| SCN-3 newest-segment-first invalidation | ASA-R2 |
| SCN-4 frozen card/cursor consistency | ASA-R2 |
| SCN-5 choice-gated ordered Human Review | ASA-R3 |
| SCN-6 duplicate/failure/recovery behavior | ASA-R1, ASA-R2, ASA-R3 |
| SCN-7 final requester mention and notification | ASA-R3 |
| SCN-8 tool history and latest Subagent-state separation | ASA-R4 |
| INV-1 single current live page | ASA-R1, ASA-R2 |
| INV-2 exact frozen card/cursor boundary | ASA-R2 |
| INV-3 only visible Subagent or Compaction changes invalidate | ASA-R1 |
| INV-4 latest segment before page eligibility | ASA-R2 |
| INV-5 Human Review UI implies valid choice | ASA-R3 |
| INV-6 no terminal-state/input replay side effects | ASA-R1, ASA-R2, ASA-R3 |
| INV-7 trusted requester identity only | ASA-R3 |
| INV-8 one coalesced ACK-gated notification | ASA-R3 |
| INV-9 distinct tool-history and Subagent-state ownership | ASA-R4 |
| ARCH-1 and ARCH-2 | ASA-R1 |
| ARCH-3 and ARCH-4 | ASA-R2 |
| ARCH-5 through ARCH-8 | ASA-R3 |
| ARCH-9 dependency direction | All tickets |
| ARCH-10 timeline/activity projection boundary | ASA-R4 |

Every in-scope scenario, invariant, architecture decision, interaction rule,
and testing seam has an owner. There are no unresolved load-bearing product or
architecture decisions.

## Final delivery checks

After all four ticket commits:

1. inspect the complete task diff and atomic commits against the approved spec;
2. run the focused renderer, workflow, Conversation Segment, Session Activity,
   completion notification, and completion integration tests;
3. run `npm run typecheck`, `npm run architecture:check`, `npm run build`,
   `git diff --check`, and `npm test`;
4. perform findings-first Specification and Standards reviews and repair every
   material in-scope finding through the owning ticket;
5. confirm the final task commits exclude all pre-existing user-owned files.

Do not install, restart, deploy, mutate production data, push, or open a PR
without separate authorization.
