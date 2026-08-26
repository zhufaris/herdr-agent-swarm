# Non-blocking Service Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a normal 50-second graceful systemd stop from being reported as a failed bridge restart.

**Architecture:** Keep the generated unit unchanged. For the restart lifecycle action, request an asynchronous systemd restart, then make the lifecycle process the authority for a bounded 90-second handover check: active unit plus the expected bridge health identity on two consecutive probes. Keep synchronous start semantics unchanged.

**Tech Stack:** Node.js 22+, TypeScript ESM, systemd user units, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-nonblocking-service-restart-design.md`

## Global Constraints

- Preserve `TimeoutStopSec=50` and `Restart=on-failure` in the generated unit.
- Do not change bridge shutdown, prompt observation, or outbox behavior.
- Restart succeeds only after two matching active health observations.
- Default restart handover wait is 90,000 milliseconds.

---

### Task 1: Cover non-blocking restart handover behavior

**Files:**

- Modify: `tests/plugin-lifecycle.test.ts`

**Interfaces:**

- Consumes: `runPluginLifecycle(action, environment)` from `src/cli/plugin-lifecycle.ts`.
- Produces: regression coverage for systemd `--no-block`, expected-build gating, and timeout diagnostics.

- [ ] **Step 1: Write the failing restart command expectation**

Change the existing rebuilt-plugin restart test to assert:

```ts
expect(readFileSync(fixture.calls, "utf8")).toContain(
  "--user daemon-reload\n--user restart --no-block test-bridge.service"
);
```

- [ ] **Step 2: Run the focused test to verify the new assertion fails**

Run `npx vitest run tests/plugin-lifecycle.test.ts`. Expect the current restart command assertion to fail because it lacks `--no-block`.

- [ ] **Step 3: Add stale-build and timeout diagnostic tests**

Create a fixture whose health server returns `sha256:stale-build`; invoke `restart` with a short `BRIDGE_PLUGIN_RESTART_TIMEOUT_MS`, then assert the rejection includes expected build, `unit active`, and `observed sha256:stale-build`. Use an active fixture so the test proves a stale healthy process cannot satisfy a restart.

- [ ] **Step 4: Add two-consecutive-check success coverage**

Use a matching health server and restart with a short sufficient handover timeout. Assert the call log uses `restart --no-block`, and that the lifecycle resolves only after the health server has been queried at least twice.

- [ ] **Step 5: Run focused tests**

Run `npx vitest run tests/plugin-lifecycle.test.ts`. Expect current implementation to fail the new behavior tests.

### Task 2: Implement async systemd restart and bounded handover polling

**Files:**

- Modify: `src/cli/plugin-lifecycle.ts`

**Interfaces:**

- Consumes: `systemctl --user restart --no-block <service>` and bridge `/health`.
- Produces: `runPluginLifecycle("restart")` that waits up to 90 seconds for two expected-build observations.

- [ ] **Step 1: Separate restart from synchronous lifecycle delegation**

Use action-specific arguments: `restart` delegates `systemctl --user restart --no-block <service>`; `start`, `stop`, and other actions retain their current arguments.

- [ ] **Step 2: Add a restart-specific timeout resolver**

Add `restartTimeoutMs(environment)` returning a positive `BRIDGE_PLUGIN_RESTART_TIMEOUT_MS` value or `90_000`. Keep `BRIDGE_PLUGIN_START_TIMEOUT_MS` and its 15-second default for `start`.

- [ ] **Step 3: Make health polling report final observations**

Extend the health wait helper to accept timeout and action label, tracking last unit state (`active` or `inactive`) and health build ID (`unavailable` when unreachable). On timeout include expected build, action, elapsed timeout, final unit state, observed build, and the status command. Reuse the existing two-consecutive-health-check rule.

- [ ] **Step 4: Run focused tests**

Run `npx vitest run tests/plugin-lifecycle.test.ts`. Expect all plugin lifecycle tests to pass.

### Task 3: Validate production build and operator documentation

**Files:**

- Modify: `README.md` only if its operational restart wording implies synchronous completion without health validation.

**Interfaces:**

- Consumes: built `dist/cli/plugin-lifecycle.js`.
- Produces: a buildable plugin whose restart reports success only after expected-build health checks.

- [ ] **Step 1: Check README restart wording**

If restart behavior is documented, state that the plugin waits for the replacement process to report the expected build identity. Do not document internal polling details.

- [ ] **Step 2: Run type and build validation**

Run `npm run typecheck` and `npm run build`. Expect both commands to exit with status 0.

- [ ] **Step 3: Run final focused regression test**

Run `npx vitest run tests/plugin-lifecycle.test.ts`. Expect all lifecycle tests to pass after the build.

- [ ] **Step 4: Commit the implementation**

Stage only `src/cli/plugin-lifecycle.ts`, `tests/plugin-lifecycle.test.ts`, and any README change, then commit with `fix: wait for non-blocking bridge restart handover`.
