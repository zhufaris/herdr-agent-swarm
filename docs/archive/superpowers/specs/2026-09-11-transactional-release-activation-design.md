# Transactional Release Activation Design

## Problem

Both source and packaged installers currently switch
`${SWARM_STATE_DIR}/current` before configuration validation and user-systemd
installation complete. If validation, unit writing, `daemon-reload`, or `enable`
fails, the operator-facing `current` link identifies the new release while the
installed unit may still identify the old release or contain a partially applied
new definition. The immutable release directory is safe, but activation is not a
single coherent transition.

## Goals

- Keep a newly staged release inactive until configuration and lifecycle
  installation succeed.
- Make `current` the final commit point of a successful installation.
- Restore the prior unit definition and enabled state after a caught failure.
- Persist enough private evidence to fail closed after an interrupted or failed
  compensation.
- Use one activation protocol for source and packaged installs.
- Keep installation non-starting: activation enables the unit but does not start
  or restart it.

## Non-goals

- Providing ACID transactions across the filesystem and systemd manager.
- Automatically restarting an active service onto the new release.
- Deleting the candidate release after a failed activation.
- Changing the restart active-work safety gate.

## Considered approaches

### 1. Candidate staging with compensated lifecycle activation (selected)

Stage an immutable candidate without changing `current`. The lifecycle installer
records the previous activation state, installs and enables the candidate unit,
then atomically exchanges `current` as the final commit. Before the commit, a
caught failure restores the previous unit and enabled state. A private marker
records an interrupted transaction and blocks further mutating lifecycle work.

This keeps one explicit commit point while acknowledging that filesystem and
systemd operations cannot form a real ACID transaction.

### 2. Make the unit execute through `current`

A stable symlink in `ExecStart` reduces the number of files changed during
activation, but it can separate the unit's pinned expected build identity from
the executable selected by the link. It also weakens the immutable-release
evidence used by startup and status checks.

### 3. Switch `current` first and switch it back on failure

This is a small shell change, but it leaves the unit file and enabled state
outside the rollback boundary. It also exposes the new release through normal
operator commands before lifecycle installation is known to have succeeded.

## Staging protocol

`scripts/stage-production-runtime.sh` becomes a pure candidate preparer:

1. Validate build identity and release-retention configuration.
2. Build the release in a private `.staging.*` directory.
3. Atomically rename it to its immutable release directory when absent.
4. Print the canonical candidate path.

It does not create or replace `current`, and it does not prune releases. Candidate
creation is idempotent: an existing directory for the exact build identity is
reused.

Both `install.sh` and the packaged installer validate configuration before
activation. They pass the candidate explicitly as `SWARM_RELEASE_CANDIDATE` and
use it as `SWARM_ROOT` for the lifecycle command. Neither script writes `current`
directly.

## Activation transaction

The lifecycle installer recognizes activation only when
`SWARM_RELEASE_CANDIDATE` is present. It verifies that the candidate:

- resolves to the same directory as `SWARM_ROOT`;
- is a direct, non-symlink child of `${SWARM_STATE_DIR}/releases`;
- has a valid build identity consistent with its release directory name.

Before mutation it rejects an existing private
`${SWARM_STATE_DIR}/.release-activation.json` marker. It then snapshots:

- the prior `current` state: absent or a validated symlink to a release;
- the prior unit state: absent or a regular file copied to a private backup;
- whether the unit was enabled, disabled, or absent. An indeterminate enabled
  state blocks activation before mutation.

The installer atomically writes a mode-`0600` marker naming the candidate, prior
release, unit-backup path, prior enabled state, and phase. It then performs:

1. convergence of private log paths;
2. atomic write of the candidate-pinned unit;
3. `systemctl --user daemon-reload`;
4. `systemctl --user enable herdr-agent-swarm.service`;
5. atomic replacement of `${SWARM_STATE_DIR}/current` with the candidate;
6. marker and backup removal;
7. bounded release pruning that always preserves the candidate and previous
   active release.

The `current` exchange is the activation commit. A successful return guarantees
that the unit and `current` both identify the candidate and enablement succeeded.
The active process, if any, remains untouched until an explicit safe restart.

Ordinary `swarm:install` from an already active release may omit the candidate;
it retains the existing unit-only convergence behavior and never invents a
release activation.

## Failure and recovery

Before the `current` commit, any caught failure compensates in reverse order:

1. restore or remove the unit file to match its prior state;
2. run `daemon-reload`;
3. restore prior enabled/disabled state when activation may have changed it;
4. confirm that `current` still identifies its prior target;
5. remove the marker and unit backup only after all compensation succeeds.

If the final `current` exchange itself fails, the same compensation applies. If
compensation fails, the original error and compensation error are reported and
the marker remains. A signal or process crash likewise leaves the marker. Future
`install`, `start`, and `restart` operations reject that ambiguous state with the
marker path and recovery guidance; observational `status` and `logs`, plus
`stop`, remain available. This design does not guess whether an interrupted
systemd call took effect.

No automatic rollback happens after the `current` commit. Operations after that
point are cleanup only; pruning failure is reported as a warning and cannot
invalidate the already committed activation. Pruning never deletes `current`,
the previous active release captured by the transaction, or the configured
number of newest inactive releases.

## Tests

Shell-level tests cover both source and packaged installers:

- staging creates/reuses a candidate without touching `current`;
- missing or placeholder configuration leaves `current` unchanged;
- lifecycle failure leaves `current` unchanged and returns non-zero;
- successful installation switches `current` only after lifecycle success;
- source and packaged installs pass the same explicit candidate contract;
- post-commit pruning retains current, previous, and the configured inactive
  releases.

Lifecycle tests inject failures at unit write, daemon reload, enable, current
exchange, and rollback. They verify exact restoration of the prior unit bytes,
mode, current target, and enabled state; marker cleanup on successful compensation;
marker retention and mutating-operation refusal after failed compensation; and no
start/restart call during installation.

Run the focused standalone-install and service-lifecycle suites, typecheck, build,
`git diff --check`, then the full Vitest suite.

## Documentation impact

Update architecture and operator documentation to distinguish candidate staging
from activation, name `current` as the final commit point, explain marker recovery,
and retain the explicit install-versus-start boundary.
