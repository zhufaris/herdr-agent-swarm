# Release Activator Design

## Objective

Reduce `src/cli/service-lifecycle.ts` complexity by placing the immutable-release
activation and compensation protocol behind one private deep module. Preserve
the existing `install` command, filesystem layout, marker format, systemd command
order, exit codes, diagnostics, and release-retention behavior.

This is a behavior-preserving decomposition. It does not change how candidates
are built or staged, start or restart the service, modify unit contents, or add a
new deployment authority.

## Current problem

The lifecycle facade currently contains the whole release commit protocol:
candidate trust validation, prior-state capture, durable recovery evidence, unit
installation, systemd reload and enable, atomic `current` link replacement,
rollback, evidence cleanup, and best-effort pruning. These steps form one ordered
state machine, but their helpers and error paths are interleaved with unrelated
log, restart, status, and startup-probe code.

The protocol is difficult to review locally because its correctness depends on
both action order and failure classification:

- a command failure returns its existing numeric exit code only after successful
  compensation;
- a filesystem failure is rethrown only after successful compensation;
- a failed compensation retains the marker and reports both failures;
- cleanup failure after the `current` switch reports a committed activation;
- pruning failure is diagnostic and cannot undo a committed activation.

## Chosen design

Keep `install()` and `runServiceLifecycle()` as the stable facade. Extract a
private `ReleaseActivator` under `src/cli/service-lifecycle/` with one operation:

```ts
activate(input: ReleaseActivationInput): number
```

The input contains the already derived runtime paths, process environment, build
identity, installed runtime environment, candidate value, unit writer callback,
systemd command callback, optional atomic-link rename seam, and diagnostic output
callbacks. These are construction inputs to a private implementation, not new
application ports.

The module owns the complete activation protocol:

1. validate that the candidate is a non-symlink direct child of the canonical
   releases directory;
2. validate the candidate directory name against build hash and Git commit and
   require it to resolve to `SWARM_ROOT`;
3. validate retention configuration;
4. capture the prior `current` target, unit files and modes, unit-derived release,
   and enabled state;
5. reject stale activation backups before changing state;
6. durably write the version-1 `prepared` recovery marker;
7. write backups and new units, then run `daemon-reload` and `enable`;
8. atomically replace `current` as the final activation commit;
9. on pre-commit failure, restore `current`, enabled state, unit contents and
   modes, reload systemd, and remove recovery evidence;
10. after commit, remove recovery evidence, prune only unretained releases, and
    print the existing success diagnostic.

The module may use synchronous filesystem operations because it implements the
existing short operator command and must preserve ordering. It does not own
configuration loading, log convergence, service activity checks, ordinary unit
installation, uninstall, restart, or startup verification.

## Interface and seam placement

`ReleaseActivator` is private to the service-lifecycle implementation. The
lifecycle facade supplies narrow callbacks for behavior it still owns:

- render/write the canonical service and rotation units;
- execute a systemd command with the existing environment and tolerance rules;
- emit stdout and stderr diagnostics.

Filesystem transition helpers stay inside the activator because exposing them
would leak the marker/backup/current-link protocol. The facade must not sequence
individual activation steps. It only detects `SWARM_RELEASE_CANDIDATE` and calls
the module once.

The internal path shape is defined locally rather than exporting the lifecycle
facade's complete `RuntimePaths`. It contains only the release and unit paths
required by activation.

## Preserved safety and failure semantics

- Recovery evidence is written before any unit or `current` mutation.
- Existing backup paths must be absent; stale evidence blocks activation.
- The `current` link changes only after unit write, reload, and enable succeed.
- The prior `current` target must itself be a trusted release child.
- A previously enabled unit is re-enabled during rollback; a disabled or absent
  unit is disabled.
- Unit restoration preserves prior contents and permission modes. Units that did
  not previously exist are removed during rollback.
- Rollback reload is mandatory; a rollback command failure retains recovery
  evidence and is surfaced as a compound error.
- Evidence cleanup failure after link replacement reports that activation was
  committed and leaves the marker for operator reconciliation.
- Pruning runs only after evidence cleanup. It retains the candidate, prior
  `current`, the release referenced by the prior unit, and the configured number
  of newest inactive releases. A pruning failure only writes the existing bounded
  diagnostic.
- No path outside the canonical direct-child releases set is removed.

## Alternatives rejected

### Extract only validation and pruning

This would reduce helper count but leave the marker, commit point, compensation,
and failure classification in the facade. The dangerous protocol would remain
distributed and the new modules would be shallow.

### Expose an activation step interface

Methods such as `prepare`, `installUnits`, `commit`, and `rollback` would let a
caller violate ordering or omit compensation. The value of the module is that one
operation enforces the entire protocol.

### Combine release activation with all installation behavior

Ordinary source-root installation has no `current` commit or recovery marker.
Combining it with candidate activation would introduce modes and conditional
invariants into the interface. Unit rendering can be extracted separately later.

## Testing

Keep the existing lifecycle integration tests as the authoritative end-to-end
coverage for actual filesystem state and command ordering. Add direct activator
tests only where they improve failure injection or make protocol ordering
explicit without duplicating every facade fixture. The protected cases are:

- successful activation switches `current` last and removes evidence;
- candidate, identity, path, prior-current, and stale-backup rejection;
- reload and enable failures restore prior state and return their exit codes;
- first-install failure removes newly written unit files;
- current-link commit failure compensates;
- compensation failure retains the marker and reports both errors;
- evidence-cleanup failure is reported as post-commit;
- pruning preserves current, prior, unit-referenced, and retained inactive
  releases and cannot roll back success;
- unit modes and enabled/disabled state survive compensation.

Add an architecture guard preventing source outside `src/cli/service-lifecycle.ts`
and `src/cli/service-lifecycle/` from importing the private activation module.

## Completion criteria

- `runServiceLifecycle()`, `install()`, CLI arguments, and public exports remain
  compatible.
- The facade contains one release-activation delegation and no marker, backup,
  compensation, current-link, or pruning implementation.
- Marker JSON, filesystem modes, systemd commands, exit codes, output, and error
  messages remain unchanged.
- No log, restart-safety, startup, health, configuration, schema, or runtime
  behavior changes.
- Focused lifecycle tests, typecheck, build, architecture checks, documentation
  audit, public audit, and the full test suite pass.
