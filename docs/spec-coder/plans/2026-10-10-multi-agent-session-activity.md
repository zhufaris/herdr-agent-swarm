# Multi-Agent Session Activity Compatibility Plan

Specification:
[`../specs/2026-10-10-multi-agent-session-activity.md`](../specs/2026-10-10-multi-agent-session-activity.md)

Approval state: Gate 1 design approved; Gate 2 specification approved; Gate 3
ticket plan and implementation authorization pending.

## Prepared Workspace and Baseline

- Workspace: in-place at
  `<repo>`.
- Branch and base: `main` at
  `6c9441d460da96d5fe9bb5c2006aed2f35c2f7b2`, 128 commits ahead of
  `origin/main` when planning began.
- Rationale: the task-owned projection, compatibility-adapter, recovery, test,
  specification and plan paths are separable from current user work. A new
  worktree based on the remote default would omit the local integration stack
  that contains the relevant Session Activity behavior.
- User work to preserve and exclude: modified `AGENTS.md`,
  `src/store/sqlite/prepared-delivery-store.ts`, and
  `tests/prepared-delivery-store.test.ts`; untracked `.tmp-build/`,
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`,
  and `handoff.md`.
- Dependencies: existing `node_modules` is present; no new package is planned.
- Fresh baseline: `npm test` passed 298 files and 4,436 tests;
  `npm run typecheck` passed; `npm run build` passed with build identity
  `sha256:190136aec5bc346fa97e610341b79db3c3593e78d87a17c643ea6c85d8e30a41`.
- Known excluded red signal: `npm run smoke:headless-multi-agent` fails before
  execution because it imports removed `src/events/instance-work-scheduler.js`.
  Repairing that stale script is outside the approved specification.

## Tickets

### - [x] T1: Project live multi-agent Tool lifecycle into Subagents

| Field | Plan |
| --- | --- |
| What to build | Add a strict compatibility translator for correlated `multi_agent_v1` Tool call/result pairs and apply its spawn, wait, and close mutations through the existing Session Activity Agent-item projection. A successful spawn becomes visible immediately after its result; structured wait/close results advance the same stable child. Tool history remains in the Answer Timeline. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6; INV-1, INV-2, INV-3, INV-4; ARCH-1, ARCH-2, ARCH-3, ARCH-4, ARCH-6; protocol translator, live projection, projection-invariant, card-acceptance and architecture testing decisions. |
| Dependencies | None. |
| Delegation eligibility | Eligible: the external schemas, captured production shapes, mutation scope and deterministic focused seams are grounded; work is bounded and reversible; no credential or main-only authority is required. |
| Delegation mode | Default serialized direct worker. This is a standard TDD task. Main retains Red acceptance, diff integration, fresh verification, staging and commit authority. |
| Ownership and implementation path | Core Event Ingestion owns exact call/result correlation and external-schema translation. Conversation Projection owns stable `agent_id` state, metadata preservation, terminal monotonicity, visible fingerprint and card invalidation. Add one deep translator module returning a small internal mutation shape; extend the existing Session Activity store interface/implementation only as required to consume it. Card renderers remain pure and unchanged unless a production-shaped test exposes a real display defect. |
| Mutation ownership | A new focused translator under `src/runtime/` or the existing external-event adapter area; the minimal internal mutation type/port under `src/domain/`; `src/store/sqlite/session-activity-store.ts`; `src/store/sqlite/capability-graph.ts`; focused new translator tests plus `tests/session-activity-store.test.ts`, `tests/herdr-event-projector.test.ts`, `tests/run-card.test.ts` or the nearest production-shaped integration test. The new specification and plan may be included in this ticket's commit. |
| Exclusions | All preserved user paths; Core/TraeX/Herdr code; SQLite schema migration; startup/history recovery; parsing UI messages, Pane text, prompts, assistant prose or arbitrary result prose; Worker Runtime; deployment and service lifecycle actions. |
| Isolation | Serial mutation in the prepared in-place workspace. No parallel mutation. The worker must return a complete attributable diff without staging or committing. |
| Concurrency conflicts | Cannot overlap T2 because both may edit Session Activity store interfaces and tests. Cannot overlap unrelated changes to Core event projection or Session Activity. |
| Verification seam | Red first with production-shaped correlated spawn Tool events that currently leave `kind=agent` absent and the card without `Subagents`. Add pure translator Reds for spawn/wait/close and rejection cases. Green through the real Core inbox/capability graph/Session Activity/card path while separately asserting Tool timeline preservation and import boundaries. Then run affected Vitest files, typecheck, architecture check and build. |
| Host capacity | One direct worker slot. Recheck live capacity before dispatch. If capacity is temporarily zero, wait; if spawning is unavailable, main may execute locally because delegation was not explicitly required. |
| Direct-child boundary | `delegation_allowed = false`; the worker must not spawn directly or indirectly, invoke delegating workflows, stage, commit, push, deploy, restart services, or mutate production state. |
| Acceptance criteria and verification | One exact successful spawn creates one bounded Agent item keyed by returned `agent_id` and renders `Subagents`; wait updates only named targets; close converges completed/failed/interrupted; duplicate and stale nonterminal evidence cannot regress terminal state; malformed, truncated, cross-session and unknown evidence does nothing; task/result content is absent; Tool history remains visible. |
| Blocked by | None. |

Suggested atomic commit:
`fix(session-activity): project multi-agent tool lifecycle`.

### - [x] T2: Recover retained multi-agent activity for active sessions

| Field | Plan |
| --- | --- |
| What to build | Add bounded reconciliation that scans retained, settled multi-agent Tool pairs for the exact active Primary session, runs the T1 translator, reduces the latest supported state per `agent_id`, and applies missing Session Activity Agent items idempotently. Wire it into an existing startup/periodic convergence path and wake ordinary card delivery only for a changed visible fingerprint. |
| Spec references | SCN-4, SCN-5, SCN-6, SCN-7; INV-3, INV-4, INV-5; ARCH-4, ARCH-5, ARCH-6; recovery, projection-invariant, card-acceptance and architecture testing decisions. |
| Dependencies | T1 supplies the approved translator and internal mutation path. |
| Delegation eligibility | Eligible after T1 is committed: the retained-event query, exact fences, bounded reducer and reopen seam are deterministic and independently inspectable. No external authority is required. |
| Delegation mode | Default serialized direct worker after T1. Main retains recovery-scope judgment, diff integration, fresh verification, staging and commit authority. |
| Ownership and implementation path | SQLite Session Activity owns derived-view recovery from durable retained evidence. Query only projected/ignored Core lane items joined to exact active binding/session evidence; correlate by Agent kind, session and call ID; preserve lane ordering; apply the same translator and item invariants as live projection. Existing startup/view convergence owns scheduling and retry. Outbox/card delivery remains unchanged. |
| Mutation ownership | `src/store/sqlite/session-activity-store.ts` and its domain port; the nearest current-session/startup convergence coordinator and composition wiring only as needed; `tests/session-activity-store.test.ts`, `tests/startup-view-converger.test.ts`, and one production-shaped restart/integration test. T1-owned translator files may receive only recovery-required, behavior-preserving reuse changes. |
| Exclusions | All preserved user paths; schema migration; Core checkpoint rewind; synthetic Core events; direct Agent or Lark calls; bulk historical backfill; payload-compacted history guesses; stale smoke-script repair; deployment, restart or production database edits. |
| Isolation | Serial mutation in the prepared in-place workspace after T1. No parallel mutation. The worker must start from the accepted T1 commit and return an attributable diff without staging or committing. |
| Concurrency conflicts | Cannot overlap T1 or other Session Activity/startup convergence mutation. |
| Verification seam | Red with a reopened database containing retained settled production-shaped Tool pairs and no Agent items; current behavior keeps `Subagents` absent. Green after one bounded convergence creates the expected latest view and visible invalidation, while a second pass produces no new item, revision, outbox intent or Agent input. Include wrong-session, incomplete-pair, compacted-payload and bounded-page cases. Run affected tests, typecheck, architecture check and build. |
| Host capacity | One direct worker slot after T1 acceptance. Recheck capacity before dispatch; wait on temporary exhaustion. Spawn-unavailable may fall back to main-local execution. |
| Direct-child boundary | `delegation_allowed = false`; the worker must not spawn directly or indirectly, invoke delegating workflows, stage, commit, push, deploy, restart services, or access production credentials/state. |
| Acceptance criteria and verification | An active session with retained pre-fix multi-agent pairs gains the same Subagents view as live projection; only fully correlated exact-session evidence is used; recovery is bounded and restart-safe; repeating it is behaviorally idempotent; Core settlement/checkpoints, Tool history and Agent input are unchanged; visible equality suppresses duplicate card work. |
| Blocked by | T1. |

Suggested atomic commit:
`fix(session-activity): recover retained multi-agent state`.

## Execution Waves

The two tickets share projection ownership and have a real dependency, so they
form two serialized waves. No parallel mutation is permitted:

```text
Wave 1: T1 [default direct worker, standard TDD]
                |
                v
       main inspection + verification + commit
                |
                v
Wave 2: T2 [default direct worker, standard TDD]
                |
                v
       main inspection + verification + commit
```

Live Host capacity, routing and child handles are re-evaluated at each wave and
remain conversational state. The ticket checkboxes and accepted commits are
the durable task state.

## Final Delivery Checks

- [x] Every SCN/INV/ARCH reference is covered by accepted T1 or T2 evidence.
- [x] Both tickets have fresh Red/Green evidence at their approved public seams.
- [x] Complete diffs contain no preserved user path or unrelated generated output.
- [x] `npm run typecheck`, `npm run architecture:check`, and `npm run build` pass.
- [x] The full `npm test` suite passes freshly after both commits.
- [x] Standards and specification reviews report no unresolved blocking finding.
- [x] The production-shaped persistent-event path renders `Subagents` without exposing prompt/result content or suppressing Tool history.
- [x] No installation, restart, production SQLite mutation, live Feishu action, push or pull request occurs without separate authorization.

Gate 3 approval authorizes T1 and T2 implementation through TDD, path-scoped
atomic commits, plan-checkbox updates, review and fresh verification. It does
not authorize installation, restart, production-state mutation, live Feishu
smoke, push, pull request, Core/TraeX/Herdr changes, or repair of the stale
headless smoke script.
