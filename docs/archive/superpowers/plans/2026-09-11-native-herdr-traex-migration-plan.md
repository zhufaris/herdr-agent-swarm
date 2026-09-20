# Native Herdr TraeX Migration Implementation Plan

**Goal:** Finish the Herdr 0.9 native TraeX cutover as a clean break: accept
only exact `herdr:traex` identities, retain legacy rows only as audit data, and
remove all runtime compatibility behavior without weakening prompt or
turn-control fences.

**Architecture:** Runtime identity comparison is exact across source, Agent, kind,
and value. Legacy source strings are not canonicalized, rewritten, recovered, or
controlled. Native Herdr owns Agent lifecycle; the dedicated TraeX adapter owns
model-aware turns. Operational verification reads the configured service endpoint
instead of assuming a fixed port.

**Spec:** `docs/superpowers/specs/2026-09-11-native-herdr-traex-migration-design.md`

## Constraints

- Do not bulk-update or delete legacy SQLite session tuples.
- Do not weaken pane, terminal, generation, session kind, or session value fences.
- Do not replay a prompt after uncertain delivery.
- Do not edit generated `dist/`.
- Do not change the installed service or `HERDR_BIN` before full tests pass.
- Preserve the JSONL transcript reader and periodic reconciliation.

## Task 1: Remove the compatibility identity policy

**Files:**

- Delete: `src/domain/traex-session-identity.ts` if no native-only helper remains
- Delete or rewrite: `tests/traex-session-identity.test.ts`
- Modify: `src/coordinator/pane-runtime-identity.ts`
- Modify: `src/domain/transcript-observer-identity.ts`
- Modify: focused identity tests

- [ ] Add failing tests proving only `herdr:traex` is eligible.
- [ ] Replace semantic alias comparisons with exact tuple comparisons.
- [ ] Remove cache-key canonicalization and legacy-source persistence acceptance.
- [ ] Prove a legacy/native source change invalidates runtime continuity.
- [ ] Run `npx vitest run tests/traex-session-identity.test.ts tests/pane-runtime-identity.test.ts tests/transcript-observer-identity.test.ts`.

## Task 2: Audit reconciliation and model boundaries

**Files:**

- Modify only the runtime comparison sites demonstrated by failing tests.
- Modify: `src/coordinator/model-selection-workflow.ts`
- Modify: relevant reconciler/model tests

- [ ] Locate all Herdr Agent session tuple comparisons and classify them as semantic runtime comparison or exact durable fence.
- [ ] Use exact equality for live Herdr-vs-binding comparison.
- [ ] Keep SQL prompt and turn-control preconditions exact.
- [ ] Accept only `herdr:traex` in model-session eligibility.
- [ ] Add regression tests for rejection of legacy sources and changed UUIDs.
- [ ] Run focused reconciler, model workflow, prompt, and turn-control tests.

## Task 3: Native Herdr setup and doctor capability gate

**Files:**

- Modify: `src/adapters/herdr-setup-probe.ts`
- Modify: `tests/herdr-setup-probe.test.ts`
- Modify setup/doctor documentation where current behavior is described.

- [ ] Add failing tests for Herdr below 0.9.0, malformed version output, missing `traex` kind, non-current/missing integration, and success.
- [ ] Parse `herdr --version`, `herdr agent start --help`, and `herdr integration status` with bounded schemas/patterns.
- [ ] Replace shim remediation with official Herdr update/integration remediation.
- [ ] Keep capability checks observational; never start or prompt an Agent.
- [ ] Run `npx vitest run tests/herdr-setup-probe.test.ts` plus setup/doctor tests.

## Task 4: Repository verification and documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify additional current operator docs found by a reference audit.

- [ ] Document the native/legacy compatibility window and official minimum Herdr version.
- [ ] Keep shim uninstall instructions explicitly gated on successful live cutover.
- [ ] Run `git diff --check`, affected Vitest suites, `npm run typecheck`, `npm run build`, and `npm test`.
- [ ] Commit native-only identity enforcement, setup gate, and documentation as thematic commits.

## Task 5: Real-user smoke endpoint

**Files:**

- Modify: `scripts/real-user-smoke.mjs`
- Add or modify: focused smoke configuration tests

- [ ] Resolve endpoint from explicit `BRIDGE_STATUS_URL`, then private service
  `.env`, then application defaults.
- [ ] Keep the command observational; it must not send a Lark message.
- [ ] Cover explicit URL, configured non-default port, and default fallback.

## Task 6: Controlled live cutover

- [ ] Snapshot native binding generations, exact session values, prompt states, and outbox health.
- [ ] Run `./install.sh` to stage the verified immutable release.
- [ ] Change the private service environment to the official absolute Herdr binary.
- [ ] Restart through `npm run swarm:restart`; do not force past the active-work gate.
- [ ] Verify `/ready`, build identity, native binding generations/session values, expected legacy orphaning, prompt failures, and outbox lanes.
- [ ] Observe one native TraeX pane and confirm `source=herdr:traex` resolves to its exact JSONL thread.
- [ ] Roll back the environment/release if a binding detaches, generation changes, or session values diverge.

Task 6 requires a fresh operational review after Tasks 1-5; it is not implicit in source implementation.

## Task 7: TraeX control extraction and shim retirement

- [ ] Introduce `TraexControlPort` for model listing and model-aware prompt preparation/commit.
- [ ] Move model transport out of the Herdr CLI adapter.
- [ ] Keep steering unsupported unless a separate native TraeX control contract is proven.
- [ ] Delete PATH interception, launcher, reporter, installer scripts, package commands, and shim-only tests after reference and behavior audits.
- [ ] Unlink the installed shim only after the service is verified on official Herdr.
- [ ] Run the full verification suite and a final native smoke test.

## Completion criteria

- [ ] No active source or current operator documentation treats
  `herdr:codex` or `herdr-traex-shim` as a valid TraeX runtime identity.
- [ ] Historical strings remain only in archived material, database contents, or
  explicit negative tests.
- [ ] No shim process or PATH interception remains installed.
- [ ] The installed service release matches HEAD and uses the official Herdr path.
- [ ] The service is ready after a safety-gated restart, with no prompt replay and
  no stalled outbox lanes.
