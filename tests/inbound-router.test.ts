import { describe, expect, it, vi } from "vitest";
import { InboundRouter } from "../src/coordinator/inbound-router.js";

describe("InboundRouter shutdown", () => {
  it("closes card admission before stopping Lark and waits for admitted callbacks before downstream writers", async () => {
    const calls: string[] = [];
    let releaseCallbacks!: () => void;
    const callbacks = new Promise<void>((resolve) => { releaseCallbacks = resolve; });
    const router = new InboundRouter({
      gatewayIngress: { async stop() { calls.push("gateway"); } },
      startupRecovery: { async start() {}, async stop() { calls.push("startup"); }, snapshot: () => ({}) },
      inboundDispatcher: { async stop() { calls.push("messages"); }, snapshot: () => ({}) },
      cardActionRouter: { async handle() {}, stop() { calls.push("card-gate"); return callbacks.then(() => { calls.push("callbacks-drained"); }); } },
      swarmCommands: { async stop() { calls.push("commands"); } },
      retiredPaneCleanup: { async stop() { calls.push("retired"); } },
      reconciler: { async stop() { calls.push("reconciler"); } },
      promptRun: { async stop() { calls.push("prompts"); } },
      sessionOperations: { async stop() { calls.push("sessions"); } }
    } as never);

    let stopped = false;
    const stopping = router.stop().then(() => { stopped = true; });
    await vi.waitFor(() => expect(calls).toEqual(["startup", "card-gate", "gateway", "messages"]));
    expect(stopped).toBe(false);
    expect(calls).not.toContain("commands");

    releaseCallbacks();
    await stopping;
    expect(calls.indexOf("callbacks-drained")).toBeLessThan(calls.indexOf("commands"));
  });
});
