# TraeX Native Herdr Agent Prompt Implementation Plan

> **For agentic workers:** Execute this plan inline. This repository session explicitly forbids sub-agent delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require Herdr Agent detection before TraeX becomes ready, submit ordinary turns only through `herdr agent prompt`, and remove raw Pane prompt and steering dispatch.

**Architecture:** TraeX remains a product-level Agent kind launched with the configured executable through `herdr pane run`, while Herdr observes it through its Codex-compatible Agent detector. `HerdrCliAdapter` owns the strict detection and prompt-result classification; runtime drivers consume only `runPrompt`, and unsupported steering fails before terminal input. Terminal reads remain available only for explicitly retained model-selection and bounded diagnostic/state fallback paths.

**Tech Stack:** TypeScript, Node.js 22+, the then-supported Herdr release CLI/native socket API, Vitest, SQLite-backed durable workflows

**Spec:** `docs/superpowers/specs/2026-08-29-traex-native-agent-prompt-design.md`

## Global Constraints

- Do not add a synthetic `traex` kind to Herdr or replace `TRAEX_BIN` with the separate `codex` executable.
- A TraeX runtime is dispatchable only after the same Pane is reported as `agent="codex"` or `agent="traex"` and `idle` or `done`.
- Ordinary prompt submission must never call `pane send-text` or `pane send-keys`.
- Explicit pre-input Agent rejections are not delivered; unknown failures after command process start are delivery-uncertain.
- Never automatically replay a prompt after it may have reached the Agent.
- Raw terminal steering is unsupported and must not silently become an ordinary queued turn.
- Keep `/model` and approval UI behavior outside this change.
- Do not manually edit generated `dist/` output.

---

### Task 1: Require Codex-compatible Herdr detection for TraeX startup

**Files:**
- Modify: `src/adapters/herdr-adapter.ts:150-160,449-458`
- Test: `tests/herdr-adapter.test.ts:280-410`

**Interfaces:**
- Consumes: `HerdrCliAdapter.getPane(paneId): Promise<HerdrPane | null>` and `matchesHerdrAgentKind` semantics from `src/domain/agent-instance.ts`.
- Produces: `startTraex(paneId, executable, args?): Promise<void>` that resolves only for a compatible detected Agent in `idle` or `done`.

- [ ] **Step 1: Replace composer-readiness tests with detection tests**

Add focused adapter cases that model snapshots rather than terminal text:

```ts
it("waits for Herdr to detect launched TraeX as a ready Codex-compatible Agent", async () => {
  const snapshots = [
    snapshot({ agent: null, agent_status: "unknown" }),
    snapshot({ agent: "codex", agent_status: "working" }),
    snapshot({ agent: "codex", agent_status: "idle" })
  ];
  // runner returns snapshots in order and records pane run calls
  await expect(adapter.startTraex("w1:p1", "traex")).resolves.toBeUndefined();
  expect(calls).toContainEqual(expect.arrayContaining(["pane", "run", "w1:p1", "traex"]));
});

it("does not accept an undetected TraeX foreground process as ready", async () => {
  // snapshots remain agent_status=unknown while process-info reports traex
  await expect(adapter.startTraex("w1:p1", "traex"))
    .rejects.toThrow("Herdr did not detect a ready TraeX-compatible agent in pane w1:p1");
});

it("accepts a background done Codex-compatible Agent without terminal reads", async () => {
  // snapshot reports agent=codex, agent_status=done
  await expect(adapter.startTraex("w1:p1", "traex")).resolves.toBeUndefined();
  expect(calls.some((args) => args[0] === "pane" && args[1] === "read")).toBe(false);
});
```

- [ ] **Step 2: Run the startup cases and verify they fail**

Run: `npx vitest run tests/herdr-adapter.test.ts -t "TraeX|Codex-compatible|undetected"`

Expected: the new detection cases fail because `startTraex` currently accepts composer readiness and calls terminal reads.

- [ ] **Step 3: Implement strict detection waiting**

Replace `waitUntilTraexComposer` with a helper whose predicate is explicit and independent of terminal output:

```ts
private async waitUntilTraexAgentReady(paneId: string): Promise<void> {
  const deadline = Date.now() + this.commandTimeoutMs;
  while (Date.now() < deadline) {
    const pane = await this.getPane(paneId);
    const compatible = pane?.agentKind === "codex" || pane?.agentKind === "traex";
    if (compatible && (pane.agentState === "idle" || pane.agentState === "done")) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Herdr did not detect a ready TraeX-compatible agent in pane ${paneId}`);
}
```

In `startTraex`, retain the current `pane run` argv and session hook, then call `waitUntilTraexAgentReady`. Do not call `observeRuntime`, because its unknown-state fallback reads terminal output. For an already-running process, use `getPane` plus foreground process inspection only to decide whether launch is necessary; readiness still requires compatible structured detection.

- [ ] **Step 4: Run focused startup tests**

Run: `npx vitest run tests/herdr-adapter.test.ts -t "starts|TraeX|Codex-compatible|undetected"`

Expected: all selected cases pass and the ready paths issue no `pane read`.

- [ ] **Step 5: Commit strict startup detection**

```bash
git add src/adapters/herdr-adapter.ts tests/herdr-adapter.test.ts
git commit -m "fix: require Herdr agent detection for TraeX"
```

### Task 2: Make `herdr agent prompt` the only ordinary submission path

**Files:**
- Modify: `src/adapters/herdr-adapter.ts:190-218,464-495`
- Modify: `src/domain/ports.ts:108-125`
- Modify: `src/runtime/workspace-snapshot-cache.ts:138-160`
- Modify: `src/runtime/herdr-circuit-breaker.ts:63-90`
- Modify: `src/runtime/agents/traex-driver.ts:28-43`
- Modify: `src/runtime/agents/terminal-agent-driver.ts:22-35`
- Test: `tests/herdr-adapter.test.ts:460-510,820-930,1300-1360`
- Test: `tests/agent-driver-contract.test.ts:40-100`

**Interfaces:**
- Consumes: `CommandRunner.run(executable, args, timeoutMs, onStarted)` and `HerdrPort.runPrompt(...)`.
- Produces: one ordinary submission contract; removes `HerdrPort.runManagedPrompt`.

- [ ] **Step 1: Add failing prompt-safety tests**

Replace the fallback expectations with explicit safety assertions:

```ts
it.each(["agent_not_found", "agent_not_ready", "agent_blocked"])(
  "does not use Pane input after explicit %s rejection",
  async (code) => {
    // agent prompt throws JSON error with this code
    await expect(adapter.runPrompt("w1:p1", "hello", 1_000, undefined, undefined, onDispatched))
      .rejects.toThrow(code);
    expect(dispatched).toBe(0);
    expect(calls.some((args) => args[0] === "pane" && ["send-text", "send-keys"].includes(args[1]!))).toBe(false);
  }
);

it("marks an unknown failure after agent prompt process start as dispatched", async () => {
  // runner invokes onStarted, then rejects with a timeout that has no explicit pre-input code
  await expect(adapter.runPrompt("w1:p1", "hello", 1_000, undefined, undefined, onDispatched))
    .rejects.toThrow("timeout");
  expect(dispatched).toBe(1);
});
```

Update driver contract tests so both `TraexDriver.submit` and one concrete terminal driver call `runPrompt`, never `runManagedPrompt`, and classify callback-before-failure as `delivery-uncertain`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/herdr-adapter.test.ts tests/agent-driver-contract.test.ts`

Expected: explicit rejections currently enter raw Pane fallback, and drivers currently prefer `runManagedPrompt`.

- [ ] **Step 3: Implement conservative Agent prompt classification**

Change `runPrompt` to invoke only the Herdr Agent command and track process start separately from confirmed dispatch:

```ts
let commandStarted = false;
try {
  await this.runner.run(
    this.executable,
    ["agent", "prompt", paneId, text],
    this.commandTimeoutMs,
    () => { commandStarted = true; }
  );
  await onDispatched?.();
} catch (error) {
  if (isExplicitPreInputAgentPromptRejection(error)) throw error;
  if (commandStarted || isPossiblyDispatchedAgentPromptError(error)) await onDispatched?.();
  throw error;
}
```

Define `isExplicitPreInputAgentPromptRejection` for exact Herdr error codes
`agent_not_found`, `agent_not_ready`, and `agent_blocked`. These are accepted as
pre-input only when returned as Herdr's structured command error; an unclassified
message containing the same words remains uncertain after `onStarted`. Do not
fall back to `submitPromptText`. Preserve the existing post-dispatch
observation/no-replay behavior.

- [ ] **Step 4: Remove the parallel managed submission contract**

Delete `runManagedPrompt` from `HerdrPort` and `HerdrCliAdapter`. Remove any forwarding methods from wrappers if present. Change both runtime drivers to call exactly:

```ts
await this.herdr.runPrompt(
  runtime.paneId,
  text,
  this.turnTimeoutMs,
  undefined,
  undefined,
  () => { dispatched = true; onDispatched?.(); }
);
```

Do not alter transcript acquisition or Answer projection. Keep raw composer helpers only if `/model` still calls them; remove obsolete ordinary-prompt branches and tests.

- [ ] **Step 5: Run adapter and driver tests**

Run: `npx vitest run tests/herdr-adapter.test.ts tests/agent-driver-contract.test.ts`

Expected: both files pass; ordinary submission tests contain no successful `pane send-text` expectation.

- [ ] **Step 6: Scan the ordinary submission surface**

Run: `rg -n "runManagedPrompt|isUnsupportedAgentPromptError" src tests`

Expected: no matches.

Run: `rg -n "submitPromptText" src/adapters/herdr-adapter.ts`

Expected: matches are limited to explicit model/Pane command control paths and its private helper; `runPrompt` does not call it.

- [ ] **Step 7: Commit native prompt submission**

```bash
git add src/adapters/herdr-adapter.ts src/domain/ports.ts src/runtime/workspace-snapshot-cache.ts src/runtime/herdr-circuit-breaker.ts src/runtime/agents/traex-driver.ts src/runtime/agents/terminal-agent-driver.ts tests/herdr-adapter.test.ts tests/agent-driver-contract.test.ts
git commit -m "refactor: submit agent turns through Herdr"
```

### Task 3: Disable raw terminal steering without changing queue semantics

**Files:**
- Modify: `src/adapters/herdr-adapter.ts:220-225`
- Modify: `src/domain/ports.ts:120-126`
- Modify: `src/runtime/workspace-snapshot-cache.ts:155-160`
- Modify: `src/runtime/herdr-circuit-breaker.ts:83-90`
- Modify: `src/runtime/agents/traex-driver.ts:18-50`
- Modify: concrete drivers under `src/runtime/agents/` whose capability advertises `terminal-input`
- Modify: `src/coordinator/prompt-run-workflow.ts:213-246`
- Modify: `src/coordinator/pane-control-workflow.ts:1-80`
- Modify: `src/main.ts:130-140`
- Test: `tests/agent-driver-contract.test.ts`
- Test: `tests/steering-integration.test.ts`
- Test: `tests/card-interaction-integration.test.ts`

**Interfaces:**
- Consumes: `AgentCapabilities.steering` and existing durable steering rejection paths.
- Produces: no `HerdrPort.steerPrompt`; runtime drivers return `{ status: "unsupported" }` without terminal mutation.

- [ ] **Step 1: Add failing capability and no-input tests**

Add contract coverage such as:

```ts
it("reports TraeX steering as unsupported without touching Herdr", async () => {
  const steerPrompt = vi.fn();
  const driver = new TraexDriver({ steerPrompt } as unknown as HerdrPort, "traex", 1_000);
  expect(driver.describe().steering).toBe("unsupported");
  await expect(driver.steer(runtime, "change course")).resolves.toEqual({ status: "unsupported" });
  expect(steerPrompt).not.toHaveBeenCalled();
});
```

Update workflow tests to prove explicit and automatic steering failures remain visible and never convert to ordinary prompts. Assert no `pane send-text` or `pane send-keys` command is emitted.

- [ ] **Step 2: Run steering tests and verify they fail**

Run: `npx vitest run tests/agent-driver-contract.test.ts tests/steering-integration.test.ts tests/card-interaction-integration.test.ts`

Expected: TraeX currently advertises and invokes terminal steering.

- [ ] **Step 3: Remove raw steering from the Herdr boundary**

Delete `steerPrompt` from `HerdrPort`, `HerdrCliAdapter`,
`WorkspaceSnapshotCache`, and `HerdrCircuitBreaker`. Remove it from the Herdr
dependency slices accepted by `PromptRunWorkflow` and `PaneControlWorkflow`. Set
affected driver capabilities to:

```ts
steering: "unsupported"
```

and make driver `steer` return `{ status: "unsupported" }` without consulting
Herdr. For automatic Lark continuation classification, keep the candidate prompt
as ordinary FIFO work instead of creating a steering row when the runtime has no
steering capability. For explicit `/swarm steer`, reject before accepting a Pane
control operation and render the existing rejection card. If a durable steering
row from an older build is recovered, mark it rejected without terminal input.
Wire the narrowed coordinator dependencies in `src/main.ts`.

- [ ] **Step 4: Remove prompt-only composer parsing where safe**

Run: `rg -n "activeTraexComposer|composer_not_empty|normalizePromptEcho|countOccurrences" src/adapters/herdr-adapter.ts`

Delete `activeTraexComposer` and `composer_not_empty` behavior if only removed prompt/steering paths consume them. If model control still needs `normalizePromptEcho`, retain that smaller helper. Keep `submitPromptText` only for explicit Pane/model commands and simplify it back to the minimum confirmation required by those commands; do not broaden this task into model-selection redesign.

- [ ] **Step 5: Run steering and model-selection regression tests**

Run: `npx vitest run tests/agent-driver-contract.test.ts tests/steering-integration.test.ts tests/card-interaction-integration.test.ts tests/model-command-integration.test.ts tests/herdr-adapter.test.ts`

Expected: steering is visibly unsupported, no steering path mutates terminal input, and `/model` tests remain green.

- [ ] **Step 6: Commit steering removal**

```bash
git add src/adapters/herdr-adapter.ts src/domain/ports.ts src/runtime/workspace-snapshot-cache.ts src/runtime/herdr-circuit-breaker.ts src/runtime/agents src/coordinator/prompt-run-workflow.ts src/coordinator/pane-control-workflow.ts src/main.ts tests/agent-driver-contract.test.ts tests/steering-integration.test.ts tests/card-interaction-integration.test.ts tests/model-command-integration.test.ts
git commit -m "refactor: disable raw terminal steering"
```

### Task 4: Align operational documentation and verify the complete change

**Files:**
- Modify: `docs/architecture.md:250-280,319-345,407-425,580-620`
- Modify: `docs/feishu-group-usage.md` sections describing steering availability
- Verify: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: the strict startup, prompt submission, and unsupported-steering behavior from Tasks 1-3.
- Produces: implementation-backed operator documentation and deployment evidence.

- [ ] **Step 1: Update architecture authority**

Document these exact operational rules:

```text
TraeX is launched with TRAEX_BIN through pane run and must be detected by Herdr
as a Codex-compatible Agent before dispatch. Ordinary turns use agent prompt
only. Terminal observations are not prompt-delivery acknowledgement. Raw
terminal steering is unsupported.
```

Remove statements that claim prompt echo confirmation is a supported terminal-content operation. Keep terminal reads documented only for model selection, local approval diagnostics, telemetry, and bounded unknown-state compatibility where still implemented.

- [ ] **Step 2: Update user-facing steering guidance**

Change `/swarm steer` documentation to state that runtimes without structured steering reject the operation visibly and never turn it into an ordinary queued prompt. Do not promise terminal injection for TraeX.

- [ ] **Step 3: Run focused workflow verification**

Run:

```bash
npx vitest run tests/herdr-adapter.test.ts tests/agent-driver-contract.test.ts tests/instance-control.integration.test.ts tests/instance-messaging.integration.test.ts tests/steering-integration.test.ts tests/card-interaction-integration.test.ts tests/model-command-integration.test.ts
```

Expected: all selected files pass.

- [ ] **Step 4: Run the full repository gate**

Run: `npm test`

Expected: all Vitest files and tests pass.

Run: `npm run typecheck`

Expected: TypeScript exits zero without emitting.

Run: `npm run build`

Expected: TypeScript compilation and build identity generation exit zero.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Perform a non-mutating live compatibility check**

Run `herdr api snapshot` and `herdr pane process-info --pane <known-traex-pane>` against a known existing TraeX pane. Confirm the process executable is `traex` and Herdr reports that same Pane as `agent="codex"`. Do not send a real prompt, restart a Pane, or alter a running session during this check.

- [ ] **Step 6: Commit documentation and final verification state**

```bash
git add docs/architecture.md docs/feishu-group-usage.md
git commit -m "docs: require native Herdr prompt delivery"
```

- [ ] **Step 7: Inspect service state before any deployment**

Run: `herdr plugin action invoke status --plugin herdr-lark-bridge`

Require a bounded status response and inspect queued prompts, active turns, instance turns, and pending outbox. Do not restart automatically as part of plan execution. Report whether deployment is safe and request explicit deployment authorization if a restart is still desired.
