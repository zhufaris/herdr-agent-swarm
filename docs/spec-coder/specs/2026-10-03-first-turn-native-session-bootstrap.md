# First-Turn Native Session Bootstrap

## Problem Statement

An ordinary Feishu message admitted as a **Native Input Batch** can remain queued
when its bound TraeX Pane has not yet reported a native Agent session identity.
The current `PrimaryPromptDispatcher` rejects every Native Input Batch whose
fresh runtime observation lacks an exact session ID, including the settled
first turn that must create that session. TraeX may report its native session
only after receiving the first prompt, so the dispatcher and runtime can wait
on each other until an unrelated Herdr turn creates the identity.

This is a regression from the approved Native Input Batching contract, which
requires the existing settled first-session bootstrap path to remain available.
It is not an ingress-loss problem: the Feishu input has already been persisted,
remains FIFO queued and has not been submitted. The incident is observable as
`prompt-native-queue-identity-unavailable` with outcome
`requeued_before_dispatch`.

After TraeX does create or rotate a session, Herdr Core currently persists the
change through `TerminalStateMutation.session_ref_changed`, but that fact is
dropped while constructing `PaneStateUpdate`. Consequently, Core does not emit
an existing `pane.updated` hint unless another visible property such as Agent
name also changes. Swarm eventually converges through polling or another event,
but an unchanged `idle` Agent state does not itself wake queued Prompt work.

## Solution

Restore the existing observed first-turn execution path for a sessionless
Native Input Batch only when a fresh Pane observation proves a settled,
non-model, non-busy runtime. The first Prompt is sent through the existing
`runPrompt` path, which can cause TraeX to create its native session. The
attached transcript observer then adopts the exact identity after dispatch.
The pre-dispatch three-second identity grace is skipped for this explicit
bootstrap case because waiting cannot create the missing identity.

Propagate Herdr Core's existing internal `session_ref_changed` fact into
`PaneStateUpdate` and emit the already-public `pane.updated` event when either
the Agent name or session identity changes. The event continues to carry the
existing full `PaneInfo`; no event kind, wire field, protocol version or RPC is
added.

Swarm treats a `pane.updated` hint containing a Pane ID as Pane-scoped,
reconciles the authoritative snapshot, persists an exact newly available
session under the existing Binding fences, and wakes queued work when
`missing -> exact` occurs while no ordinary turn is active. Socket events remain
lossy wake hints; periodic snapshot reconciliation and attached observation
remain the recovery paths.

The change spans two repositories but has no lockstep deployment requirement.
Updated Swarm still bootstraps and polls when used with an older Core. Updated
Core's additional compatible `pane.updated` event is safe for older consumers.
Installation, service restart and production deployment remain separately
authorized operations.

## User Stories

### SCN-1: Settled first Native Input Batch bootstraps TraeX

As a Feishu user, when my bound TraeX Pane is `idle` or `done`, has no exact
native session yet, has no model override and has no ordinary turn in flight,
my already-durable Native Input Batch is submitted immediately through the
observed first-turn path. It does not wait three seconds for an identity that
can only be created by that prompt.

### SCN-2: Unsafe sessionless runtime remains closed

As an operator, when the exact session is missing and the fresh Pane is
`working`, `blocked`, incompatible, stale, or model-aware, Swarm does not use
the bootstrap exception. Work that was not submitted is released back to the
same FIFO under the existing pre-dispatch outcome; no generation, Pane,
terminal or session fence is weakened.

### SCN-3: Core publishes an existing compatible identity-change hint

As a runtime consumer, when a Pane's reported Agent session is created,
rotated, or cleared, I receive the existing `pane.updated` event containing
fresh `PaneInfo`, even if the Agent name and status are unchanged. Unrelated
terminal mutations do not gain an extra Pane update.

### SCN-4: Swarm converges newly available identity without an Agent-state edge

As a Feishu user with queued work, when reconciliation changes the Binding's
session from missing to exact while Agent state stays `idle`, Swarm persists the
identity and wakes that Binding's FIFO. An update for another Pane cannot wake
or mutate this Binding.

### SCN-5: Duplicate or missing hints remain safe

As an operator, duplicate `pane.updated` hints cause only idempotent
reconciliation and scheduler wake attempts. A lost hint is repaired by attached
post-dispatch identity adoption or the existing periodic snapshot scan; Lark
state never becomes runtime authority.

### SCN-6: Possible delivery is never replayed

As an operator, if the first-turn submission may have reached TraeX but its
receipt, waiter or transcript becomes uncertain, the Prompt is detached and
observed. It is never released to automatic replay. Only failure proven before
dispatch can return the Prompt to the FIFO.

## Implementation Decisions

### Domain Model

The affected bounded contexts are **Prompt Execution** and **Primary Session**
inside Swarm, plus Herdr Core's **Terminal Runtime** publication boundary.
**Conversation Projection** and **Delivery and Operations** are unaffected
consumers: they continue deriving cards and outbox work from persisted Prompt
lifecycle state and do not decide whether bootstrap is allowed.

The existing canonical terms remain authoritative:

- **Native Input Batch** is the one durable ordinary execution owner formed
  from one or more Feishu Prompt Inputs. Its existing two-second collection
  window and shared Prompt/submission identity are unchanged.
- **Settled Session Bootstrap** is the existing first-turn path that submits to
  a compatible `idle` or `done` Pane before a native session exists. It is not a
  native queue submission and therefore does not relax the exact-session rule
  for queuing work behind an active turn.
- **Runtime Observation** is authoritative live Pane data read from Herdr and
  applied under Binding generation, Pane and terminal identity fences.
- **Runtime Hint** is a bounded, lossy notification that requests
  reconciliation; it is not workflow or session state.
- **Dispatch Evidence** distinguishes definitely not dispatched work from a
  submission that was accepted or may have crossed the runtime boundary.

No new entity, aggregate, value object, repository or persisted value is
introduced. Existing `Binding`, Native Input Batch and Prompt lifecycle
boundaries remain intact.

#### INV-1: Native session identity remains runtime-owned

TraeX creates the native session and Herdr Core reports it. Swarm may persist an
exact observed identity but must not fabricate, predict or derive one from
Feishu, Prompt or transcript text.

#### INV-2: One ordinary execution and strict FIFO remain enforced

The bootstrap exception changes only identity eligibility for the already
claimed FIFO head. Existing Binding scheduling and durable claim ownership
continue to permit at most one ordinary turn. No later batch may bypass the
head or use a session-change hint to start concurrently.

#### INV-3: Possible delivery is never replayed

The current durable submission identity and `confirmDispatched` boundary remain
authoritative. A definitely pre-dispatch rejection may requeue the same Prompt;
accepted, prepared or uncertain delivery detaches and must be observed without
automatic replay.

#### INV-4: Runtime hints cannot mutate workflow directly

`pane.updated` only selects a bounded reconciliation target. A fresh snapshot
and the store's existing conditional Binding transition decide whether the
session can be adopted. Duplicate, stale, reordered or missing hints cannot
override SQLite or Herdr authority.

#### INV-5: Public Core compatibility is preserved

The stable event remains `pane.updated` with the existing `PaneInfo`. Session
change is an internal cause for publishing that event, not a new public field,
event enum or protocol capability.

### Architecture

#### ARCH-1: Core carries the internal mutation fact to event publication

Herdr Core's terminal state owns session-change detection. The application
state update carries `session_ref_changed` as an internal
`PaneStateUpdate.agent_session_changed` boolean. The API publication layer calls
the existing `emit_pane_updated` operation when
`agent_name_changed || agent_session_changed`. Existing Agent detected/status
event predicates remain unchanged.

The source dependency stays internal to Core:

```text
terminal mutation -> application PaneStateUpdate -> API EventHub
```

The only crossing data is the already-defined public `PaneInfo` snapshot built
by `emit_pane_updated`.

#### ARCH-2: Event normalization retains the narrowest available scope

Swarm's socket adapter continues normalizing external event names and IDs.
`pane.updated` with at least one Pane ID produces a Pane-scoped runtime hint;
when no Pane ID is available, existing workspace/all fallback remains. The
`SessionReconciler` remains the single event-driven and periodic convergence
path.

#### ARCH-3: Dispatcher owns bootstrap eligibility

`PrimaryPromptDispatcher` evaluates a fresh Pane before external submission.
Missing session identity no longer rejects a Native Input Batch by itself.
Bootstrap is eligible only when there is no model override and the observed
runtime is settled (`idle` or `done`), compatible and still covered by the
current Binding/Pane/terminal/generation claim. Existing busy, blocked, model
and mismatch decisions remain fail-closed.

An exact session continues to select the native Core queue path. A missing
session on an eligible bootstrap selects the existing observed `runPrompt`
path. This makes the distinction explicit: active-turn native queuing requires
an exact session; settled first-turn bootstrap creates the opportunity for
TraeX to report one.

#### ARCH-4: Transcript observation adopts identity after bootstrap dispatch

`PromptTurnExecutor` keeps the existing dispatch confirmation, waiter,
attached observer, first-turn recovery and detached-observation seams. For a
sessionless Native Input Batch bootstrap, transcript acquisition opens the
currently available source once and does not spend the three-second
pre-dispatch grace waiting for session identity. `observeAttached` continues
polling after dispatch and upgrades to the exact session/turn through the
existing fenced identity-adoption callback.

The ordinary non-batch path retains its current first-turn identity grace. No
global timeout or polling interval is changed.

#### ARCH-5: Runtime convergence wakes only a proven eligible Binding

`BindingRuntimeConverger` records the prior exact session value before applying
the fresh Pane observation and compares it with the transition result. A proven
`missing -> exact` transition is a runtime change even when Agent state is
unchanged. When the Binding is active, not busy and has pending work, the
converger wakes `prompt-ready`; existing `control-ready` completion handles work
queued behind an active bootstrap turn.

Stale Binding results, pending rotation, terminal identity changes and native
session mismatches do not trigger the new prompt wake. The durable store remains
the atomic authority for identity adoption; scheduler wakes are idempotent
process-local hints.

### Behavior & Failure Modes

- A sessionless settled Native Input Batch reaches `runPrompt` immediately and
  marks dispatch only through the existing acceptance callback.
- A sessionless busy, blocked or model-aware batch is not submitted. Its claim
  is released only while dispatch is proven not to have started.
- Core publishes `pane.updated` for session creation, replacement and clearing;
  consumers may receive duplicates or observe the resulting snapshot through a
  later periodic scan.
- A Pane-scoped hint reconciles only bindings for the named Pane. Missing IDs
  fall back to the current wider scope rather than dropping recovery.
- If the new identity arrives while the bootstrap turn is busy, attached
  observation owns the current turn and the normal completion wake owns the
  next FIFO item. The identity event cannot create a second active turn.
- If an event arrives before, during or after store adoption, conditional
  identity fences and idempotent scheduling yield the same persisted result.
- If dispatch, waiter or transcript outcome is uncertain after possible
  delivery, existing detached recovery owns convergence and no replay occurs.
- Card publication and Lark delivery remain downstream of durable lifecycle
  transitions and cannot cause prompt dispatch.

### Compatibility & Migration

There is no SQLite migration and no historical data rewrite. Existing Binding,
Prompt, Native Input Batch, Run/Answer and outbox records keep their meanings.
No glossary term requires renaming.

Core's `PaneStateUpdate` change is internal Rust data flow. The public event
codec, `EventKind`, `PaneInfo`, subscription method and protocol schema remain
byte-compatible. Therefore the generated API schema is not expected to change.

The repositories may be built and released independently:

- new Swarm + old Core: first-turn bootstrap works; post-dispatch polling and
  periodic reconciliation recover identity;
- old Swarm + new Core: the extra compatible `pane.updated` hint is harmless;
- new Swarm + new Core: the same behavior gains Pane-scoped low-latency
  convergence.

## Testing Decisions

- Core application/API tests first demonstrate that a session-only mutation
  currently produces no `pane.updated`, then prove creation, rotation and
  clearing each publish the existing event with current `PaneInfo`.
- Core preservation tests prove unrelated terminal mutations do not add an
  event and Agent detected/status predicates retain their existing behavior.
- Swarm event-normalization tests prove `pane.updated` with Pane IDs is
  Pane-scoped and missing Pane IDs retain workspace/all fallback.
- Swarm dispatcher tests prove `idle` and `done` sessionless Native Input
  Batches enter the observed executor, while `working`, `blocked`, model-aware,
  stale and mismatched cases make no external submission.
- Executor/transcript tests use the existing fake Herdr and fake transcript
  seams to prove an eligible bootstrap does not consume the three-second
  pre-dispatch grace, marks dispatch at the established boundary, and adopts an
  exact identity after dispatch.
- Runtime reconciliation tests prove `missing -> exact` wakes a non-busy FIFO
  without an Agent-state change, and prove unchanged identity, mismatch,
  pending rotation, stale generation and busy execution cannot start an extra
  ordinary turn.
- Failure tests preserve the distinction between pre-dispatch requeue and
  post-dispatch detach/no-replay.
- Each Swarm ticket runs affected Vitest files, `npm run typecheck` and
  `npm run build`; delivery runs serial `npm test`.
- The Core ticket runs focused event/session tests, formatting and applicable
  `just` verification with the required Zig 0.16 toolchain. The broad baseline
  generated-schema failure recorded below must be rechecked; this change must
  not update the schema because no public shape changes.

## Out of Scope

- Adding `pane.agent_session_changed` or any other public event kind.
- Adding `agent_prompt_bootstrap_v1` or another Core prompt RPC.
- Fabricating a TraeX session ID or adopting identity from terminal text.
- Relaxing exact-session requirements for active-turn native queue submission.
- Changing the two-second Native Input Batch window, FIFO size, queue depth,
  reconcile interval or attached-observer polling interval.
- Changing model selection, steering, Worker execution, card rendering,
  pagination, outbox semantics or Lark retry behavior.
- Remote approval, arbitrary terminal input, process kill or Pane kill.
- Installing, activating, restarting or deploying either service.
- Pushing branches, opening pull requests or publishing tickets externally.

## Further Notes

- Gate 1 design was approved by the user on 2026-10-03.
- Workspace mode: in-place across two repositories. The change is narrow, both
  target source/test sets were clean, no branch switch is needed, and no
  concurrent work overlaps the selected files.
- Swarm workspace:
  `/workspace/herdr-agent-swarm`, branch `main`, starting
  revision `70e40230c910310082a1e82c328abe3f5d185ff2`.
- Existing Swarm changes are user-owned and excluded: modified `TODO.md` plus
  untracked `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`,
  `docs/research/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md` and
  `handoff.md`.
- Core workspace: `/workspace/herdr-core`, branch `master`,
  starting revision `1a332fc814058fd48ab76eae15f837dea28b7de9`; it was clean at preflight.
- Dependencies were already installed for Swarm. Core's repository `target/`
  is read-only in this environment, so verification uses an isolated
  `/tmp/herdr-core-plan-baseline-20261003` Cargo target and Zig cache. Zig
  0.16.0 was downloaded to `/tmp`, and its archive matched the official
  SHA-256 `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`.
- Fresh Swarm baseline on 2026-10-03:
  - `npm run typecheck`: passed;
  - six focused Vitest files: 111 tests passed;
  - `npm run build`: passed, build identity
    `sha256:07b3caee13ac2a285035635b47e761850cbe063d334a6302b2eb40ff704206b5`.
- Fresh Core baseline on 2026-10-03:
  - `just test-one session_ref` with the isolated target/toolchain: 35 tests
    passed;
  - the current source compiled successfully and an additional full run passed
    504 tests before fail-fast stopped at the pre-existing
    `generated_protocol_schema_artifact_is_current` mismatch;
  - the first broad attempt also exposed sandbox `/var/tmp` restrictions and
    inherited `HERDR_AGENT=codex` pollution; rerunning outside the sandbox with
    Herdr Pane variables removed eliminated those failures.
- The generated-schema mismatch is not load-bearing for this design because no
  public schema changes. It remains visible as a broad-suite baseline warning
  and must not be hidden by regenerating unrelated output in this task.
- No unresolved domain or architecture decision blocks ticket decomposition.
