# Systemd Status Diagnostics Design

## Problem

`swarm:status` currently reduces every unsuccessful `systemctl --user` query to
`active: false`. In an isolated command environment, the configured user bus
socket can be inaccessible even while the canonical user unit is running. The
result is a misleading inactive report beside a healthy Bridge response.

## Decision

Model the unit observation as `active`, `inactive`, or `unavailable`. A successful
`systemctl is-active` result remains authoritative for `active` and `inactive`. A
spawn error, timeout, unexpected exit, or user-bus connection failure becomes
`unavailable` with a bounded, sanitized diagnostic.

The status command continues to fail closed: only an active unit, matching build
identity, and listener ownership produce exit code zero. A healthy HTTP endpoint
must not substitute for systemd ownership because it could belong to a detached
or foreign process.

## Output and Compatibility

Keep the existing boolean `active` field for machine consumers, but add:

- `unitState`: `active`, `inactive`, or `unavailable`;
- `unitStatusDetail`: `null` for a conclusive query, otherwise the bounded
  systemctl failure text.

Thus existing consumers remain fail-closed while operators can distinguish a
stopped service from an unobservable user bus. Listener ownership uses the same
unit observation, so it reports the unit diagnostic instead of a generic missing
MainPID when systemd is unavailable.

## Verification

Add lifecycle tests for a failed user-bus query beside a healthy Bridge, proving
the result is `unavailable`, includes the systemctl error, and remains nonzero.
Retain coverage for true inactive units, active owned listeners, foreign
listeners, startup, restart, and log-rotation safety.
