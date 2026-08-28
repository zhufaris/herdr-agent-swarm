import { describe, expect, it, vi } from "vitest";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { TraexDriver } from "../src/runtime/agents/traex-driver.js";
import type { HerdrPort } from "../src/domain/ports.js";

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
    const startTraex = vi.fn(async () => undefined);
    const driver = new TraexDriver({ startTraex } as unknown as HerdrPort, "/bin/traex", 1_000);
    expect(driver.describe()).toMatchObject({ available: true, primaryTools: true, steering: "terminal-input", approvals: "terminal" });
    await driver.start(runtime);
    expect(startTraex).toHaveBeenCalledWith("w1:p1", "/bin/traex");
  });

  it("returns an uncertain receipt when a submitted prompt may have reached TraeX", async () => {
    const runPrompt = vi.fn(async (_pane: string, _text: string, _timeout: number, _observation: unknown, _signal: unknown, onDispatched: () => void) => {
      onDispatched();
      throw new Error("observer disconnected");
    });
    const driver = new TraexDriver({ runPrompt } as unknown as HerdrPort, "traex", 1_000);

    await expect(driver.submit(runtime, "do work")).resolves.toEqual({ status: "delivery-uncertain", reason: "observer disconnected" });
  });

  it("reports a confirmed non-delivery when submission fails before dispatch", async () => {
    const runPrompt = vi.fn(async () => { throw new Error("agent unavailable"); });
    const driver = new TraexDriver({ runPrompt } as unknown as HerdrPort, "traex", 1_000);

    await expect(driver.submit(runtime, "do work")).resolves.toEqual({ status: "not-delivered", reason: "agent unavailable" });
  });
});
