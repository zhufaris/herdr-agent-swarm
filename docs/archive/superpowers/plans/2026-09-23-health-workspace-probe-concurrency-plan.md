# Health Workspace Probe Concurrency Implementation Plan

## Objective

Replace unbounded health-check workspace fan-out with the existing ordered,
fixed-width concurrency helper.

## Work packages

### 1. Capture the public behavior

- Add an HTTP-level `/ready` test with nine unique workspaces.
- Delay each Herdr assertion and record active and maximum concurrency.
- Assert all workspaces are checked while maximum concurrency is four.
- Run the focused test red against the unbounded implementation.

### 2. Bound the probe

- Import `mapWithConcurrency` into the health server.
- Define a health workspace probe concurrency of four.
- Preserve per-workspace error isolation and ordered response entries.

### 3. Verify and commit

- Run the health-server tests, typecheck, build, audits, and the complete suite.
- Review the diff and commit without installation, restart, or push.
