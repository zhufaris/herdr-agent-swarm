# Completion Mention and Subagent Terminal Recovery Plan

Specification:
[`../specs/2026-10-10-completion-mention-and-subagent-terminal-recovery.md`](../specs/2026-10-10-completion-mention-and-subagent-terminal-recovery.md)

Approval state: revised Gate 1 design approved; revised Gate 2 specification
approved; reopened Gate 3 ticket plan and T1/T2 implementation authorized.

## Prepared Workspaces and Baseline

- Swarm: in-place at
  `<repo>`, branch `main`, starting
  revision `e6c7d4ead6a6ec7ee6f0400c82eaadebd2d26518`.
- Core: verification-only existing worktree
  `/tmp/herdr-core-result-handoff`, branch `feat/result-handoff`, revision
  `2c0bff83eef7159bba99f5dec82b36ccc4866105`. It is clean, and `Cargo.lock`
  remains excluded.
- TraeX: installed internal binary `traecli 0.208.1`; no runtime source
  checkout is available, so producer mutation and its upstream tests are not
  currently executable.
- Preserved Swarm user work: modified `AGENTS.md`; untracked `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh baseline: Swarm focused tests 68/68, full suite 298 files/4430 tests,
  typecheck and build passed. Core locked codec suite 37/37 passed with Zig
  0.16.0 and task-local `/tmp` caches.

The active collaboration policy does not authorize Subagent delegation. Ready
work therefore uses serialized one-ticket, main-local waves. The unavailable
TraeX producer ticket is retained as an explicit blocked dependency rather than
being replaced by message-shape inference.

## Tickets

### - [ ] U1: Guarantee an explicit TraeX terminal handoff event

| Field | Plan |
| --- | --- |
| What to build | In the TraeX collaboration producer, emit one stable `collab_close_end` whenever an automatically completed child result is accepted for its parent; emit an explicit failed terminal outcome on automatic failure. Ordinary `agent_message` records remain nonterminal. |
| Spec references | SCN-1, SCN-2, SCN-3; INV-1; ARCH-1, ARCH-2; TraeX producer testing decision. |
| Dependencies | None at the protocol level. A source checkout and upstream owner are execution prerequisites. |
| Delegation eligibility | Not eligible now: the source repository, build instructions and mutation owner are unavailable, and current policy also does not authorize delegation. |
| Delegation mode | Blocked external/upstream ticket; no local fallback and no heuristic implementation. |
| Ownership and implementation path | TraeX collaboration lifecycle owns the terminal decision and event identity. The event crosses Core's existing decoder boundary as `collab_close_end`; Core already maps successful status to completed `agent_activity` plus `delivered_to_parent`. |
| Mutation ownership | Exact TraeX producer files are unresolved until the authoritative source checkout and owner are supplied. No mutation is permitted in the installed internal binary. |
| Exclusions | Core inference from `agent_message`, `encrypted_content`, prose, timeout or parent Turn completion; scheduler policy changes; binary patching; publication or deployment. |
| Isolation | Requires a separately prepared and validated TraeX source workspace before mutation. |
| Concurrency conflicts | Cannot overlap another mutation of the same upstream collaboration lifecycle producer once located. It does not block local T1/T2 implementation, but blocks end-to-end closure of the Subagent symptom. |
| Verification seam | Upstream Red/Green fixtures for automatic success, automatic failure, duplicate/replay identity and ordinary progress messages; then a real transcript proves Core receives `collab_close_end`. Existing Core codec tests remain consumer-preservation evidence. |
| Host capacity | Unknown until the upstream workspace is available. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn, stage or commit. |
| Acceptance criteria and verification | Every automatic terminal child outcome produces exactly one replay-stable explicit terminal record; ordinary and final-looking `agent_message` records produce none. A successful record reaches Core as completed activity with `delivered_to_parent`. |
| Blocked by | Missing authoritative TraeX runtime source checkout, build/test contract and mutation owner. |

Revalidation evidence (2026-10-11): the installed runtime is `traecli 0.209.1`
(`installation: internal`), but no authoritative TraeX producer source checkout
or build/test contract exists under the available workspaces. A read-only query
of the live canonical `core_event_inbox` found zero `agent_activity` events with
`payload.result_handoff = "delivered_to_parent"`. The observed canonical
`agent_activity` payload keys are only `agent_id`, `display_name`, `model`,
`state`, and `type`; completed rows therefore do not prove parent handoff. Broad
text matches for `collab_close_end` were false positives from message/tool
content and are not acceptable evidence. U1 remains externally blocked and
must not be closed from the installed binary alone.

The exact live source boundary is now isolated. The current Herdr-bound Primary
Session `01a124cc-6b1e-73f1-99e6-1625782edd5e` is ingesting through Core, and
fresh delegated agents from this turn appear in its rollout only as
`event_msg/item_completed/CollabAgentToolCall`, `history_mutation`, and
`world_state`. The rollout contains no serialized `collab_close_end` or
`sub_agent_activity` record. Although the unstripped 0.209.1 binary contains
`CollabCloseEndEvent` symbols, that runtime event is not written into the
rollout stream consumed by Herdr Core. The upstream repair therefore belongs at
the TraeX rollout/event persistence boundary: persist one replay-stable terminal
collaboration record carrying call ID, receiver thread ID, nickname and explicit
completed/failed status. Swarm and Core consumer changes are not a substitute.

No commit message is proposed until the upstream repository and its instructions
are available.

### - [x] T1: Converge Session Activity terminal state without losing metadata

| Field | Plan |
| --- | --- |
| What to build | Make Swarm update the existing Session Activity Subagent item from an explicit canonical terminal event while retaining the previously known display name and model when that event omits them. Prevent later nonterminal evidence from regressing a terminal item. Preserve the Answer Timeline versus Session Activity routing boundary. |
| Spec references | SCN-1, SCN-3, SCN-4, SCN-5; INV-2, INV-3; ARCH-2, ARCH-3; Session Activity and event-routing testing decisions. |
| Dependencies | None for the local reducer capability. U1 is required only for end-to-end automatic terminal evidence in production. |
| Delegation eligibility | Bounded and independently inspectable, but current collaboration policy does not authorize delegation. |
| Delegation mode | `main-local`; one-ticket wave. |
| Ownership and implementation path | Conversation Projection owns the read-model transition. Update the SQLite Session Activity reducer/upsert path for the same stable `agent_id`; use stored label/model as fallback and make terminality monotonic. The canonical event projector keeps existing routing. |
| Mutation ownership | `src/store/sqlite/session-activity-store.ts`, `tests/session-activity-store.test.ts`, and only if needed for routing preservation `tests/herdr-event-projector.test.ts`. The specification and plan may be committed with this first Swarm ticket. |
| Exclusions | `AGENTS.md`, `.tmp-build/`, the other pre-existing untracked files, Answer Timeline source behavior, CardKit layout, Worker Runtime, Core/TraeX files, schema migration, and unrelated goal/task/compaction behavior. |
| Isolation | Serial in-place mutation on Swarm `main`; explicit path-scoped staging only. |
| Concurrency conflicts | Cannot share a mutation wave with another Session Activity projection change. It is serialized before T2 by policy, not by a functional dependency. |
| Verification seam | Red: running activity with name/model followed by metadata-light terminal activity loses identity metadata or later running evidence regresses it. Green: focused store tests prove same-item convergence, metadata preservation, idempotency, terminal monotonicity and correct projection reservation. Existing projector tests prove tools remain in Answer Timeline and activity remains Session Activity-only. Then run affected tests, typecheck and build. |
| Host capacity | One local executor; no additional Host slot required. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn, stage or commit. |
| Acceptance criteria and verification | Explicit terminal evidence changes the visible Subagent from `running` to `returned to main`, retains prior model/name, creates no duplicate, and cannot be regressed by later running evidence. Tool calls/results remain in Answer Timeline; `agent_activity` does not enter it. |
| Blocked by | None for implementation. U1 blocks only production end-to-end acceptance. |

Proposed Swarm commit message:
`fix(session-activity): preserve terminal subagent identity`.

### - [x] T2: Recover ACK-gated Segment completion mentions

| Field | Plan |
| --- | --- |
| What to build | Release a Primary Segment completion-notification obligation from the exact durably delivered presentation reply even after page checkpointing clears `pending_reply_id`. Retry the same atomic release through ordinary Segment and startup convergence, with structured refusal outcomes and stable idempotency. |
| Spec references | SCN-6, SCN-7, SCN-8, SCN-9; INV-4, INV-5, INV-6; ARCH-4, ARCH-5, ARCH-6; mention release, refusal/atomicity and startup testing decisions. |
| Dependencies | None. It is behaviorally independent of T1 and U1. |
| Delegation eligibility | The SQLite transition and tests are bounded, but current collaboration policy does not authorize delegation. |
| Delegation mode | `main-local`; one-ticket wave. |
| Ownership and implementation path | Delivery and Operations owns delivered replies and notification outbox; Conversation Projection owns Segment/page identity. Refactor the shared release predicate to return structured outcomes, remove `pending_reply_id` only from durable ACK proof, expose one transactional Segment recovery operation, add waiting obligations with delivered presentations to bounded actionable discovery, and invoke it from existing Turn Card/startup convergence. Reservation and obligation transition stay atomic. |
| Mutation ownership | `src/store/sqlite/completion-notification-store.ts`, `src/store/sqlite/conversation-segment-store.ts`, `src/domain/ports/conversation-segment.ts`, `src/coordinator/turn-card-workflow.ts`; focused tests in `tests/conversation-segment-store.test.ts`, the nearest Turn Card workflow test, and `tests/startup-view-converger.test.ts`. Composition changes are allowed only if the existing `turnCards` port cannot carry recovery. |
| Exclusions | `AGENTS.md`, all preserved user files, SQLite schema migration, direct production repair, Lark renderer syntax, frozen-page mutation, Agent Input replay, Delivery Ring redesign, and unrelated Prompt/Worker notifications. |
| Isolation | Serial in-place mutation on Swarm `main`; explicit path-scoped staging only. |
| Concurrency conflicts | Must not overlap another mutation of Segment convergence, completion notifications or outbox ACK handling. It is independent of T1 but serialized. |
| Verification seam | Red: checkpoint a delivered final page so `pending_reply_id` is null while the obligation waits and show recovery is absent. Green: exact delivered `presentation_reply_id` reserves one stable notification through direct ACK and reopen/startup convergence. Negative cases return structured reasons without mutation; rollback/duplicate cases prove atomic exactly-once durable state. Then run affected SQLite/workflow tests, typecheck and build. |
| Host capacity | One local executor; SQLite tests use isolated temporary or in-memory stores. |
| Direct-child boundary | `delegation_allowed = false`; no child may spawn, stage or commit. |
| Acceptance criteria and verification | The production-shaped cleared-pointer case releases exactly once and records the notification reply. Repeated recovery creates no duplicate. Pending, rejected, mismatched, stale or invalid payload evidence fails closed with a structured reason. Startup finds the obligation without replaying an Answer or Agent Input. |
| Blocked by | None. |

Proposed Swarm commit message:
`fix(turn-card): recover acknowledged completion mentions`.

## Execution Waves

Only one local implementation wave is active at a time:

```text
Wave 1 [main-local T1, in-place Swarm]
              |
              v
Wave 2 [main-local T2, in-place Swarm]
              |
              v
Local delivery review and full Swarm verification

U1 [blocked upstream TraeX producer]
  `-> separate workspace preflight and reopened readiness review when available
```

T1 and T2 are functionally independent but serialized by the active
no-delegation policy. On resume, reconstruct readiness from these checkboxes and
committed SHAs; do not reuse stale transient wave handles.

## Final Delivery Checks

- [x] T1 and T2 have fresh Red/Green, affected-test, typecheck and build evidence.
- [x] Review Swarm source and tests for timeline separation, metadata
  preservation, terminal monotonicity, durable ACK authority, atomicity and
  startup convergence.
- [x] Run the Swarm focused suites, `npm run typecheck`, `npm run build`, and
  full `npm test`.
- [x] Run Core's locked codec suite as preservation evidence; make no Core
  commit unless new evidence reopens the approved design.
- [x] Inspect complete diffs and commits; confirm excluded user files and Core
  `Cargo.lock` are absent.
- [x] Run the two-axis standards/spec review required by delivery-coder.
- [x] Report U1 as blocked rather than claiming the Subagent production symptom
  is fully fixed until an upstream TraeX build emits the explicit event.
- [x] Do not install, restart, mutate production SQLite, push, or open a PR
  without separate explicit authorization.

Gate 3 approval authorizes T1 and T2 implementation, affected verification,
plan checkbox updates and the two proposed atomic Swarm commits. It records U1
as blocked but does not authorize binary patching, external publication, or
mutation of an unavailable TraeX repository.
