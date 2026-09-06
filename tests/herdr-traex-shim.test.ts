import { describe, expect, it, vi } from "vitest";
import { encodeLaunchRequest, parseHerdrShimInvocation, pollingDelay, projectTraexAgentJson, runHerdrTraexPrompt, runHerdrTraexStart, runHerdrTraexSteer, TraexStartError } from "../src/runtime/herdr-traex-shim.js";

describe("Herdr TraeX shim invocation", () => {
  it.each([
    [["agent", "start", "reviewer", "--kind", "codex", "--pane", "w1:p1"]],
    [["--session", "test", "agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"]],
    [["--remote", "host", "agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"]]
  ])("delegates non-exact invocation %j unchanged", (argv) => {
    expect(parseHerdrShimInvocation(argv)).toEqual({ kind: "delegate", argv });
  });

  it.each([
    [["agent", "list"]],
    [["agent", "get", "reviewer"]],
    [["agent", "prompt", "reviewer", "hello"]],
    [["pane", "list"]],
    [["api", "snapshot"]]
  ])("projects local agent-bearing JSON for %j", (argv) => {
    expect(parseHerdrShimInvocation(argv)).toEqual({ kind: "project", argv });
  });

  it("intercepts only a local prompt wait with a valid timeout", () => {
    expect(parseHerdrShimInvocation(["agent", "prompt", "reviewer", "hello", "--wait", "--timeout", "120000"])).toEqual({
      kind: "prompt-traex", target: "reviewer", text: "hello", argv: ["agent", "prompt", "reviewer", "hello", "--wait", "--timeout", "120000"],
      timeoutMs: 120000, until: []
    });
    expect(parseHerdrShimInvocation(["agent", "prompt", "reviewer", "hello"])).toEqual({ kind: "project", argv: ["agent", "prompt", "reviewer", "hello"] });
    expect(parseHerdrShimInvocation(["agent", "prompt", "reviewer", "hello", "--wait", "--timeout", "invalid"])).toEqual({ kind: "project", argv: ["agent", "prompt", "reviewer", "hello", "--wait", "--timeout", "invalid"] });
  });

  it("parses the exact local TraeX start and preserves trailing argv", () => {
    expect(parseHerdrShimInvocation([
      "agent", "start", "reviewer", "--pane", "w1:p1", "--kind", "traex", "--timeout", "45000",
      "--", "--model", "GPT 5", "--config=x=y"
    ])).toEqual({
      kind: "start-traex", name: "reviewer", paneId: "w1:p1", timeoutMs: 45000,
      traexArgs: ["--model", "GPT 5", "--config=x=y"]
    });
  });

  it("defaults the timeout to the native 30 seconds", () => {
    expect(parseHerdrShimInvocation(["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1"])).toMatchObject({ timeoutMs: 30000 });
  });

  it("parses exact-turn native steering without losing text boundaries", () => {
    expect(parseHerdrShimInvocation([
      "agent", "steer", "reviewer", "focus on generation fencing",
      "--turn-id", "turn-42", "--idempotency-key", "message:123", "--agent-session", '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"session-1"}', "--timeout", "2500"
    ])).toEqual({
      kind: "steer-traex", target: "reviewer", text: "focus on generation fencing",
      turnId: "turn-42", idempotencyKey: "message:123", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, timeoutMs: 2500
    });
  });

  it("parses a session-fenced model catalog request", () => {
    expect(parseHerdrShimInvocation([
      "agent", "model-list", "reviewer", "--agent-session",
      '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"01a03eb1-c193-7531-83c0-e6c6f70143d4"}',
      "--timeout", "2500"
    ])).toEqual({
      kind: "model-list-traex", target: "reviewer", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" }, timeoutMs: 2500
    });
  });

  it("parses two-phase model prompt commands without losing prompt boundaries", () => {
    const digest = "a".repeat(64);
    const session = '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"01a03eb1-c193-7531-83c0-e6c6f70143d4"}';
    expect(parseHerdrShimInvocation(["agent", "model-prompt", "prepare", "reviewer", "--model", "GPT-5.4", "--model-revision", "3", "--prompt-sha256", digest, "--agent-session", session, "--timeout", "2500"])).toMatchObject({ kind: "model-prompt-prepare", target: "reviewer", model: "GPT-5.4", revision: 3, promptSha256: digest, timeoutMs: 2500 });
    expect(parseHerdrShimInvocation(["agent", "model-prompt", "commit", "b".repeat(64), "hello world", "--prompt-sha256", digest, "--timeout", "2500"])).toEqual({ kind: "model-prompt-commit", operationId: "b".repeat(64), text: "hello world", promptSha256: digest, timeoutMs: 2500 });
    expect(parseHerdrShimInvocation(["agent", "model-prompt", "abort", "b".repeat(64), "--timeout", "2500"])).toEqual({ kind: "model-prompt-abort", operationId: "b".repeat(64), timeoutMs: 2500 });
  });

  it.each([
    [["agent", "model-list", "reviewer"], /agent-session/],
    [["agent", "model-list", "reviewer", "--agent-session", '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"not-a-uuid"}'], /session/i]
  ])("rejects an unfenced model catalog invocation %j", (argv, error) => {
    expect(() => parseHerdrShimInvocation(argv)).toThrow(error);
  });

  it.each([
    [["agent", "steer", "reviewer", "text", "--idempotency-key", "key"], /turn-id/],
    [["agent", "steer", "reviewer", "text", "--turn-id", "turn-1"], /idempotency-key/],
    [["agent", "steer", "reviewer", "text", "--turn-id", "turn-1", "--idempotency-key", "key"], /agent-session/],
    [["agent", "steer", "reviewer", "text", "--turn-id", "turn-1", "--idempotency-key", "key", "--timeout", "0"], /timeout/]
  ])("rejects unsafe native steering invocation %j", (argv, error) => {
    expect(() => parseHerdrShimInvocation(argv)).toThrow(error);
  });

  it.each([
    '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"session-1","extra":true}',
    '{"source":1,"agent":"traex","kind":"id","value":"session-1"}',
    "not-json"
  ])("rejects malformed steering Agent session %s", (session) => {
    expect(() => parseHerdrShimInvocation(["agent", "steer", "reviewer", "text", "--turn-id", "turn-1", "--idempotency-key", "key", "--agent-session", session])).toThrow(/Agent session is invalid/);
  });

  it("projects only explicitly marked managed TraeX agents", () => {
    expect(projectTraexAgentJson({ result: { agents: [
      { agent: "codex", display_agent: "traex", name: "managed" },
      { agent: "codex", name: "native" }
    ] } })).toEqual({ result: { agents: [
      { agent: "traex", display_agent: "traex", name: "managed" },
      { agent: "codex", name: "native" }
    ] } });
  });

  it("projects Herdr's native Codex session identity into the shim-owned TraeX identity", () => {
    expect(projectTraexAgentJson({ result: { agents: [
      { agent: "codex", display_agent: "traex", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" } },
      { agent: "codex", agent_session: { source: "codex-hook", agent: "codex", kind: "id", value: "session-2" } }
    ] } })).toEqual({ result: { agents: [
      { agent: "traex", display_agent: "traex", agent_session: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" } },
      { agent: "codex", agent_session: { source: "codex-hook", agent: "codex", kind: "id", value: "session-2" } }
    ] } });
  });

  it.each([
    [["agent", "start", "--kind", "traex", "--pane", "w1:p1"], /name/],
    [["agent", "start", "reviewer", "--kind", "traex"], /pane/],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--pane", "w1:p2"], /duplicate.*pane/i],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--timeout", "0"], /timeout/],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--timeout", "300001"], /timeout/],
    [["agent", "start", "reviewer", "--kind", "traex", "--pane", "w1:p1", "--bogus"], /unknown/i],
    [["agent", "start", "reviewer", "--kind", "traex", "--kind", "traex", "--pane", "w1:p1"], /duplicate.*kind/i]
  ])("rejects malformed exact TraeX start %j", (argv, error) => {
    expect(() => parseHerdrShimInvocation(argv)).toThrow(error);
  });

});

describe("Herdr TraeX native steering delegation", () => {
  const invocation = parseHerdrShimInvocation([
    "agent", "steer", "reviewer", "private steer",
    "--turn-id", "turn-42", "--idempotency-key", "message:123",
    "--agent-session", '{"source":"herdr-traex-shim","agent":"traex","kind":"id","value":"session-1"}',
    "--timeout", "2500"
  ]);
  const rawAgent = {
    pane_id: "w1:p1", display_agent: "traex", agent: "codex", agent_status: "working",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" }
  };

  it("fails fast without dispatch when real Herdr has no exact-turn steer command", async () => {
    if (invocation.kind !== "steer-traex") throw new Error("invalid fixture");
    const dispatch = vi.fn();
    const result = await runHerdrTraexSteer(invocation, {
      inspectAgent: async () => rawAgent,
      inspectAgentCommands: async () => "herdr agent commands:\n  herdr agent prompt <target> <text>\n",
      dispatch
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { type: "agent_steered", status: "unsupported" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("delegates once with the unprojected native session when real Herdr supports steering", async () => {
    if (invocation.kind !== "steer-traex") throw new Error("invalid fixture");
    const dispatch = vi.fn(async () => ({ exitCode: 0, stdout: envelope({ type: "agent_steered", status: "delivered", turnId: "turn-42" }), stderr: "" }));
    await runHerdrTraexSteer(invocation, {
      inspectAgent: async () => rawAgent,
      inspectAgentCommands: async () => "herdr agent commands:\n  herdr agent steer <target> <text>\n",
      dispatch
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith([
      "agent", "steer", "reviewer", "private steer", "--turn-id", "turn-42",
      "--idempotency-key", "message:123", "--agent-session",
      '{"source":"herdr:codex","agent":"codex","kind":"id","value":"session-1"}', "--timeout", "2500"
    ], 2500);
  });

  it("rejects a stale projected session before capability discovery or dispatch", async () => {
    if (invocation.kind !== "steer-traex") throw new Error("invalid fixture");
    const inspectAgentCommands = vi.fn();
    const dispatch = vi.fn();
    const result = await runHerdrTraexSteer(invocation, {
      inspectAgent: async () => ({ ...rawAgent, agent_session: { ...rawAgent.agent_session, value: "session-2" } }),
      inspectAgentCommands,
      dispatch
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { status: "not-active" } });
    expect(inspectAgentCommands).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("Herdr TraeX prompt transcript settlement", () => {
  const completed = { turnId: "01a06b5e-2a25-7c53-b12e-ed02181a4e0e", freshTurnStart: true, answerDelta: "HERDR_082_OK", turnLifecycle: { turnId: "01a06b5e-2a25-7c53-b12e-ed02181a4e0e", state: "completed" as const, startedAt: "2026-09-04T08:00:00.000Z", finalAnswer: "HERDR_082_OK" } };

  it("converts a stalled short completed turn to success without replaying", async () => {
    const fixture = promptFixture([completed]);
    const result = await runHerdrTraexPrompt(promptInput(), fixture.dependencies);
    expect(result).toMatchObject({ exitCode: 0, result: { agent: { agent_status: "idle" } } });
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it("waits for the exact fresh active turn to complete", async () => {
    const turn = completed.turnLifecycle.turnId;
    const fixture = promptFixture([
      { turnId: turn, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: turn, state: "active" as const, startedAt: completed.turnLifecycle.startedAt } },
      { turnId: turn, answerDelta: "done", turnLifecycle: completed.turnLifecycle }
    ]);
    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({ exitCode: 0 });
    expect(fixture.submit).toHaveBeenCalledOnce();
    expect(fixture.sleep).toHaveBeenCalled();
  });

  it("waits past unrelated transcript observations for the fresh turn", async () => {
    const fixture = promptFixture([{ answerDelta: "" }, completed]);
    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({ exitCode: 0 });
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it("bounds the wait for a missing fresh turn independently of the command timeout", async () => {
    const fixture = promptFixture([{ answerDelta: "" }]);
    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("agent_prompt_not_started") });
    expect(fixture.submit).toHaveBeenCalledOnce();
    expect(fixture.sleep.mock.calls.length).toBeGreaterThan(0);
    expect(fixture.sleep.mock.calls.length).toBeLessThan(60);
  });

  it("clears the composer before submission and again after proving no turn started", async () => {
    const fixture = promptFixture([{ answerDelta: "" }]);
    const order: string[] = [];
    fixture.clearComposer.mockImplementation(async () => { order.push("ctrl+u"); });
    fixture.submit.mockImplementation(async () => {
      order.push("submit");
      return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_prompt_stalled" } }) };
    });

    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("agent_prompt_not_started")
    });
    expect(order).toEqual(["ctrl+u", "submit", "ctrl+u"]);
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it("does not submit when the exact session changes after pre-clear", async () => {
    const fixture = promptFixture([{ answerDelta: "" }]);
    fixture.currentAgent.mockResolvedValueOnce({
      agent: "traex", display_agent: "traex", agent_status: "idle",
      agent_session: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "01a06b5e-2a25-7c53-b12e-ed02181a4e0f" }
    });

    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({
      exitCode: 1, stderr: expect.stringContaining("agent_prompt_uncertain")
    });
    expect(fixture.clearComposer).toHaveBeenCalledOnce();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it.each(["working", "blocked", "unknown"] as const)("rejects a %s target without clearing or submitting", async (agentStatus) => {
    const fixture = promptFixture([{ answerDelta: "" }], { code: "agent_prompt_stalled" }, agentStatus);

    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({
      exitCode: 1, stderr: expect.stringContaining("agent_prompt_rejected")
    });
    expect(fixture.clearComposer).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("preserves uncertainty when pre-submission composer cleanup cannot be confirmed", async () => {
    const fixture = promptFixture([{ answerDelta: "" }]);
    fixture.clearComposer.mockRejectedValueOnce(new Error("lost response"));

    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({
      exitCode: 1, stderr: expect.stringContaining("agent_prompt_uncertain")
    });
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("preserves uncertainty when post-failure composer cleanup fails", async () => {
    const fixture = promptFixture([{ answerDelta: "" }]);
    fixture.clearComposer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("send keys failed"));

    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({
      exitCode: 1, stderr: expect.stringContaining("agent_prompt_stalled")
    });
    expect(fixture.clearComposer).toHaveBeenCalledTimes(2);
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it("preserves uncertainty when the session changes before post-failure cleanup", async () => {
    const fixture = promptFixture([{ answerDelta: "" }]);
    const original = await fixture.dependencies.resolveAgent("reviewer");
    fixture.currentAgent
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, agent_status: "working" });

    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({
      exitCode: 1, stderr: expect.stringContaining("agent_prompt_stalled")
    });
    expect(fixture.clearComposer).toHaveBeenCalledOnce();
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it.each([
    ["no fresh turn", [{ answerDelta: "" }]],
    ["old turn", [{ ...completed, turnLifecycle: { ...completed.turnLifecycle, startedAt: "2026-09-04T07:59:58.000Z" } }]]
  ])("reports no matching turn start for %s", async (_label, observations) => {
    const fixture = promptFixture(observations);
    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("agent_prompt_not_started") });
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it("preserves stalled when a second fresh turn makes settlement ambiguous", async () => {
    const fixture = promptFixture([completed, { ...completed, turnId: "01a06b5e-2a25-7c53-b12e-ed02181a4e0f", freshTurnStart: true, turnLifecycle: { ...completed.turnLifecycle, turnId: "01a06b5e-2a25-7c53-b12e-ed02181a4e0f" } }]);
    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("agent_prompt_stalled") });
  });

  it("passes explicit pre-dispatch errors through unchanged", async () => {
    const fixture = promptFixture([completed], { code: "agent_blocked" });
    await expect(runHerdrTraexPrompt(promptInput(), fixture.dependencies)).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("agent_blocked") });
    expect(fixture.openTranscript).toHaveBeenCalledOnce();
    expect(fixture.submit).toHaveBeenCalledOnce();
  });
});

describe("Herdr TraeX managed start", () => {
  it("backs off repeated startup probes with a one-second ceiling", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => pollingDelay(attempt))).toEqual([50, 100, 200, 400, 800, 1000, 1000, 1000]);
  });

  it("encodes executable and arguments without losing boundaries", () => {
    expect(encodeLaunchRequest("/opt/traex", ["--model", "GPT 5", "x=y"]).equals(
      Buffer.from("/opt/traex\0--model\0GPT 5\0x=y\0")
    )).toBe(true);
  });

  it.each([
    ["--session-id", "01a03eb1-c193-7531-83c0-e6c6f70143d4"],
    ["--session-id=01a03eb1-c193-7531-83c0-e6c6f70143d4"],
    ["--resume"],
    ["--resume=01a03eb1-c193-7531-83c0-e6c6f70143d4"]
  ])("rejects caller-owned TraeX session identity %j", async (...traexArgs) => {
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") return { stdout: "0.7.5", stderr: "" };
      return { stdout: envelope(processInfo(10, "bash", ["bash"])), stderr: "" };
    });
    await expect(runHerdrTraexStart({ ...startInput(), traexArgs }, startConfig(), dependencies)).rejects.toThrow(/session identity/i);
  });

  it("launches once, fences the process, and waits for managed identity", async () => {
    const calls: string[][] = [];
    let processReads = 0;
    let agentReads = 0;
    const reports: unknown[] = [];
    const result = await runHerdrTraexStart(
      { name: "reviewer", paneId: "w1:p1", timeoutMs: 1000, traexArgs: ["--model", "private model"] },
      { realHerdr: "/opt/herdr", traex: "/opt/traex", launcher: "/opt/shim/pane-launcher", reporter: "/opt/shim/reporter.js", requestDir: "/run/user/1/shim", sessionPeersDir: "/home/user/.trae/cli/session-peers", steeringOperationDir: "/home/user/.local/state/herdr-traex-shim/steering-operations", validatedHerdrVersion: "0.7.5" },
      {
        runHerdr: async (args) => {
          calls.push(args);
          if (args[0] === "--version") return { stdout: "herdr 0.7.5\n", stderr: "" };
          if (args[0] === "pane" && args[1] === "process-info") {
            processReads += 1;
            return { stdout: envelope(processReads === 1 ? processInfo(10, "bash", ["bash"]) : processInfo(44, "traex", ["/opt/traex"])), stderr: "" };
          }
          if (args[0] === "agent" && args[1] === "get") {
            agentReads += 1;
            expect(args[2]).toBe("reviewer");
            if (agentReads === 1) throw new Error("agent_not_found");
            return { stdout: envelope({ agent: { pane_id: "w1:p1", agent: "codex", display_agent: "traex", agent_status: agentReads > 1 ? "idle" : "unknown" } }), stderr: "" };
          }
          return { stdout: envelope({}), stderr: "" };
        },
        writeRequest: async (bytes) => { reports.push(bytes); return "abc-123"; },
        removeRequest: async () => undefined,
        processExecutable: async () => "/opt/traex",
        processStartTicks: async () => "987",
        startReporter: (input) => { reports.push(input); },
        sleep: async () => undefined,
        now: (() => { let now = 0; return () => ++now; })(),
        generateSessionId: () => "01a03eb1-c193-7531-83c0-e6c6f70143d4"
      }
    );

    expect(result).toMatchObject({ agent: { pane_id: "w1:p1", agent: "traex", agent_status: "idle" } });
    const launch = calls.filter((args) => args[0] === "pane" && args[1] === "run");
    expect(launch).toEqual([["pane", "run", "w1:p1", "/opt/shim/pane-launcher abc-123"]]);
    expect(launch[0]![3]).not.toContain("codex");
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "start")).toEqual([]);
    const request = (reports[0] as Buffer).toString("utf8").split("\0");
    expect(request.slice(0, 3)).toEqual(["/opt/traex", "--session-id", "01a03eb1-c193-7531-83c0-e6c6f70143d4"]);
    expect(request).not.toContainEqual(expect.stringContaining("hooks."));
    expect(request).not.toContain("--dangerously-bypass-hook-trust");
    expect(request.slice(-5)).toEqual(["--session-id", "01a03eb1-c193-7531-83c0-e6c6f70143d4", "--model", "private model", ""]);
    expect(reports[1]).toMatchObject({ paneId: "w1:p1", pid: 44, processStartTicks: "987", launchCorrelationId: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });
  });

  it("rejects a busy pane before writing or launching", async () => {
    let wrote = false;
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") return { stdout: "0.7.5", stderr: "" };
      return { stdout: envelope(processInfo(12, "vim", ["vim"])), stderr: "" };
    }, () => { wrote = true; });
    await expect(runHerdrTraexStart(startInput(), startConfig(), dependencies)).rejects.toThrow(/available shell/);
    expect(wrote).toBe(false);
  });

  it("marks failure after pane run as uncertain and never retries the launch", async () => {
    let launches = 0;
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") return { stdout: "0.7.5", stderr: "" };
      if (args[0] === "pane" && args[1] === "run") { launches += 1; return { stdout: envelope({}), stderr: "" }; }
      return { stdout: envelope(processInfo(10, "bash", ["bash"])), stderr: "" };
    });
    await expect(runHerdrTraexStart(startInput(), startConfig(), dependencies)).rejects.toMatchObject<TraexStartError>({ code: "agent_start_uncertain" });
    expect(launches).toBe(1);
  });

  it("preserves a bounded pre-launch cause without exposing TraeX arguments", async () => {
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") throw new Error(`socket unavailable ${"x".repeat(500)}`);
      return { stdout: "", stderr: "" };
    });
    await expect(runHerdrTraexStart({ ...startInput(), traexArgs: ["secret-prompt"] }, startConfig(), dependencies))
      .rejects.toThrow(/^TraeX did not start: socket unavailable x{1,240}$/);
  });

  it("treats a pane-run command error as uncertain because dispatch may have occurred", async () => {
    let launches = 0;
    const dependencies = fakeStartDependencies(async (args) => {
      if (args[0] === "--version") return { stdout: "0.7.5", stderr: "" };
      if (args[0] === "pane" && args[1] === "run") { launches += 1; throw new Error("connection lost"); }
      return { stdout: envelope(processInfo(10, "bash", ["bash"])), stderr: "" };
    });
    await expect(runHerdrTraexStart(startInput(), startConfig(), dependencies)).rejects.toMatchObject<TraexStartError>({ code: "agent_start_uncertain" });
    expect(launches).toBe(1);
  });
});

function envelope(result: unknown): string { return JSON.stringify({ id: "test", result }); }
function processInfo(pid: number, name: string, argv: string[]): object {
  return { process_info: { shell_pid: 10, foreground_processes: [{ pid, name, argv }] } };
}
function startInput() { return { name: "reviewer", paneId: "w1:p1", timeoutMs: 5, traexArgs: [] }; }
function startConfig() { return { realHerdr: "/opt/herdr", traex: "/opt/traex", launcher: "/opt/shim/pane-launcher", reporter: "/opt/shim/reporter.js", requestDir: "/run/user/1/shim", sessionPeersDir: "/home/user/.trae/cli/session-peers", steeringOperationDir: "/home/user/.local/state/herdr-traex-shim/steering-operations", validatedHerdrVersion: "0.7.5" }; }
function fakeStartDependencies(runHerdr: (args: string[]) => Promise<{ stdout: string; stderr: string }>, onWrite = () => undefined) {
  return { runHerdr, writeRequest: async () => { onWrite(); return "abc"; }, removeRequest: async () => undefined, processExecutable: async () => null, processStartTicks: async () => null, startReporter: () => undefined, sleep: async () => undefined, now: (() => { let now = 0; return () => ++now; })(), generateSessionId: () => "01a03eb1-c193-7531-83c0-e6c6f70143d4" };
}

function promptInput() {
  return { target: "reviewer", text: "secret prompt", argv: ["agent", "prompt", "reviewer", "secret prompt", "--wait", "--timeout", "120000"], timeoutMs: 120000, until: [] };
}

function promptFixture(observations: Array<Record<string, unknown>>, error: { code: string } = { code: "agent_prompt_stalled" }, agentStatus: "idle" | "done" | "working" | "blocked" | "unknown" = "idle") {
  const submit = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: JSON.stringify({ error }) }));
  const clearComposer = vi.fn(async () => undefined);
  const sleep = vi.fn(async () => undefined);
  const openTranscript = vi.fn(async (_session, _expectedPrompt) => {
    const queue = [...observations];
    return { mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return queue.shift() ?? { answerDelta: "" }; } } };
  });
  let now = Date.parse("2026-09-04T08:00:00.100Z");
  const agent = { agent: "traex", display_agent: "traex", agent_status: agentStatus, agent_session: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "01a06b5e-2a25-7c53-b12e-ed02181a4e0e" } };
  const currentAgent = vi.fn(async () => agent);
  return { submit, clearComposer, currentAgent, sleep, openTranscript, dependencies: {
    resolveAgent: async () => agent,
    openTranscript, clearComposer, submit, currentAgent,
    sleep, now: () => { now += 100; return now; }
  } };
}
