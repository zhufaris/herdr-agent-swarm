# Answer Stream Update Coalescing

## Problem Statement

Primary Answer projection currently classifies every nonterminal answer growth of at least 80 characters as a `terminal` CardKit update. `terminal` bypasses the configured debounce and can immediately flush again after an in-flight request. Normal model output commonly crosses this threshold, so cumulative card snapshots can be sent at network-round-trip speed. Production evidence on 2026-10-05 included 27 CardKit dead letters with provider code `300317` (`sequence number compare failed`).

The durable view and outbox remain authoritative; this change concerns only process-local convergence scheduling.

## Solution

Reserve immediate `terminal` scheduling for the first visible Answer content and actual terminal lifecycle phases (`blocked`, `completed`, `failed`). Classify a nonterminal answer delta of at least 80 characters as `interactive` with the existing bounded 120 ms delay. Tool-progress and timeline updates continue to use the same interactive path; smaller ordinary deltas retain the configured Answer debounce.

This preserves first-paint and completion latency while allowing intermediate cumulative snapshots to coalesce before CardKit delivery.

## User Stories

- **S1 — First visibility:** when the first non-empty Answer content is projected, the user sees it without a debounce delay.
- **S2 — Streaming coalescence:** when an active Answer grows by at least 80 characters, the durable view updates immediately but CardKit convergence waits for the 120 ms interactive window and coalesces newer revisions.
- **S3 — Terminal visibility:** when an Answer becomes blocked, completed, or failed, convergence begins immediately even if an intermediate update is pending.
- **S4 — Ordinary cadence:** smaller content deltas continue to use the configured Answer update interval, capped by the existing 1.5 second visibility budget.

## Implementation Decisions

### Domain Model

The affected context is Delivery Projection. SQLite `RunCardView` remains the durable source of the desired Answer revision. `CardUpdateScheduler` remains a process-local convergence hint and never becomes workflow authority. Priority is a latency policy: `terminal` means user-visible lifecycle finality or first-paint necessity, not content size.

The projector owns classification because it has both lifecycle phase and projection-delta context. The scheduler owns serialization, coalescing, and retry behavior and does not infer lifecycle semantics.

### Architecture

`ConversationViewProjector.saveAndScheduleRunCard()` classifies the next revision from the latest projected content length, including revisions that arrive while a prior CardKit request is in flight. Reuse the existing `interactive` priority and `answerInteractiveDelayMs`; do not add a new timer, queue, persistence field, or adapter behavior.

`CardUpdateScheduler` separates the priority and deadline captured by the in-flight flush from the policy accumulated for a newer desired version. After the current request settles, only a newly terminal revision flushes immediately; a newer nonterminal revision observes its requested interactive or normal deadline. Durable view writes still happen before scheduling, and convergence reloads the latest durable view.

Alternatives rejected for this slice:

- a global scheduler minimum interval, because it would delay first paint and true terminal transitions across all card families;
- adaptive byte/RTT thresholds, because they add state and tuning before the direct misclassification is corrected.

### Behavior & Failure Modes

Multiple nonterminal revisions inside the interactive window converge to the highest desired version, including when the window overlaps a prior in-flight request. A true terminal revision promotes an existing pending item and flushes immediately after any ordered in-flight request settles. Process loss remains safe because durable projection/outbox recovery is unchanged. Delivery retries do not repeat Agent Input.

### Compatibility & Migration

No schema, configuration, public command, CardKit payload, or stored-state migration is required.

## Testing Decisions

Use `tests/event-card-integration.test.ts` through the lifecycle-event and Answer convergence ports:

- retain the existing immediate first-paint assertion;
- change the 80-character nonterminal case to prove no flush before 120 ms and one flush at 120 ms;
- gate the first-paint network request and prove an update received in flight still honors the 120 ms interactive deadline;
- retain existing terminal and ordinary-debounce coverage.

Run the focused projector/scheduler tests, TypeScript typecheck, build, and the full Vitest suite. Review the task diff separately from pre-existing user files.

## Out of Scope

- final-card payload budgeting;
- Gateway plan/payload crash consistency;
- binding-less dead-letter administration;
- global scheduler rate limiting or adaptive network pacing;
- historical dead-letter repair.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`, in-place because task-owned files do not overlap existing user changes.
- Branch: `main`; starting revision: `d06eaf41d55b1c2a61b7c6cf9dc81d4ab058a3b3`.
- Preserved initial changes: modified `TODO.md`; untracked `docs/research/2026-10-02-session-message-jsonl-dependencies.md`, `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and `handoff.md`.
- Fresh baseline: 37 focused tests passed; `npm run typecheck` passed; `npm run build` passed.
- Approval: the user explicitly authorized the recommended implementation, testing, commit, installation, deployment, and verification without per-step confirmation.
