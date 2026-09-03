# Bridge Session Hook Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure bridge-created TraeX Panes can execute the bridge-owned SessionStart reporter and publish their exact native session UUID to Herdr.

**Architecture:** Keep the trust exception at the bridge's only TraeX process creation seam, `HerdrCliAdapter.startTraex()`. The reporter, Herdr identity reporting, strict transcript validation, and terminal-mode fallback remain unchanged.

**Tech Stack:** TypeScript, Vitest, TraeX CLI, Herdr CLI, user systemd bridge service.

**Spec:** `docs/superpowers/specs/2026-08-27-bridge-session-hook-trust-design.md`

## Global Constraints

- Apply `--dangerously-bypass-hook-trust` only to bridge-managed TraeX startup.
- Do not alter global TraeX hook configuration or infer JSONL identity from non-authoritative metadata.
- Verify a fresh binding's Herdr and SQLite native session identity after restart.

---

### Task 1: Trust the bridge-owned reporter hook

**Files:**
- Modify: `tests/herdr-adapter.test.ts`
- Modify: `src/adapters/herdr-adapter.ts`

**Interfaces:**
- Consumes: `HerdrCliAdapter.startTraex(paneId, executable)`.
- Produces: a `herdr pane run` invocation whose TraeX argument list contains `--dangerously-bypass-hook-trust` before the existing SessionStart override.

- [ ] **Step 1: Strengthen the adapter startup assertion**

Update the expected `pane run` argument list to require:

```ts
["pane", "run", "w1:p1", "/usr/local/bin/traex", "--permission-mode", "auto", "--dangerously-bypass-hook-trust", "-c", expect.stringMatching(/^'hooks\.SessionStart=/)]
```

- [ ] **Step 2: Run the focused test and observe the missing flag**

Run: `npx vitest run tests/herdr-adapter.test.ts`

Expected: the startup-argument assertion fails until the adapter includes the flag.

- [ ] **Step 3: Add the bridge-managed startup flag**

In `HerdrCliAdapter.startTraex()`, add `--dangerously-bypass-hook-trust` immediately after the configured permission mode and before `-c`. Preserve the existing quoted `sessionHookOverride()` value.

- [ ] **Step 4: Verify focused behavior**

Run: `npx vitest run tests/herdr-adapter.test.ts tests/report-traex-session.test.ts`

Expected: both files pass.

### Task 2: Build and validate the managed runtime

**Files:**
- Generated: `dist/` via `npm run build` only; never edit directly.

**Interfaces:**
- Consumes: the adapter startup arguments built in Task 1.
- Produces: a managed service whose newly created/reset binding has an authoritative native `traex` ID session.

- [ ] **Step 1: Run static and build validation**

Run: `npm run typecheck && npm run build && git diff --check`

Expected: all commands exit 0.

- [ ] **Step 2: Restart the managed bridge**

Run: `herdr plugin action invoke restart --plugin herdr-lark-bridge`

Expected: the plugin action starts a managed restart, then `/health` reports the expected new build identity.

- [ ] **Step 3: Verify a fresh binding identity**

Create or reset one bridge-owned Pane, then inspect it with `herdr api snapshot` and query `bindings.agent_session_agent`, `agent_session_kind`, and `agent_session_value` by its Pane ID.

Expected: Herdr and SQLite report `traex`, `id`, and the same UUID. Only then is the binding JSONL-eligible.
