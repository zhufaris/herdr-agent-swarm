# Restart Safety Evaluator Design

## Objective

Reduce the complexity of `src/cli/service-lifecycle.ts` without changing any
operator-visible restart behavior. Keep `runServiceLifecycle()` as the stable
facade and move active-service status decoding and restart admission policy into
one private deep module.

This is a behavior-preserving decomposition. It does not change systemd command
ordering, HTTP probing, configuration loading, force-restart authorization, or
the safety conditions that block a restart.

## Current problem

`assertRestartSafe()` currently owns two different responsibilities:

1. effectful observation of the unit and configured `/status` endpoint;
2. decoding a loosely typed status document and applying restart policy.

The second responsibility contains the important fail-closed rules, but it is
embedded in the lifecycle command implementation. Adding a new health metric or
reviewing force behavior requires understanding systemd state, HTTP failures,
status schema traversal, error precedence, and message formatting together.

## Chosen design

Keep restart orchestration in `service-lifecycle.ts`. Extract a private
`RestartSafetyEvaluator` under `src/cli/service-lifecycle/` with one operation:

```ts
evaluate(status: unknown, options: { force: boolean }): void
```

Successful return means the decoded status permits the caller to continue. A
blocked or incomplete status throws the exact existing operator error. The
module owns:

- safe traversal and normalization of the untrusted status document;
- service identity validation;
- Primary prompt and Worker activity checks;
- actionable outbox and active-delivery checks;
- startup-recovery and SQLite-integrity checks;
- force-mode exemptions and fail-closed completeness checks;
- existing error precedence and exact message construction.

The lifecycle facade continues to own:

- determining `active`, `inactive`, or `indeterminate` systemd state;
- loading the installed runtime configuration;
- probing the configured loopback `/status` endpoint;
- distinguishing an inactive unit with a responding orphan listener;
- translating endpoint transport failure into the current contextual error;
- invoking the evaluator only after the endpoint is proven to belong to an
  active unit observation path.

This seam is deliberately private. No coordinator, runtime, store, health
collector, or setup caller receives the decoded status shape or depends on the
evaluator. `runServiceLifecycle()` remains the operator interface.

## Preserved policy

Unforced restart remains blocked by any of the following:

- running or queued Primary prompts;
- active Primary turn workers;
- active Worker dispatchers, observers, turns, or uncertain turns;
- ready, in-flight, retry-wait, or cooldown-wait outbox work;
- active deliveries.

Waiting-behind-lane outbox work remains diagnostic only and does not itself
block restart. A forced restart continues to bypass only the workload and
delivery checks. It does not bypass:

- wrong or missing service identity;
- non-completed startup recovery when that state is present;
- unhealthy SQLite integrity or a failed quick check;
- missing startup-recovery or SQLite-integrity fields.

For unforced restarts, any missing or invalid workload metric remains an
incomplete status and blocks the restart. Error precedence remains:

1. identity;
2. active Primary or Worker work;
3. actionable outbox work;
4. active delivery;
5. startup recovery;
6. SQLite integrity;
7. incomplete required metrics.

## Alternatives rejected

### Extract only parsing helpers

Moving `asRecord()`, `nonNegativeInteger()`, and `metric()` would shorten the
file slightly but leave callers responsible for the full policy protocol. The
resulting module would be shallow and would not improve review locality.

### Expose multiple policy functions

Separate public checks for prompts, Workers, outbox, recovery, and integrity
would leak ordering and completeness rules to the lifecycle facade. Callers
could accidentally skip a check or change error precedence.

### Extract the entire restart workflow now

Moving systemd state, HTTP probing, unit rewriting, log rotation, process
ownership, and startup verification in one change would combine several
independent protocols and increase regression risk. Those are later slices.

## Testing

Add direct evaluator tests for every decision branch, using plain status objects
without systemd or HTTP fixtures. Preserve the existing lifecycle integration
tests as facade-level coverage for unit activity, orphan listeners, endpoint
failures, installed configuration, force restart, and command ordering.

The direct matrix must cover:

- correct and incorrect service identity;
- every Primary and Worker workload field;
- every actionable outbox category and waiting-behind-lane-only work;
- active delivery;
- startup recovery and SQLite integrity failures;
- every missing/invalid required metric;
- forced restart exemptions and non-exempt safety checks;
- exact existing error text and precedence where multiple failures coexist.

Add an architecture guard that allows the lifecycle facade and private sibling
modules to import `src/cli/service-lifecycle/*`, while preventing other source
modules from bypassing the facade.

## Completion criteria

- `runServiceLifecycle()` and every existing export remain compatible.
- `assertRestartSafe()` becomes observation/orchestration code and delegates one
  decoded-policy decision to `RestartSafetyEvaluator`.
- Existing restart errors and systemd command ordering are unchanged.
- No configuration, health response, CLI, unit-file, log, release, or persistence
  contract changes.
- Focused evaluator and lifecycle tests, typecheck, build, architecture checks,
  documentation audit, public audit, and the full test suite pass.
