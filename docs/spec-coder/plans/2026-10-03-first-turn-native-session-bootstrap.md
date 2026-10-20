# First-Turn Native Session Bootstrap Plan

Specification:
[`docs/spec-coder/specs/2026-10-03-first-turn-native-session-bootstrap.md`](../specs/2026-10-03-first-turn-native-session-bootstrap.md)

## Workspace and Approval State

- Gate 1 design: approved by the user on 2026-10-03.
- Gate 2 specification: approved by the user on 2026-10-03.
- Gate 3 implementation authorization: approved by the user on 2026-10-03.
- Workspace mode: in-place across the two repositories below. Target source
  and test files were clean at preflight, and unrelated user-owned changes are
  excluded from every ticket.
- Swarm workspace:
  `/workspace/herdr-agent-swarm`, branch `main`, starting
  revision `70e40230c910310082a1e82c328abe3f5d185ff2`.
- Core workspace: `/workspace/herdr-core`, branch `master`,
  starting revision `1a332fc814058fd48ab76eae15f837dea28b7de9`.
- Swarm baseline: `npm run typecheck`, six focused Vitest files (111 tests) and
  `npm run build` passed.
- Core baseline: current source compiled and `just test-one session_ref` passed
  35 tests using the isolated `/tmp` Cargo target and Zig 0.16.0 toolchain.
- Core broad-suite warning: an additional run passed 504 tests before the
  pre-existing `generated_protocol_schema_artifact_is_current` mismatch stopped
  fail-fast. This plan does not authorize regenerating the unrelated public API
  schema because the approved change adds no public shape.
- Existing Swarm user work remains excluded: modified `TODO.md` and untracked
  `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.

## Tickets

### - [x] T1: Publish existing Pane updates when Core session identity changes

| Field | Content |
| --- | --- |
| What to build | In Herdr Core, preserve `TerminalStateMutation.session_ref_changed` through the internal Pane state update and publish the existing `pane.updated` event for session creation, rotation and clearing. The event continues to carry the current `PaneInfo`; no public enum, payload field, protocol version, capability or RPC is added. |
| Spec references | SCN-3; SCN-5; INV-1; INV-4; INV-5; ARCH-1; Compatibility & Migration. |
| Ownership and implementation path | Terminal Runtime remains authoritative for session-change detection. Extend the internal `PaneStateUpdate` in `src/app/actions.rs` with the session-change cause, populate all construction paths conservatively, and let `src/app/api.rs` call the existing `emit_pane_updated` when Agent name or session identity changed. Keep Agent detected/status event predicates unchanged. Boundary data remains the existing public `PaneInfo`. |
| Acceptance criteria and verification | Red: a session-only report with unchanged Agent name/status does not currently emit `pane.updated`. Green: session creation, replacement and clearing each emit the existing event with current session data; unrelated terminal mutation does not add an event; existing Agent status/detected behavior remains green. Run the focused new/existing session and EventHub tests, `just test-one session_ref`, formatting and applicable Core lint/check recipes with the isolated target/Zig environment. Confirm the generated public schema is unchanged. Recheck the broad-suite baseline warning without modifying unrelated schema output. |
| Blocked by | None. |

Delivery boundary: a Core runtime consumer can receive a compatible immediate
Pane snapshot hint whenever the real TraeX session identity changes. Commit
only T1-owned Core source/tests as one Conventional Commit.

### - [x] T2: Bootstrap a settled sessionless Native Input Batch without pre-wait

| Field | Content |
| --- | --- |
| What to build | In Swarm, allow the FIFO-head Native Input Batch to use the existing observed `runPrompt` path when a fresh compatible Pane is settled (`idle` or `done`), has no exact native session and has no model override. Skip the three-second pre-dispatch session-identity grace only for this explicit bootstrap, then adopt the exact identity through attached post-dispatch observation and existing first-turn recovery. |
| Spec references | SCN-1; SCN-2; SCN-6; INV-1; INV-2; INV-3; ARCH-3; ARCH-4; Behavior & Failure Modes. |
| Ownership and implementation path | `PrimaryPromptDispatcher` owns bootstrap eligibility after fresh runtime observation. Exact-session batches retain the native Core queue; eligible missing-session batches fall through to `PromptTurnExecutor`. The executor/transcript seam receives only the minimum explicit bootstrap policy needed to avoid pre-wait while preserving ordinary non-batch acquisition behavior. Existing Binding generation, Pane, terminal, execution-slot, `confirmDispatched`, durable submission identity, detach and no-replay paths remain authoritative. No store schema or public adapter method is added. |
| Acceptance criteria and verification | Red: replace the regression assertion that a settled sessionless Native Input Batch is always deferred, and prove current execution waits/does not submit. Green: `idle` and `done` sessionless batches call the observed executor promptly; `working`, `blocked`, model-aware, incompatible/stale identity and an occupied ordinary slot make no external submission; ordinary non-batch first-turn grace remains unchanged; attached observation adopts the post-dispatch exact session. A proven pre-dispatch failure requeues the same FIFO head, while accepted/prepared/uncertain delivery detaches without replay. Run `tests/primary-prompt-dispatcher.test.ts`, `tests/prompt-turn-executor.test.ts`, `tests/transcript-observer.test.ts`, `tests/transcript-observer-identity.test.ts`, `npm run typecheck` and `npm run build`. |
| Blocked by | None. Updated Swarm remains correct with an older Core through attached polling and periodic reconciliation. |

Delivery boundary: the original Feishu message can create the TraeX session
without weakening active-turn native-queue fences. Commit only T2-owned Swarm
source/tests as one Conventional Commit.

### - [x] T3: Converge session-change hints at Pane scope and wake the exact FIFO

| Field | Content |
| --- | --- |
| What to build | In Swarm, normalize `pane.updated` events carrying Pane IDs as Pane-scoped reconciliation hints. During runtime convergence, treat a proven `missing -> exact` native session adoption as a runtime change even when Agent state remains `idle`, and wake pending Prompt work only for the active, non-busy exact Binding. |
| Spec references | SCN-4; SCN-5; INV-2; INV-4; INV-5; ARCH-2; ARCH-5; Behavior & Failure Modes; Compatibility & Migration. |
| Ownership and implementation path | `src/runtime/herdr-event-hint.ts` owns external event-name/ID normalization and retains workspace/all fallback when a Pane ID is absent. `BindingRuntimeConverger` compares the pre-observation identity with the store's fenced transition result. The existing store remains atomic authority; `SessionReconciler` remains the only convergence path; `PromptWorkScheduler` receives only idempotent wake hints. Busy bootstrap execution continues through attached observation and normal `control-ready` completion rather than opening a second ordinary slot. |
| Acceptance criteria and verification | Red: `pane.updated` with a Pane ID currently selects wider workspace scope, and a `null -> exact` session with unchanged `idle` state currently does not wake queued work. Green: the event is Pane-scoped; missing IDs keep current fallback; one exact non-busy Binding with pending work receives `prompt-ready`; another Pane is untouched; unchanged identity, stale generation, terminal identity change, native-session mismatch and rotation-pending outcomes do not trigger the new wake; a busy Binding never begins a second ordinary turn; duplicate hints remain harmless. Run `tests/herdr-socket-subscriber.test.ts`, `tests/herdr-runtime-reconciler.test.ts`, relevant scheduler/architecture tests, `npm run typecheck` and `npm run build`. |
| Blocked by | None for implementation and tests. T1 supplies the low-latency production hint, while existing periodic reconciliation keeps T3 independently valid with an older Core. |

Delivery boundary: a Core session update converges only the named Pane and can
promptly resume its eligible FIFO without relying on an Agent-state edge.
Commit only T3-owned Swarm source/tests as one Conventional Commit.

### - [x] T4: Preserve sessionless bootstrap behavior with an older Core

| Field | Content |
| --- | --- |
| What to build | Delivery-review repair: when Core does not advertise the native prompt queue, an eligible Native Input Batch whose live Pane and durable Binding both lack an exact native session still uses the observed executor without the three-second transcript identity grace. A Binding that already has an exact native session retains the normal first-turn transcript grace even if an older Pane snapshot omits it. |
| Spec references | SCN-1; SCN-5; INV-1; INV-2; ARCH-4; Compatibility & Migration. |
| Ownership and implementation path | Keep bootstrap eligibility in `PrimaryPromptDispatcher`; reuse the existing durable native-session classifier and pass the same narrow transcript acquisition policy to `PromptTurnExecutor`. Do not weaken the fresh exact-session fence for native Core queue submission. |
| Acceptance criteria and verification | Red: prove an old-Core sessionless batch reaches the executor without the bootstrap policy. Green: both old- and new-Core sessionless batch paths pass the policy; a durable exact session retains delayed transcript acquisition; the existing post-dispatch identity-adoption integration remains green. Run the five T2-focused test files, `npm run typecheck`, and `npm run build`. |
| Blocked by | None. This repair was identified by the final specification review after T1-T3. |

Delivery boundary: new Swarm preserves the approved no-lockstep-deployment
behavior without misclassifying a durable exact session as sessionless. Commit
only T4-owned Swarm source/tests as one Conventional Commit.

## Final Delivery Checks

- [x] Re-read the approved specification and map SCN-1 through SCN-6 and INV-1
  through INV-5 to passing test evidence from T1-T4.
- [x] Inspect both repositories for unrelated, staged or overlapping changes;
  stage and commit only explicit ticket-owned paths.
- [x] In Swarm, run all affected Vitest files, `npm run typecheck`,
  `npm run build`, then serial `npm test`.
- [x] In Core, run focused session/EventHub tests, `just test-one session_ref`,
  formatting and applicable `just` checks with Zig 0.16.0 and the isolated
  target. Re-run the broad suite with Herdr Pane variables removed and report
  the exact generated-schema baseline result; do not regenerate unrelated
  output without a reopened authorization.
- [x] Confirm Core public event/schema artifacts have no diff and no database,
  wire, capability or protocol migration was introduced.
- [x] Review source dependency direction: terminal mutation -> Core application
  update -> API EventHub, and Swarm adapter normalization -> reconciler ->
  fenced store/scheduler. Confirm no Lark or transport type enters the policy.
- [x] Inspect each new commit body and ensure it contains no
  `Trae CLI co-author attribution` trailer.
- [x] Do not install, restart, deploy, push or open a pull request without
  separate explicit authorization.

### Final Verification Evidence

- Swarm: serial `npm test` passed 254 files and 3,711 tests; fresh
  `npm run typecheck` and `npm run build` both passed.
- Core focused checks: `just test-one agent_session` passed 24 tests,
  `just test-one session_ref` passed 35 tests, and `just lint` passed formatting
  and Clippy.
- Core broad suite: with all inherited `HERDR_*` variables removed, 525 tests
  passed before fail-fast stopped at the pre-existing
  `api::schema::tests::generated_protocol_schema_artifact_is_current` baseline
  mismatch. The task adds no public shape, and no generated schema artifact was
  changed or regenerated.
- Final review: specification and repository-standards axes have no blocking
  findings. The duplicated four-field session-presence construction in
  `BindingRuntimeConverger` remains a low-risk, nonblocking refactor candidate.
- Scope audit: Core changed only `src/app/actions.rs` and `src/app/api.rs`;
  Swarm changed only the explicit T2-T4 implementation, test, architecture,
  specification and plan paths. Pre-existing user-owned Swarm changes remain
  excluded.

## Coverage Check

| Approved behavior | Responsible ticket |
| --- | --- |
| SCN-1 settled first-turn bootstrap | T2 |
| SCN-2 unsafe sessionless refusal | T2 |
| SCN-3 compatible Core session-change hint | T1 |
| SCN-4 unchanged-idle identity convergence and FIFO wake | T3 |
| SCN-5 duplicate/missing hint recovery | T1, T3 |
| SCN-6 uncertain delivery detaches without replay | T2 |
| INV-1 runtime-owned exact identity | T1, T2 |
| INV-2 one ordinary execution and FIFO | T2, T3 |
| INV-3 no replay after possible delivery | T2 |
| INV-4 hints are non-authoritative | T1, T3 |
| INV-5 public Core compatibility | T1, T3 |

There are no unresolved load-bearing design decisions and no cyclic ticket
dependencies. T1-T3 are independently testable; the recommended execution
order is T1, T2, T3 so the production event producer exists before final
cross-repository verification.
