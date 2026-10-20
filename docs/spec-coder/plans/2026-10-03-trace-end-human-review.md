# Trace-End Human Review Implementation Plan

## Goal and authority

Implement the simplified specification at
`docs/spec-coder/specs/2026-10-03-trace-end-human-review.md` by deepening the
existing Completion Choice path. Do not add a trace-choice episode subsystem or
change Herdr-`blocked` Human Review behavior.

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place on `main`; task-owned files are separable from user work.
- Starting revision: `d3d6e0282fa70fad59471c71e37b890a4b253a35`.
- Preserve modified `TODO.md` and all initial untracked user paths recorded in
  the specification.
- Baseline before task edits: 254 test files and 3,683 tests passed;
  `npm run typecheck` and `npm run build` passed.
- Partial uncommitted protocol work from the superseded plan must be reconciled
  inside T1; it is not an approved result by itself.
- Reopened Gate 1, Gate 2, and Gate 3 are approved in conversation on
  2026-10-03.

## Global constraints

- The Stop Hook may extend an eligible trace once only and must fail open.
- JSON protocol is stripped from visible Answer content.
- Choices are ordinary FIFO Human Messages, never native-tool approval or
  terminal/Pane/process control.
- Ignore creates no Prompt or Turn.
- The Answer/Worker Task Card is the sole mutable interaction surface; the
  extra mention is immutable and contains no buttons.
- Answer component delivery must precede mention reservation.
- Existing `runtime_blocked` Human Review and already-delivered Completion
  Action Cards remain compatible.
- Stage explicit ticket-owned paths only. Each ticket ends in one Conventional
  Commit without `Trae CLI co-author attribution`.
- Do not deploy, restart, push, open a PR, or publish an external issue.

## Tickets

### - [x] T1: Evaluate and persist the trace-end review decision

**What to build**

Make every eligible first Stop ask the existing Skill for an explicit v2
`none` or `human_review` decision, normalize valid v1/v2 choices, hide reserved
protocol content, and persist only actionable specifications with their review
question.

**Spec references**

- SCN-1; protocol portions of SCN-2 and SCN-3.
- INV-6 and INV-7.
- Implementation Decisions: Domain Model, protocol validation, Hook fail-open,
  and compatibility.

**Ownership and implementation path**

- Complete the in-progress changes in `src/domain/completion-choice.ts`,
  `src/runtime/completion-choice-hook.ts`, `src/runtime/answer-stream.ts`, and
  `src/runtime/traex-transcript-projector.ts`.
- Keep v1 parsing compatibility while introducing a normalized v2 decision.
  Enforce the approved question/option/default/size/Ignore constraints.
- Update `plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md` while
  retaining plugin identity, fence, Hook registration, and lifecycle files.
- Add the minimum additive question metadata in `src/store/sqlite/schema.ts`
  and `src/store/sqlite/migrations.ts`. Extend
  `src/store/sqlite/completion-choice-store.ts` to persist v2 Human Review
  choices, retain v1 choices with compatibility question copy, and store
  nothing for `none` or invalid protocol.
- Make Primary and Worker completion eligibility skip when the exact terminal
  owner has no persisted actionable choice. Do not create fixed fallback
  obligations.

**Acceptance criteria and verification**

- Protocol tests prove v2 `none/human_review`, all bounds, reserved Ignore,
  invalid-fence hiding, streaming behavior, and v1 mapping.
- Hook tests prove every eligible first Stop is evaluated, valid decisions pass,
  repeated Stop and boundary failures fail open.
- SQLite tests prove question/options round trip, `none` creates no stored
  choice or completion obligation, v1 compatibility, and no-op reopen.
- Run the protocol, Hook, plugin wrapper, answer stream, transcript projector,
  eligibility, and SQLite store tests listed in the specification.
- Run `npm run typecheck` and `npm run build`.

**Blocked by:** None.

### - [x] T2: Render and consume Human Review components in Answer cards

**What to build**

Use the existing Completion Action Set to render question-specific Primary and
Worker Answer components, accept business choices through ordinary FIFO,
support local Ignore, remove fixed fallback actions for new completions, and
preserve historical callbacks.

**Spec references**

- SCN-2 through SCN-5 and SCN-7.
- INV-1 through INV-4, INV-6, and INV-7.
- Implementation Decisions: Answer as sole interaction surface, callback
  identity, Ignore, successor supersession, and legacy compatibility.

**Ownership and implementation path**

- Extend `src/domain/completion-action-set.ts` with question-bearing render
  state and a consumed Ignore result without adding a new episode state table.
- Update `src/cards/completion-actions.ts`, `run-card.ts`, and
  `worker-turn-card.ts` so only persisted actionable choices render; show the
  question, one to four business buttons, and system Ignore, and remove all
  buttons after consumption or supersession.
- Extend `src/coordinator/card-action-command.ts`, Primary card interaction,
  Worker instance interaction, and their ports with the exact Ignore action.
- In the existing Primary and Worker SQLite acceptance transactions, consume
  Ignore without work and retain exact choice-to-server-message lookup,
  one-shot conditional updates, actor/owner/generation/card fences, duplicate
  outcomes, queue failure rollback, and ordinary successor supersession.
- Remove creation/rendering of fixed fallback action sets for new completions.
  Do not delete the legacy `completion_action` parsing or consumption path.

**Acceptance criteria and verification**

- Card tests prove declared/compatibility question rendering, 1–4 business
  buttons plus Ignore, no fixed fallback, and consumed/ignored copy.
- Primary and Worker integration tests prove choice creates exactly one FIFO
  item, Ignore creates none, ordinary input supersedes, and all stale/wrong
  actor/duplicate/race cases are safe.
- Historical fixtures prove already-delivered fixed/dynamic action callbacks
  remain consumable once.
- Run card, Worker card, card-action, Primary interaction, Worker messaging,
  routing, and SQLite tests.
- Run `npm run typecheck` and `npm run build`.

**Blocked by:** T1.

### - [x] T3: Notify after Answer delivery and close recovery gaps

**What to build**

Release one lightweight durable mention only after the Answer revision with
Human Review components is delivered, recover it idempotently across restart,
preserve runtime-blocked isolation, and document the final behavior.

**Spec references**

- SCN-2, SCN-3, SCN-6, and SCN-7.
- INV-2, INV-5, INV-6, and INV-7.
- Implementation Decisions: publication order, outbox failure behavior,
  compatibility, and observability.

**Ownership and implementation path**

- Reuse `completion_notification_obligations.notification_reply_id` as the
  durable link to the lightweight notification. Do not add a new review table.
- On exact Primary or Worker Answer checkpoint, reserve one immutable text
  reply with a deterministic owner/generation idempotency key and the safe
  persisted mention actor. Ensure no notification is reserved for `none`, an
  unavailable action set, stale identity, missing target, or pre-component
  Answer revision.
- Extend startup/periodic convergence to repair the same missing notification
  from durable Answer/action-set evidence. Retry only the outbox effect and
  never repeat Agent work.
- Add bounded structured logs for Skill outcome, action-set availability,
  Ignore, notification reservation/delivery failure, and recovery; exclude full
  Prompt, protocol, option message, and unredacted user text.
- Keep Primary/Worker `runtime_blocked` Human Review code and cards unchanged.
- Update `docs/architecture.md` and `docs/feishu-group-usage.md` with the v2
  decision, Answer-only components, lightweight mention, Ignore semantics,
  historical compatibility, and local-only approval boundary.

**Acceptance criteria and verification**

- Publisher/convergence tests prove Answer checkpoint precedes mention
  reservation and one deterministic notification survives retry/restart without
  duplicate delivery.
- Primary and Worker tests prove correct thread/owner routing and safe omission
  without a valid mention actor.
- Recovery tests prove stale or permanent notification failures do not mutate
  the action result or replay a Prompt/Turn.
- Existing runtime-blocked tests remain green and expose no new remote action.
- Run all affected publisher, startup convergence, Primary/Worker, outbox,
  SQLite, and documentation-adjacent tests; then `npm run typecheck`,
  `npm run build`, and full `npm test`.

**Blocked by:** T2.

Evidence recorded on 2026-10-07:

- The repository-owned `herdr-choice-list` plugin validates with one
  model-callable Skill and one Stop Hook. The Hook continuation uses the actual
  registered `$herdr-choice-list:herdr-choice-list` capability name; the private
  activation record and eligibility socket are present for the active release.
- Primary and Worker completion notifications are reserved only after the
  Answer component acknowledgement, use deterministic owner/generation keys,
  and recover from durable action-set and Answer evidence without replaying the
  Agent turn.
- The retained HTTP 400 notification came from a historical expired Answer
  target released during the T9 backlog cleanup. Focused failure coverage proves
  a permanent notification rejection leaves the action available and creates
  no additional Prompt or Worker Turn.
- Focused protocol, Hook, plugin wrapper, Primary/Worker interaction, startup
  recovery, Ring, external-turn, and SQLite verification passed 639/639 tests.

## Coverage and dependencies

- T1 owns SCN-1 and the declaration half of SCN-2/SCN-3.
- T2 completes SCN-2 through SCN-5 and preserves SCN-7.
- T3 owns SCN-6 and verifies SCN-7 isolation end to end.
- INV-1 through INV-4 are enforced by T2's existing action-set aggregate.
- INV-5 is enforced and recovered by T3.
- INV-6 begins in T1 and is consumed by T2/T3.
- INV-7 is regression-tested in T2/T3.
- Dependencies are acyclic: T1 -> T2 -> T3.
- No load-bearing design decision or external blocker remains unresolved.

## Final delivery checks

1. Review the complete diff against the approved specification and preserve all
   unrelated user work.
2. Verify three path-scoped atomic commits and absence of the prohibited commit
   trailer.
3. Run affected tests, `npm run typecheck`, and `npm run build`.
4. Run fresh full `npm test` and record exact counts.
5. Inspect source dependency direction and final Git status/diff.
6. Do not install, deploy, restart, push, or open a PR without separate
   authorization.
