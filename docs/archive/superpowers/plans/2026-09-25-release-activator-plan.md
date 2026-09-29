# Release Activator Implementation Plan

## Objective

Implement the approved immutable-release activation decomposition behind the
existing lifecycle facade without changing any operator-visible behavior.

Design authority:
`docs/superpowers/specs/2026-09-25-release-activator-design.md`.

## Non-negotiable invariants

- `runServiceLifecycle()` and `install()` remain the stable facade.
- Candidate validation, durable preparation, unit installation, systemd changes,
  atomic link commit, compensation, cleanup, and pruning remain one ordered
  protocol behind one private operation.
- Marker version, phase, JSON fields, backup paths, unit modes, systemd command
  order, exit codes, stdout, stderr, and error text do not change.
- `current` changes only after new units are written and `daemon-reload` plus
  `enable` succeed.
- A pre-commit failure compensates; a post-commit cleanup failure reports a
  committed activation; pruning remains best effort.
- No configuration, log, start, restart, status, startup-probe, health, schema,
  runtime, or ordinary source-root installation behavior changes.

## Task 1: Characterize the private interface and ordering

Add focused tests for `ReleaseActivator.activate(...)` where direct failure
injection improves protocol visibility. Assert that successful activation
commits `current` last, command failures preserve their exit codes after
compensation, filesystem failures are rethrown after compensation, failed
compensation retains recovery evidence, and post-commit cleanup and pruning
retain their existing classifications. Keep `tests/service-lifecycle.test.ts` as
the authoritative facade-level filesystem and operator-output suite.

## Task 2: Extract the complete activation protocol

Create `src/cli/service-lifecycle/release-activator.ts`. Export one private
module interface with `activate(input): number`. Move candidate and prior-state
validation, marker and backup handling, unit transition sequencing, atomic
`current` replacement, rollback, evidence cleanup, retention calculation, and
safe pruning into the module.

Accept only the activation-specific path shape and the existing variable seams:
unit writing, systemd command execution, atomic rename, and stdout/stderr. Do not
expose individual protocol phases. Preserve synchronous filesystem ordering.

## Task 3: Reduce the lifecycle facade

Construct the private activator in `src/cli/service-lifecycle.ts`. Keep build
identity loading, installed runtime-environment derivation, ordinary unit
installation, and candidate detection in `install()`. Replace the inline release
protocol with one activation call and remove only helpers now owned by the deep
module. Keep all public exports and CLI dispatch unchanged.

## Task 4: Enforce and document the seam

Extend the architecture tests and import checker so source outside
`src/cli/service-lifecycle.ts` and `src/cli/service-lifecycle/` cannot import the
private activator. Update `docs/architecture.md` to describe the lifecycle facade
as the operator surface and the private activator as the sole owner of immutable
release commit and compensation.

## Task 5: Completion audit

Run:

```bash
npx vitest run tests/release-activator.test.ts tests/service-lifecycle.test.ts tests/architecture-boundaries.test.ts
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm run public:audit
npm test
git diff --check
```

Review the final diff against the design and compare all moved diagnostics and
failure paths byte-for-byte. Fix findings and rerun affected gates before
committing. Push, installation, and restart remain outside this slice.
