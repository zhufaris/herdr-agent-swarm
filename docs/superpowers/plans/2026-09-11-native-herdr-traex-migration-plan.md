# Native Herdr TraeX Migration Implementation Plan

**Goal:** Cut Agent Swarm over to Herdr 0.9 native TraeX support without invalidating active binding, prompt, transcript, or turn-control fences.

**Architecture:** Introduce one pure TraeX session identity policy for semantic runtime comparison while retaining exact durable tuples. Replace shim readiness probing with native Herdr version, kind, and integration capability checks. Only after full verification will the installed service point at the official Herdr binary; model control extraction and shim deletion remain separate commits.

**Spec:** `docs/superpowers/specs/2026-09-11-native-herdr-traex-migration-design.md`

## Constraints

- Do not bulk-update live SQLite session tuples during compatibility work.
- Do not weaken pane, terminal, generation, session kind, or session value fences.
- Do not replay a prompt after uncertain delivery.
- Do not edit generated `dist/`.
- Do not change the installed service or `HERDR_BIN` before full tests pass.
- Preserve the JSONL transcript reader and periodic reconciliation.

## Task 1: Central TraeX session identity policy

**Files:**

- Create: `src/domain/traex-session-identity.ts`
- Create: `tests/traex-session-identity.test.ts`
- Modify: `src/coordinator/pane-runtime-identity.ts`
- Modify: `src/domain/transcript-observer-identity.ts`
- Modify: focused identity tests

- [ ] Add failing tests for the three accepted TraeX source aliases, native source, mismatched agent/kind/value, and unknown sources.
- [ ] Implement canonical semantic source and semantic equality helpers.
- [ ] Replace the private pane-normalization helper with the domain policy.
- [ ] Canonicalize only the in-process transcript observer cache identity; keep `transcriptSessionFor` exact for durable/runtime access.
- [ ] Prove source-alias changes do not change observer identity, while every real fence does.
- [ ] Run `npx vitest run tests/traex-session-identity.test.ts tests/pane-runtime-identity.test.ts tests/transcript-observer-identity.test.ts`.

## Task 2: Audit reconciliation and model boundaries

**Files:**

- Modify only the runtime comparison sites demonstrated by failing tests.
- Modify: `src/coordinator/model-selection-workflow.ts`
- Modify: relevant reconciler/model tests

- [ ] Locate all Herdr Agent session tuple comparisons and classify them as semantic runtime comparison or exact durable fence.
- [ ] Use semantic equality for live Herdr-vs-binding comparison.
- [ ] Keep SQL prompt and turn-control preconditions exact.
- [ ] Accept `herdr:traex` in model-session eligibility without yet changing the model transport.
- [ ] Add regression tests for unchanged binding generation and rejection of changed UUIDs.
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
- [ ] Commit identity compatibility, setup gate, and documentation as thematic commits.

## Task 5: Controlled live cutover

- [ ] Snapshot active binding generations, exact session values, prompt states, and outbox health.
- [ ] Run `./install.sh` to stage the verified immutable release.
- [ ] Change the private service environment to the official absolute Herdr binary.
- [ ] Restart through `npm run swarm:restart`; do not force past the active-work gate.
- [ ] Verify `/ready`, build identity, active binding generations/session values, prompt failures, and outbox lanes.
- [ ] Observe one native TraeX pane and confirm `source=herdr:traex` resolves to its exact JSONL thread.
- [ ] Roll back the environment/release if a binding detaches, generation changes, or session values diverge.

Task 5 requires a fresh operational review after Tasks 1-4; it is not implicit in source implementation.

## Task 6: TraeX control extraction and shim retirement

- [ ] Introduce `TraexControlPort` for model listing and model-aware prompt preparation/commit.
- [ ] Move model transport out of the Herdr CLI adapter.
- [ ] Keep steering unsupported unless a separate native TraeX control contract is proven.
- [ ] Delete PATH interception, launcher, reporter, installer scripts, package commands, and shim-only tests after reference and behavior audits.
- [ ] Unlink the installed shim only after the service is verified on official Herdr.
- [ ] Run the full verification suite and a final native smoke test.
