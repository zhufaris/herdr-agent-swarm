# Restart Safety Evaluator Implementation Plan

## Objective

Implement the approved restart-safety decomposition while preserving every
operator-visible safety decision, error message, force exemption, and lifecycle
command ordering.

Design authority:
`docs/superpowers/specs/2026-09-25-restart-safety-evaluator-design.md`.

## Non-negotiable invariants

- `runServiceLifecycle()` remains the stable lifecycle facade.
- Unit activity, installed configuration, and `/status` observation remain in
  the facade.
- Wrong service identity always blocks restart, including forced restart.
- Force bypasses workload and delivery activity only.
- Startup recovery and SQLite integrity remain fail-closed in force mode.
- Waiting-behind-lane outbox work remains non-blocking by itself.
- Existing error precedence and exact operator messages do not change.
- No unit, release, log, HTTP, CLI, config, or persistence contract changes.

## Task 1: Characterize the evaluator interface

Create `tests/restart-safety-evaluator.test.ts` and express the current status
decision matrix directly against untrusted plain objects. Cover identity, every
workload and delivery metric, recovery and integrity state, missing/invalid
fields, forced restart exemptions, waiting-behind-lane-only work, and error
precedence. Keep the existing `tests/service-lifecycle.test.ts` integration
coverage intact.

## Task 2: Extract the private deep module

Create `src/cli/service-lifecycle/restart-safety-evaluator.ts`. Export one
`RestartSafetyEvaluator` with `evaluate(status, { force })`. Move status traversal,
normalization, admission checks, and message construction from
`assertRestartSafe()` into this module without changing their order or text.

The evaluator has no filesystem, HTTP, process, systemd, configuration, logging,
or SQLite dependency. It returns normally on admission and throws on refusal.

## Task 3: Reduce the lifecycle facade

Construct one private evaluator in `service-lifecycle.ts`. Keep unit activity,
configuration loading, inactive-listener detection, endpoint probing, and
transport-error wrapping in `assertRestartSafe()`. Replace the inline status
policy with a single evaluator call. Remove only parsing helpers that become
private implementation details of the evaluator.

## Task 4: Enforce and document the seam

Add an architecture guard preventing source outside
`src/cli/service-lifecycle.ts` and `src/cli/service-lifecycle/` from importing the
private directory. Update `docs/architecture.md` to describe restart observation
in the facade and policy evaluation in the private module.

## Task 5: Completion audit

Run:

```bash
npx vitest run tests/restart-safety-evaluator.test.ts tests/service-lifecycle.test.ts tests/architecture-boundaries.test.ts
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm run public:audit
npm test
git diff --check
```

Perform independent specification and quality reviews. Fix findings and rerun the
affected gates before committing. Push, installation, and restart remain outside
this slice.
