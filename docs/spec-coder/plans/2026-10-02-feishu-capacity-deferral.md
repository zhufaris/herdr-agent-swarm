# Feishu Prompt Capacity Deferral Plan

Specification: `docs/spec-coder/specs/2026-10-02-feishu-capacity-deferral.md`

Workspace: isolated worktree `/tmp/herdr-agent-swarm-feishu-capacity-deferral`
on branch `fix/feishu-capacity-deferral`, starting at
`87a8edf5027bb6e612ab59bdfc4e8b8cc79f8ff7`.

Initial-state protection: the original `main` checkout contains a modified
`TODO.md` and unrelated untracked paths. None are present in or owned by this
worktree. The prior unified-session-events worktree is separate and is not a
dependency of this repair.

Baseline:

- `npm ci`: passed; npm reported one existing high-severity advisory.
- Focused Vitest baseline: 4 files and 526 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed with build identity
  `sha256:34c6d4cf67be315cb9d0efe1a61f064f6ecea29f7e1fb1e55c8388e2fd8bd43c`.
- `npm test`: 251 files and 3,593 tests passed.

Approval status: Gate 1 design, Gate 2 specification, and Gate 3 ticket
implementation were approved on 2026-10-02.

## Tickets

### - [x] T1: Defer ordinary Feishu input durably when Prompt capacity is full

| Field | Content |
| --- | --- |
| What to build | Replace the ordinary Feishu Primary queue-full rejection with a typed capacity deferral that keeps the original inbound message durable, preserves same-scope FIFO, lets other scopes proceed, and admits the message exactly once after capacity returns without a separate waiting or rejection card. |
| Spec references | SCN-1 through SCN-5; INV-1 through INV-6; Domain Model, Architecture, Behavior & Failure Modes, and Compatibility & Migration. |
| Ownership and implementation path | The domain owns the typed Prompt-capacity condition and admission result. SQLite Prompt acceptance keeps duplicate-first lookup, generation fences, source-work counting, and atomic no-partial-write enforcement. `PromptAdmissionWorkflow` translates capacity into `capacity_deferred`; `InboundMessageRoutingWorkflow` exposes `deferred`; `DurableInboundPipeline` returns the claimed row to clean `received`, excludes its scope for the pass, continues other scopes, and schedules normal bounded retry without failure telemetry. The inbound store port supplies the focused durable defer operation. Existing composition reuses these interfaces; no schema, second queue, presentation effect, or TraeX path is added. |
| Acceptance criteria and verification | Red-Green tests prove: a full ordinary Feishu source queue creates no rejection card and no partial Prompt/Batch/projection/outbox/cleanup rows; the inbound row stays `received` with `error = NULL`; later same-scope messages do not overtake it; another scope proceeds; capacity release admits the original message once; restart recovery retries without duplicate Prompt admission or TraeX submission; permanent rejection paths and Worker/priority/steering behavior remain unchanged. Run `tests/prompt-admission-workflow.test.ts`, `tests/inbound-message-routing-workflow.test.ts`, `tests/inbound-message-dispatcher.test.ts`, `tests/inbound-message-dispatcher.integration.test.ts`, relevant `tests/sqlite-store.test.ts` cases, `tests/concurrency-controls.integration.test.ts`, `tests/architecture-boundaries.test.ts`, `npm run typecheck`, `npm run build`, then full `npm test`. |
| Blocked by | None |

Implementation evidence:

- Red: `tests/inbound-message-dispatcher.integration.test.ts` observed the old dispatcher
  routing `a-second` after `a-first` returned `deferred` instead of preserving
  same-scope FIFO.
- Green: focused workflow, routing, dispatcher, SQLite, concurrency, and
  architecture suites passed (637 tests); typecheck and build passed with build
  identity `sha256:7dd473a3fbb6f0b2c4d1f89f05ba9849537c3c080ae7c65dbefa1ceb4c75e555`.
- The delivery review and final full-suite/Git audit remain outstanding.

### - [x] T2: Close delivery-review evidence gaps at public workflow seams

| Field | Content |
| --- | --- |
| What to build | Strengthen the approved behavior evidence without changing the production contract: exercise active-Binding capacity release through real SQLite Native Input admission, prove duplicate-first and no-partial-write atomicity for batch/projection/completion-action state, and reopen an interrupted inbound claim through the real routing/admission pipeline. |
| Spec references | SCN-1, SCN-2, SCN-4; INV-2, INV-4, INV-5; Testing Decisions. |
| Ownership and implementation path | Tests use the named SQLite capabilities consumed by `DurableInboundPipeline`, `InboundMessageRoutingWorkflow`, `PromptAdmissionWorkflow`, and `BindingPromptWorkflow`. The SQLite test driver remains setup/inspection-only. No production interface or persistence schema changes. |
| Acceptance criteria and verification | Active Binding tests observe clean durable deferral, later Native Input admission, one execution, parent-fence re-evaluation, and no rejection card. SQLite tests cover duplicate-first at full capacity and rollback of Prompt Input, batch membership, Prompt, Run Card, outbox, and completion-action cleanup. Reopen recovery converts an interrupted `processing` claim to `received`, admits one formed batch, emits one execution wake, and ignores duplicate delivery. |
| Blocked by | T1 |

Delivery-repair evidence:

- Red: the first full-suite delivery run retained three obsolete terminal
  queue-rejection expectations in `tests/steering-integration.test.ts`; all
  three timed out under the approved durable-deferral behavior.
- Green: the seven affected suites passed with 651 tests after replacing those
  expectations and adding SQLite atomicity plus real reopen/routing/admission
  coverage. `npm run typecheck` and `npm run build` passed; build identity
  remained `sha256:7dd473a3fbb6f0b2c4d1f89f05ba9849537c3c080ae7c65dbefa1ceb4c75e555`.

### - [x] T3: Prove capacity waiting and no replay across restart

| Field | Content |
| --- | --- |
| What to build | Close the final Spec-review gap by persisting a real capacity-deferred inbound row, stopping while capacity is still full, reopening the database, releasing capacity, and observing one real Herdr Prompt submission after startup recovery. |
| Spec references | SCN-4; INV-4, INV-5; Testing Decisions. |
| Ownership and implementation path | The first process uses named inbound, routing, admission, Prompt-acceptance, and scheduler capabilities. The reopened integration runtime exercises the existing production-shaped Prompt dispatcher and `HerdrPort.runPrompt` boundary. The routing result variable is named `admission` so its deferred alternative is explicit. |
| Acceptance criteria and verification | Before restart the inbound row is clean `received`, no Prompt Input exists, and no execution wake occurs. After reopen and capacity release the same source identity creates one formed Native Input Batch and exactly one Herdr submission; a duplicate callback creates neither a second Prompt Input nor a second submission. |
| Blocked by | T2 |

Delivery-repair evidence:

- Green: the exact restart regression passed at the public durable-ingress and
  Herdr submission seams; the three affected suites passed with 47 tests.
- `npm run typecheck` and `npm run build` passed with build identity
  `sha256:dc765414d6486e8ae3d9016221c316028eec711854e2fdfba49f8ee170cd3ea1`.

### - [x] T4: Keep delivery regressions on named SQLite capabilities

| Field | Content |
| --- | --- |
| What to build | Repair the final Standards finding without changing production behavior: remove the capacity-deferral forwarding added to the legacy broad SQLite test facade and keep the restart plus capacity-release regressions on named workflow capabilities. |
| Spec references | Architecture; Testing Decisions; SCN-1, SCN-2, SCN-4; INV-4 and INV-5. |
| Ownership and implementation path | `DurableInboundPipeline` receives `inboundDispatch`; routing, Prompt acceptance, Prompt execution, runtime reconciliation, and outbound intent each receive their named store capability. `driver` remains limited to test setup and database inspection. A shared test assembly helper constructs `BindingPromptWorkflow` from those named capabilities without restoring the broad facade. |
| Acceptance criteria and verification | The legacy facade has no `deferInboundMessage` forwarding. Capacity tests prove clean durable deferral, parent-fence re-evaluation, one execution after release, duplicate idempotency, and restart submission through the named public seams. The three affected suites, typecheck, architecture check, docs audit, and build pass. |
| Blocked by | T3 |

Standards-repair evidence:

- Structural check: the restart regression no longer imports `SqliteBindingStore`,
  `createTestRouter`, the test publisher, projector, or `LarkPort`; the legacy
  facade's capacity forwarding is removed.
- Green: the three affected suites passed with 497 tests; typecheck,
  architecture checks, docs audit, and build passed. The test-only repair did
  not change build identity
  `sha256:dc765414d6486e8ae3d9016221c316028eec711854e2fdfba49f8ee170cd3ea1`.

## Dependency Map

```text
T1 (typed capacity result -> durable routing deferral -> retry/recovery)
  -> T2 (delivery-review evidence at atomic persistence and restart seams)
  -> T3 (capacity-deferred restart recovery -> one Herdr submission)
  -> T4 (named-capability delivery regressions -> remove legacy forwarding)
```

The behavior is one consistency-sensitive vertical slice. Splitting domain,
SQLite, routing, and retry changes into separate commits would leave an
intermediate state that either rejects messages, marks them accepted without a
Prompt, or retries capacity as an operational failure.

## Final Delivery Checks

- [x] Every SCN-1 through SCN-5 and INV-1 through INV-6 maps to passing public-seam evidence.
- [x] The Prompt source-work limit remains enforced atomically and no schema migration is introduced.
- [x] Same-scope FIFO, cross-scope progress, duplicate delivery, restart recovery, and no-replay behavior pass.
- [x] Capacity deferral produces no rejection card, inbound error, failure diagnostic, or error-level log.
- [x] Focused tests, architecture checks, typecheck, build, and full test suite pass freshly.
- [x] Dual Standards/Spec review finds no blocking issue.
- [x] Git status/log and commit message are audited; no `Trae CLI co-author attribution` trailer is present.
- [x] No install, restart, deployment, main merge, push, PR, or mutation of unrelated work occurred during feature implementation and verification.
