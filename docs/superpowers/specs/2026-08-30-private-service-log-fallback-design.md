# Private Service Log Fallback Design

## Problem

The canonical user unit sends stdout to journald, and `swarm:logs` delegates
unconditionally to `journalctl`. On this host the runtime journal directory is
owned by `nobody:nogroup` with mode `2750`, the operator is not in
`systemd-journal`, and `/run` is mounted read-only in the current environment.
The service remains healthy, but its supported diagnostic command cannot read
any records.

Host administrators should still repair the journal ownership or container UID
mapping. The application must not depend on that external repair for its only
bounded diagnostic path.

## Design

The canonical unit writes stdout and stderr to a private append-only file under
`$SWARM_STATE_DIR/logs/service.log`. Installation creates the log directory with
mode `0700` and the log file with mode `0600` before systemd starts the service.
The generated unit uses systemd's file output directives and does not invoke a
shell or put secrets in command arguments.

`swarm:logs` reads a bounded tail from that canonical file. It must not fail
merely because journal ACLs are unavailable. The command reports the selected
source and never prints `.env`, credentials, submitted prompt arguments, or raw
terminal protocol content. Existing Pino redaction remains the content boundary.

The lifecycle command bounds disk use without adding another daemon: before
install or start, if the inactive service's log exceeds 16 MiB, it atomically
renames it to `service.log.1`, removes the previous `.1`, and creates a fresh
`0600` file. Restart performs rotation only after systemd has stopped the old
process and before it starts the new one. `swarm:logs` itself reads at most the
last 100 lines and 1 MiB. This mechanism requires neither root nor journald
access and never rotates underneath a running writer.

Journal output is optional after this change. Operators may still use
`journalctl` where host policy permits, but `swarm:logs` uses the private file as
the supported portable path.

## Host remediation

Outside the application, a host administrator may restore conventional journal
access by fixing `/run/log/journal/<machine-id>` ownership to
`root:systemd-journal`, adding the operator to `systemd-journal`, and starting a
fresh login session. If the path is a read-only or UID-remapped mount, the mount
or container configuration must be repaired on the host. The installer does not
attempt privileged ownership changes.

## Verification

Tests must prove that installation creates private log paths with restrictive
permissions, the unit directs both output streams to the canonical file, and
`swarm:logs` returns only a bounded tail when `journalctl` is unavailable. Live
verification must restart the canonical unit through the existing safety gate,
emit a known non-secret startup record, read it through `swarm:logs`, and confirm
that readiness, identity, PID ownership, SQLite integrity, and lease ownership
remain healthy.
