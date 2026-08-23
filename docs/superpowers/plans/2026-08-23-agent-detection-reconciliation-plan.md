# Agent Detection Reconciliation Implementation Plan

## Objective

Implement the approved layered runtime-evidence design in
`docs/superpowers/specs/2026-08-23-agent-detection-reconciliation-design.md`.
Recover bound TraeX panes whose Herdr structured state is `unknown`, while
remaining fail-closed and never replaying an already-dispatched prompt.

## Task 1: Lock the production symptom with adapter tests

Reproduce a snapshot pane with `agent_status=unknown`, no agent entry, an exact
`traex` foreground process, and a visible ready composer. Verify that a bound
pane runtime probe normalizes it to idle. Add negative cases for shell processes,
failed process inspection, and ambiguous terminal output.

## Task 2: Centralize terminal-state evidence

Add pure helpers for strong composer, working, and blocked markers. Historical
markers must not override the current terminal tail. Reuse the same classifier
in normal turn waiting and detached turn recovery.

## Task 3: Add a narrow bound-pane runtime probe

Extend the Herdr port with an explicit bound-pane observation method. Keep bulk
snapshot listing cheap. When structured state is unknown, inspect process-info;
only an exact TraeX executable permits a bounded terminal read and state
normalization. Forward the method through the workspace cache decorator.

## Task 4: Integrate reconciliation and queue wake-up

For active bound panes with unknown snapshot state, request the enriched runtime
observation before lifecycle transition and event publication. Preserve terminal
identity checks. Schedule the binding after normalized idle/done state so FIFO
work resumes, while working/blocked/unknown remain non-dispatchable as required.

## Task 5: Verify, commit, and deploy

Run adapter, parser, reconciler, lifecycle, and queue recovery tests, followed by
typecheck, build, full suite, and `git diff --check`. Commit only this feature and
its already-present related WIP. Restart the native plugin, then verify build
identity, `/ready`, `wH:p18` runtime evidence, and its durable queue/card state.
