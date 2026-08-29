import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { TraexDriver } from "../src/runtime/agents/traex-driver.js";
import { CodexDriver } from "../src/runtime/agents/codex-driver.js";
import { ClaudeCodeDriver } from "../src/runtime/agents/claude-code-driver.js";
import { PiDriver } from "../src/runtime/agents/pi-driver.js";
import type { HerdrPort } from "../src/domain/ports.js";
import { detectAgentRuntimeAvailability, discoverExecutable } from "../src/runtime/agents/agent-availability.js";

const runtime = { herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null, generation: 1 };

describe("agent driver contract", () => {
  it("registers drivers by stable agent kind and reports missing drivers", () => {
    const driver = new TraexDriver({} as HerdrPort, "traex", 1_000);
    const registry = new AgentDriverRegistry([driver]);
    expect(registry.get("traex")).toBe(driver);
    expect(registry.get("codex")).toBeNull();
    expect(registry.describe("codex")).toMatchObject({ available: false });
  });

  it("launches TraeX and declares its verified capabilities", async () => {
    const startAgent = vi.fn(async () => undefined);
    const driver = new TraexDriver({ startAgent } as unknown as HerdrPort, "/bin/traex", 1_000);
    expect(driver.describe()).toMatchObject({ available: true, primaryTools: true, steering: "unsupported", approvals: "terminal" });
    await driver.start(runtime, { projectId: "demo", name: "primary", model: null });
    expect(startAgent).toHaveBeenCalledWith("w1:p1", { name: "demo-primary", kind: "traex", executable: "/bin/traex", args: [] });
  });

  it("injects the scoped MCP server into capable Primary drivers only", async () => {
    const startAgent = vi.fn(async () => undefined);
    const traex = new TraexDriver({ startAgent } as unknown as HerdrPort, "traex", 1_000);
    const primaryTools = { command: process.execPath, args: ["shim.js", "--instance", "primary"] };
    await traex.start(runtime, { name: "primary", model: null, primaryTools });
    expect(startAgent).toHaveBeenCalledWith("w1:p1", { name: "agent-primary", kind: "traex", executable: "traex", args: ["-c", expect.stringMatching(/^mcp_servers\.herdr_agent_swarm\.command=.*$/), "-c", expect.stringMatching(/^mcp_servers\.herdr_agent_swarm\.args=.*$/), "-c", expect.stringMatching(/^mcp_servers\.herdr_agent_swarm\.env_vars=.*$/)] });

    const codexStartAgent = vi.fn(async () => undefined);
    const codex = new CodexDriver({ startAgent: codexStartAgent } as unknown as HerdrPort, "codex", 1_000, true);
    await codex.start(runtime, { name: "primary", model: null, primaryTools });
    expect(codexStartAgent).toHaveBeenCalledWith("w1:p1", expect.objectContaining({ args: ["-c", expect.stringContaining("mcp_servers.herdr_agent_swarm.command"), "-c", expect.stringContaining("mcp_servers.herdr_agent_swarm.args"), "-c", expect.stringContaining("SWARM_PRIMARY_CAPABILITY")] }));
  });

  it("returns an uncertain receipt when a submitted prompt may have reached TraeX", async () => {
    const runPrompt = vi.fn(async (_pane: string, _text: string, _timeout: number, _observation: unknown, _signal: unknown, onDispatched: () => void) => {
      onDispatched();
      throw new Error("observer disconnected");
    });
    const driver = new TraexDriver({ runPrompt } as unknown as HerdrPort, "traex", 1_000);

    await expect(driver.submit(runtime, "do work")).resolves.toEqual({ status: "delivery-uncertain", reason: "observer disconnected" });
  });

  it("submits TraeX instance turns through Herdr's Agent prompt surface", async () => {
    const runPrompt = vi.fn(async (_pane: string, _text: string, _timeout: number, _observation: unknown, _signal: unknown, onDispatched: () => void) => { onDispatched(); return "done" as const; });
    const driver = new TraexDriver({ runPrompt } as unknown as HerdrPort, "traex", 1_000);

    await expect(driver.submit(runtime, "do work")).resolves.toEqual({ status: "confirmed-delivered" });
    expect(runPrompt).toHaveBeenCalledWith("w1:p1", "do work", 1_000, undefined, undefined, expect.any(Function));
  });

  it("reports TraeX steering as unsupported without touching Herdr", async () => {
    const steerPrompt = vi.fn();
    const driver = new TraexDriver({ steerPrompt } as unknown as HerdrPort, "traex", 1_000);

    await expect(driver.steer(runtime, "change course")).resolves.toEqual({ status: "unsupported" });
    expect(steerPrompt).not.toHaveBeenCalled();
  });

  it("reports a confirmed non-delivery when submission fails before dispatch", async () => {
    const runPrompt = vi.fn(async () => { throw new Error("agent unavailable"); });
    const driver = new TraexDriver({ runPrompt } as unknown as HerdrPort, "traex", 1_000);

    await expect(driver.submit(runtime, "do work")).resolves.toEqual({ status: "not-delivered", reason: "agent unavailable" });
  });

  it.each([
    ["codex", CodexDriver, "codex", ["--model", "chosen-model"], { structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }],
    ["claude-code", ClaudeCodeDriver, "claude", ["--model", "chosen-model"], { structuredEvents: true, nativeResume: true, primaryTools: false, steering: "unsupported", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }],
    ["pi", PiDriver, "pi", [], { structuredEvents: false, nativeResume: false, primaryTools: false, steering: "unsupported", approvals: "terminal", modelSelection: "unsupported", usageReporting: false }]
  ] as const)("starts the %s driver through Herdr with exact capabilities", async (_label, Driver, herdrKind, expectedArgs, capabilities) => {
    const startAgent = vi.fn(async () => undefined);
    const driver = new Driver({ startAgent } as unknown as HerdrPort, `/bin/${herdrKind}`, 1_000, true);
    expect(driver.describe()).toMatchObject({ available: true, ...capabilities });
    await driver.start(runtime, { projectId: "p1", name: "reviewer", model: "chosen-model" });
    expect(startAgent).toHaveBeenCalledWith("w1:p1", expect.objectContaining({ name: "p1-reviewer", kind: herdrKind, executable: `/bin/${herdrKind}`, args: expectedArgs }));
  });

  it.each([CodexDriver, ClaudeCodeDriver, PiDriver])("does not start an unavailable adapter", async (Driver) => {
    const startAgent = vi.fn();
    const driver = new Driver({ startAgent } as unknown as HerdrPort, "missing", 1_000, false);
    expect(driver.describe().available).toBe(false);
    await expect(driver.start(runtime, { name: "worker", model: null })).rejects.toThrow(/unavailable/);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("preserves no-replay semantics for a Codex prompt that may have been delivered", async () => {
    const runPrompt = vi.fn(async (_pane: string, _text: string, _timeout: number, _observation: unknown, _signal: unknown, onDispatched: () => void) => { onDispatched(); throw new Error("lost observer"); });
    const driver = new CodexDriver({ runPrompt } as unknown as HerdrPort, "codex", 1_000, true);
    await expect(driver.submit(runtime, "do work")).resolves.toEqual({ status: "delivery-uncertain", reason: "lost observer" });
  });

  it("reports unsupported steering explicitly for Pi", async () => {
    const driver = new PiDriver({} as HerdrPort, "pi", 1_000, true);
    await expect(driver.steer(runtime, "change course")).resolves.toEqual({ status: "unsupported" });
  });

  it("requires both an executable and Herdr agent-kind support for availability", async () => {
    expect(discoverExecutable("codex", "/missing")).toBeNull();
    const runner = { run: vi.fn(async () => ({ stdout: "possible values: pi|claude|codex", stderr: "" })) };
    await expect(detectAgentRuntimeAvailability({ runner, herdrExecutable: "herdr", agentExecutable: process.execPath, herdrKind: "codex", pathValue: "" })).resolves.toBe(true);
    await expect(detectAgentRuntimeAvailability({ runner, herdrExecutable: "herdr", agentExecutable: "missing", herdrKind: "codex", pathValue: "/missing" })).resolves.toBe(false);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it.each(["codex", "claude-code", "pi"])("keeps a bounded non-secret lifecycle fixture for %s", (kind) => {
    const fixture = JSON.parse(readFileSync(new URL(`./agent-driver-fixtures/${kind}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    expect(fixture).toMatchObject({ agentKind: kind, states: ["idle", "working", "blocked", "done", "unknown"] });
    expect(JSON.stringify(fixture)).not.toMatch(/token|secret|open_id|sessionId/i);
  });
});
