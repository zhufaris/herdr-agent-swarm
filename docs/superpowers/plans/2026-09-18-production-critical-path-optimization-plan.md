# Production Critical Path Optimization Implementation Plan

**Goal:** Audit and improve stability, measured performance, and maintainability
across the five production-critical paths defined in
`docs/superpowers/specs/2026-09-18-production-critical-path-optimization-design.md`,
while preserving external behavior and all durability and no-replay invariants.

## Task 1: Capture the baseline and audit record

- Record the repository revision, Node version, test/build status, architecture
  status, production readiness, startup recovery diagnostics, active work, and
  delivery health.
- Inspect the concrete composition, coordinator, SQLite, and delivery modules used
  by each critical path rather than inferring behavior from filenames or line count.
- Create `docs/operations/production-critical-path-optimization-audit.md` with one
  evidence table for candidates, including priority, invariant, reproducer or
  measurement, decision, and verification.
- Do not mutate the live database. Use read-only queries and temporary databases.
- Commit audit and measurement infrastructure independently.

## Task 2: Audit startup, recovery, and shutdown

- Trace composition startup order, fenced lease acquisition, startup stages,
  interrupted claims and observers, periodic runners, shutdown ordering, and service
  status ownership checks.
- Establish focused tests for every confirmed P0/P1 failure before correcting it.
- Measure startup-stage duration, repeated scans, Herdr calls, stop latency, and
  observer recovery with deterministic fakes or existing structured diagnostics.
- Correct confirmed failures without weakening detach-without-replay behavior.
- Correct restart safety so quarantined, non-actionable rows do not permanently
  block restart, while ready, retry-wait, cooldown-wait, in-flight, active-delivery,
  or incomplete metrics continue to fail closed.
- Remove only duplicated lifecycle or scan decisions exposed by the correction.
- Run focused tests, typecheck, architecture checks, build, and the full suite when
  shared recovery behavior changes; commit the slice independently.

## Task 2A: Strengthen local structured logging

- Keep Pino as the structured application logger and systemd as the sole writer of
  `service.log`; do not add `tslog` or an application file transport.
- Extend stopped-state rotation from one backup to a bounded generation chain while
  preserving the 16 MiB threshold, `0700`/`0600` permissions, link defenses, and
  failure atomicity.
- Extend `swarm:logs` with bounded line/byte controls, optional rotated history,
  structured level/time/component/correlation filters, and headerless JSONL output.
- Keep the current final-100-lines/final-1-MiB behavior when no option is supplied.
- Reject invalid arguments and unsafe paths. Skip malformed records only when a
  structured filter requires JSON parsing; never expose secret configuration.
- Add focused lifecycle tests for compatibility, bounds, history ordering, rotation
  retention, permissions, unsafe links, rename failures, filters, malformed lines,
  and JSONL output. Update operator and architecture documentation.
- Run focused lifecycle tests, typecheck, architecture checks, build, and the full
  suite because lifecycle and operator behavior are shared; commit independently.

## Task 3: Audit inbound messages and the Prompt FIFO

- Trace provider normalization, authorization, durable inbound insertion, routing,
  Prompt acceptance, keyed FIFO claim, steering, exact-turn ownership, and settlement.
- Test confirmed duplicate acceptance, interrupted claim, ordering, or wake-up risks
  before implementation.
- Measure claim latency, scan volume, and per-binding serialization under fixed
  workloads.
- Correct only evidenced stability or performance problems and consolidate only
  semantically identical state/fence decisions.
- Run inbound, concurrency, steering, turn-supervisor, recovery, architecture,
  typecheck, build, and full-suite gates; commit independently.

## Task 4: Audit Worker scheduling and reconciliation

- Trace Worker turn acceptance, instance-key scheduling, generation claims, Agent
  dispatch, exact observation, Herdr event hints, periodic reconciliation, and stop.
- Test stale identity, duplicate wake-up, interrupted observer, per-instance failure
  isolation, and shutdown outcomes where evidence identifies a gap.
- Measure dispatch scans, coalesced wake-ups, Herdr calls, and fairness with fixed
  inputs.
- Correct confirmed failures and narrow scheduler/reconciler dependencies where the
  same decision is currently duplicated.
- Reproduce external turns that become durably idle without a terminal transcript
  event. Fail them closed only after two distinct post-start idle/done observations
  with no intervening exact-turn transcript activity, using a transactional full
  identity fence; publish failure and wake the FIFO without replay.
- Run Worker integration, scheduler, reconciler, architecture, typecheck, build, and
  full-suite gates; commit independently.

## Task 5: Audit SQLite transactions, queries, and migrations

- Map critical aggregate transactions and the exact queries used by startup, Prompt,
  Worker, and delivery paths.
- Use temporary representative databases to collect query counts and
  `EXPLAIN QUERY PLAN` for suspected hotspots.
- Add indexes or reshape queries only when the evidence shows a real scan or repeated
  query cost.
- Test any migration from the supported prior schema, on an empty database, and on
  repeated startup.
- Consolidate duplicate record mapping or version/fence predicates only when atomic
  boundaries and consumer-shaped interfaces remain explicit.
- Run SQLite, migration, workflow integration, architecture, typecheck, build, and
  full-suite gates; commit independently.

## Task 6: Audit card delivery and recovery

- Trace projection invalidation, durable intent reservation, lane claim, Gateway
  checkpointing, streaming lifecycle, retry classification, quarantine, dead-letter
  recovery, and Main/Answer Card convergence.
- Correlate current structured delivery diagnostics with durable state before treating
  existing dead letters as defects.
- Test each confirmed ordering, redundant update, recovery, or convergence failure.
- Measure drain attempts, retries, no-op updates, and convergence delay with fixed
  scenarios.
- Correct evidenced issues while preserving immutable frozen pages and delivery-only
  retries; simplify only duplicated delivery decisions.
- Run publisher, outbox, card, stream, recovery, architecture, typecheck, build, and
  full-suite gates; commit independently.

## Task 7: Final cleanup and documentation

- Review all touched interfaces and delete only code proven unused by repository
  search, compilation, and tests.
- Update architecture or operator documentation for behavior or diagnostics that
  actually changed.
- Complete the audit table with before/after evidence, commit IDs, and any audit-only
  candidates that were deliberately not changed.
- Run `git diff --check`, focused tests, `npm test`, `npm run typecheck`,
  `npm run architecture:check`, `npm run docs:audit`, and `npm run build`.
- Inspect the complete commit range and working tree before installation.

## Task 8: Install and validate the release

- Run `./install.sh` only after every repository gate passes.
- Verify repeated candidate installation retains the immutable release referenced by
  the prior installed unit until the running process can pass the normal restart gate.
- Inspect active Prompt workers, Worker turns, observers, outbox work, lease, and
  readiness before restarting.
- Use `npm run swarm:restart` and respect its active-work safety gate. Do not force a
  restart without a new explicit user authorization.
- Verify the running build identity, `/ready`, SQLite integrity, project workspaces,
  Herdr socket, Feishu connection, startup recovery, and representative card
  convergence.
- Do not push. If a later request authorizes a push, first inspect the complete
  outgoing range and pass `npm run public:audit`.

## Task 9: Completion audit

- Map every design requirement and plan task to a committed artifact, test, benchmark,
  command result, or runtime observation.
- Confirm that every evidenced P0/P1 issue is fixed, every P2 change has comparable
  before/after data, and every P3 cleanup names the removed duplicate decision or
  dependency.
- Treat missing evidence as incomplete work and continue the relevant slice.
- Report unresolved audit-only risks separately from completed changes.
