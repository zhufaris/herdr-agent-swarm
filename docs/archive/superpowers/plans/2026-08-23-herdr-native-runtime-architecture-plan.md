# Herdr-Native Runtime Architecture Implementation Plan

## Objective

Implement the approved Herdr-native runtime architecture without changing Lark
commands, durable queue semantics, pane ownership rules, or approval behavior.

## Slice 1: Native service control and health semantics

- Replace detached PID-file lifecycle management with a systemd user-service
  adapter.
- Generate the unit from resolved absolute plugin paths and keep application
  configuration outside the checkout.
- Add install and uninstall service actions.
- Make setup and project editing validate temporary files before atomic replace.
- Keep `/health` process-local and `/ready` dependency-aware.
- Update lifecycle, manifest, health, and configuration tests.

Verification: focused tests, shell syntax checks, typecheck, and production build.

## Slice 2: Bounded event wake-up channel

- Replace the per-event filesystem inbox and PID signal with a loopback UDP
  receiver.
- Keep event payloads bounded and extract only event, pane, and workspace hints.
- Coalesce bursts and retain periodic full reconciliation as recovery.
- Subscribe to `pane.agent_status_changed` and remove layout-only events.
- Update shutdown, relay, receiver, and manifest tests.

Verification: focused event tests plus malformed, stopped-listener, and burst
cases.

## Slice 3: Snapshot-based Herdr observation

- Parse `herdr api snapshot` behind the existing Herdr interface.
- Use one snapshot command per observation pass and filter by workspace in memory.
- Carry agent kind and state-change sequence through the internal pane model.
- Retain `pane list` plus `process-info` only as a private compatibility fallback.
- Skip output reads for unchanged panes where correctness permits.

Verification: adapter contract tests, reconciliation tests, and command-count
assertions.

## Slice 4: Native agent commands

- Start TraeX with `herdr agent start`.
- Submit ordinary turns with `herdr agent prompt`.
- Preserve active-turn steering and TraeX-local command behavior behind an
  explicit terminal fallback.
- Keep streaming observations and bounded cancellation behavior intact.

Verification: command construction, blocked/completed lifecycle, cancellation,
steering, and model-command tests.

## Slice 5: Documentation and acceptance

- Rewrite plugin installation, migration, operation, logs, troubleshooting, and
  uninstall instructions around systemd and native actions.
- Remove obsolete PID, file-log, startup-hook, and filesystem-inbox surfaces.
- Run the full test suite, typecheck, build, shell syntax checks, diff checks, and
  Herdr manifest registration.
- Inspect the final diff for accidental inclusion or damage to pre-existing work.
