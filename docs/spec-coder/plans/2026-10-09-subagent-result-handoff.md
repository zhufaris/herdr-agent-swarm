# Subagent Result Handoff Implementation Plan

Specification:
[Subagent Result Handoff](../specs/2026-10-09-subagent-result-handoff.md)

## Workspace, ownership, and baseline

- Swarm workspace: `/tmp/herdr-sqlite-r3`, in-place on `feat/sqlite-r3` at
  starting revision `a2c636c73becb8aed9708001d25bb0388316b409`, after rebase
  onto local `main` `aafafdf077d592cd8901838a557ccfd7d39cafee`.
- Core workspace: `/tmp/herdr-core-result-handoff`, isolated on
  `feat/result-handoff` at starting revision
  `d68122bb784bcc1d950f5e95c06a83189e1ff7e2`. The original Core checkout's
  user-owned `Cargo.lock` and `.trae/` changes remain excluded.
- The Swarm starting worktree was clean. Its only current changes are this
  approved specification and plan. The Core worktree is clean.
- Prepared baseline: Swarm full suite passed 297 files and 4403 tests;
  `npm run typecheck` and `npm run build` passed. Core focused codec baseline
  passed 37 tests with zero failures.
- Gate 1 design, Gate 2 specification, and Gate 3 implementation authorization
  are approved.
- Current session policy prohibits proactive subagent delegation. Both tickets
  therefore use one-ticket, main-local, serial waves even though their
  repository ownership is disjoint.
- Installation, restart, deployment, production SQLite mutation, push, PR
  creation, and edits to the original Core checkout remain unauthorized.

## Ticket dependencies

```text
Wave 1: RH1 Core emits the result-handoff fact
                    |
                    v
Wave 2: RH2 Swarm projects and renders the fact
                    |
                    v
          Cross-repository delivery review
```

The arrow is the selected integration order, not a hidden compile-time
dependency: both tickets implement the already approved wire contract and can
be tested independently. Serial execution keeps one active main-local wave and
makes the provider contract available for final consumer verification.

## Tickets

### - [x] RH1: Emit an identity-stable Core result-handoff fact

| Field | Plan |
| --- | --- |
| What to build | Extend Core's typed `agent_activity` reply payload with optional `result_handoff = "delivered_to_parent"`. Emit it only for a successful, normalized-completed `collab_close_end`; omit it from ordinary lifecycle completion and every unsuccessful/incomplete close outcome. Preserve the existing event key and event ID. |
| Spec references | SCN-1 through SCN-4; INV-1, INV-2; ARCH-1, ARCH-2; Behavior & Failure Modes; Compatibility & Migration. |
| Dependencies | None. The approved specification is the wire-contract authority. |
| Delegation eligibility | Eligible in principle: bounded Rust schema/codec behavior in an isolated worktree with public codec, schema, journal, and recovery seams; no credential or production authority is needed. |
| Delegation mode | Main-local because the current session explicitly prohibits proactive subagent delegation. |
| Ownership and implementation path | Core schema owns the optional typed fact. The TraeX codec decides it at the `collab_close_end` source boundary and passes it through the activity constructor. Journal persistence and recovery retain their existing key/event-ID rules; no migration or row rewrite is added. |
| Mutation ownership | In `/tmp/herdr-core-result-handoff`: `src/api/schema/agent_events.rs`, `src/api/schema/tests.rs`, `src/agent_events/codec.rs`, and narrowly required `src/agent_events/journal.rs` tests only. |
| Exclusions | Original Core checkout, `Cargo.lock`, `.trae/`, JSONL producer format, journal schema, event schema version, activity key version, unrelated agent events, installation, and deployment. |
| Isolation | Existing isolated Core Git worktree. One main-local serial wave. |
| Concurrency conflicts | No file overlap with RH2, but main-local execution cannot overlap another mutation wave. Any change to event identity semantics would reopen Gate 2 rather than being absorbed here. |
| Verification seam | Start with failing codec/schema tests for exact emission and omission. Add an explicit pre-change `agent-v3` key/event-ID compatibility assertion and retain live/retry/recovery identity equality. Run focused Rust tests, then the full applicable Core suite before delivery. |
| Host capacity | One local execution slot. No child is started under the current policy. |
| Direct-child boundary | If delegation is explicitly authorized later, the child brief must state `delegation_allowed = false`; the child cannot spawn, stage, commit, deploy, or touch excluded files. |
| Acceptance criteria and verification | Successful close serializes `state: "completed"` plus the exact optional handoff value; ordinary completed activity and failed/interrupted/blocked/running/started close paths omit it; old payloads deserialize; the same raw successful-close fixture retains its prior key/event ID; focused schema/codec/journal tests and formatting/checks pass. |
| Blocked by | None. |

Suggested atomic commit:
`feat(agent-events): report subagent result handoff`

### - [x] RH2: Render returned Subagent results in Session Activity

| Field | Plan |
| --- | --- |
| What to build | Carry the approved optional handoff value through Swarm's external and persisted Core-event codecs, canonical projections, and SQLite Session Activity reducer. Render the exact handoff as `returned to main`; preserve `completed` for legacy and ordinary lifecycle events. |
| Spec references | SCN-1 through SCN-4; INV-1, INV-2; ARCH-3, ARCH-4; Behavior & Failure Modes; Compatibility & Migration. |
| Dependencies | None for implementation because the approved protocol is fixed. RH1 is executed first so final integration review can compare the concrete producer and consumer. |
| Delegation eligibility | Eligible in principle: bounded TypeScript event/projection/rendering behavior with existing protocol, projector, temporary-SQLite, and pure CardKit seams; no live Feishu credential is required. |
| Delegation mode | Main-local because the current session explicitly prohibits proactive subagent delegation. |
| Ownership and implementation path | The adapter and persisted codec validate/translate the wire fact into the internal event contract. Canonical event projection preserves it. Session Activity alone translates it into the display state, persists through the existing item upsert, and reserves the Main Card through the existing durable projection path. The renderer remains presentation-only. |
| Mutation ownership | `src/domain/herdr-events.ts`, `src/adapters/herdr-events-adapter.ts`, `src/runtime/herdr-events/event-codec.ts`, `src/runtime/herdr-events/event-projector.ts` only if required to preserve the fact, `src/store/sqlite/session-activity-store.ts`, and focused `tests/herdr-events-protocol.test.ts`, `tests/herdr-event-projector.test.ts`, `tests/session-activity-store.test.ts`, `tests/run-card.test.ts`. This specification and plan are also owned by the final Swarm ticket commit. |
| Exclusions | SQLite schema/migrations, inference from lifecycle/content, Answer timeline redesign, agent orchestration, event ordering/rings, outbox semantics, frozen pages, production data, and deployment. |
| Isolation | Existing Swarm worktree, serial and main-local. It begins after RH1's accepted commit but does not mutate the Core worktree. |
| Concurrency conflicts | No cross-repository file overlap with RH1. Within Swarm, codec, projector, store, and card tests belong to one coherent slice and must not overlap another local mutation wave. |
| Verification seam | First add failing protocol round-trip/legacy tests and Session Activity behavior tests. Prove the exact mapping, legacy fallback, duplicate idempotency, stable agent identity, durable Main Card reservation, and final CardKit text. Run affected Vitest files, typecheck, architecture check, build, then full Swarm suite. |
| Host capacity | One local execution slot. No child is started under the current policy. |
| Direct-child boundary | If delegation is explicitly authorized later, the child brief must state `delegation_allowed = false`; the child cannot spawn, stage, commit, deploy, or touch excluded files. |
| Acceptance criteria and verification | Exact valid wire value round-trips to `resultHandoff`; unknown values fail closed; old payloads remain valid; only the exact fact stores/renders `returned to main`; ordinary completion remains `completed`; duplicate/restart projection remains idempotent; affected tests, typecheck, architecture check, build, and full suite pass. |
| Blocked by | None. |

Suggested atomic commit:
`feat(session-activity): show returned subagent results`

## Coverage check

| Requirement | Responsible ticket(s) |
| --- | --- |
| SCN-1 successful handoff | RH1 producer, RH2 consumer |
| SCN-2 completion without evidence | RH1 omission, RH2 legacy fallback |
| SCN-3 unsuccessful/incomplete close | RH1 omission, RH2 lifecycle rendering |
| SCN-4 retry/restart/recovery identity | RH1 identity compatibility, RH2 idempotent projection |
| INV-1 valid fact/source/state combination | RH1, RH2 validation |
| INV-2 absence never implies handoff | RH1, RH2 |
| ARCH-1 and ARCH-2 | RH1 |
| ARCH-3 and ARCH-4 | RH2 |

Every in-scope scenario, invariant, architecture decision, compatibility rule,
and public verification seam has a responsible ticket. Neither ticket has an
unresolved load-bearing decision or a functional blocker.

## Final delivery checks

After both ticket commits:

1. compare Core's serialized contract with Swarm's accepted contract and prove
   the exact snake/camel-case translation;
2. review that no path infers handoff from lifecycle state or result content;
3. review Core event keys/event IDs and Swarm stable agent item identity for
   live, duplicate, restart, and exact-turn recovery;
4. run Core formatting/checks and full applicable tests;
5. run Swarm affected tests, `npm test`, `npm run typecheck`, `npm run
   architecture:check`, `npm run build`, and `git diff --check`;
6. perform findings-first Standards and Specification reviews in both
   repositories and route material repairs through the owning ticket;
7. inspect both atomic commits and their messages. Do not install, restart,
   deploy, push, open a PR, or mutate production data without separate
   authorization.
