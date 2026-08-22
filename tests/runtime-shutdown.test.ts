import { describe, expect, it } from "vitest";
import { BridgeRuntimeShutdown } from "../src/runtime/shutdown.js";

describe("bridge runtime shutdown", () => {
  it("waits for async components and closes the store last", async () => {
    const calls: string[] = [];
    let releaseProjector!: () => void;
    const projectorBlocked = new Promise<void>((resolve) => { releaseProjector = resolve; });
    const runtime = new BridgeRuntimeShutdown({
      coordinator: { async stop() { calls.push("coordinator"); } },
      projector: { async stop() { calls.push("projector:start"); await projectorBlocked; calls.push("projector:end"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { close() { calls.push("store"); } },
      logger: { info() {}, error() {} }
    });

    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["coordinator", "projector:start"]);

    releaseProjector();
    await Promise.all([first, second]);

    expect(calls).toEqual(["coordinator", "projector:start", "projector:end", "publisher", "health", "lease", "store"]);
  });

  it("continues releasing resources when an earlier stop fails", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const runtime = new BridgeRuntimeShutdown({
      coordinator: { async stop() { calls.push("coordinator"); throw new Error("coordinator failed"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { close() { calls.push("store"); } },
      logger: { info() {}, error(value) { errors.push(String(value.component)); } }
    });

    await runtime.shutdown("SIGTERM");

    expect(calls).toEqual(["coordinator", "projector", "publisher", "health", "lease", "store"]);
    expect(errors).toEqual(["coordinator"]);
  });
});
