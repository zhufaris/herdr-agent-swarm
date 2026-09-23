import { describe, expect, it } from "vitest";
import { RuntimeLifecycleLedger } from "../src/runtime/lifecycle-ledger.js";

describe("RuntimeLifecycleLedger", () => {
  it("builds a safety-staged plan with reverse registration order inside each stage", () => {
    const ledger = new RuntimeLifecycleLedger();
    const stop = async () => {};
    ledger.register({ name: "health", stage: "health", kind: "non-writer", stop });
    ledger.register({ name: "publisher", stage: "projections", kind: "writer", stop });
    ledger.register({ name: "projector", stage: "projections", kind: "writer", stop });
    ledger.register({ name: "primary-tools", stage: "ingress", kind: "writer", stop });
    ledger.register({ name: "socket", stage: "ingress", kind: "non-writer", stop });

    expect(ledger.shutdownPlan().map(({ name }) => name)).toEqual([
      "socket", "primary-tools", "projector", "publisher", "health"
    ]);
  });

  it("rejects duplicate cleanup ownership", () => {
    const ledger = new RuntimeLifecycleLedger();
    const entry = { name: "publisher", stage: "projections" as const, kind: "writer" as const, stop: async () => {} };
    ledger.register(entry);

    expect(() => ledger.register(entry)).toThrow("Lifecycle cleanup already registered: publisher");
  });

  it("registers cleanup before startup and retains it when startup fails", async () => {
    const ledger = new RuntimeLifecycleLedger();
    const calls: string[] = [];
    const entry = {
      name: "publisher",
      stage: "projections" as const,
      kind: "writer" as const,
      stop: async () => { calls.push("stop"); }
    };

    await expect(ledger.start(entry, async () => {
      calls.push(ledger.shutdownPlan().some(({ name }) => name === "publisher") ? "registered" : "missing");
      throw new Error("startup failed");
    })).rejects.toThrow("startup failed");

    expect(calls).toEqual(["registered"]);
    expect(ledger.shutdownPlan()).toEqual([entry]);
  });

  it("returns the resource created during startup", async () => {
    const ledger = new RuntimeLifecycleLedger();
    const resource = { close: async () => {} };

    expect(ledger.start({
      name: "health",
      stage: "health",
      kind: "non-writer",
      stop: async () => {}
    }, () => resource)).toBe(resource);
  });

  it("keeps an asynchronous resource handle inside its registered cleanup", async () => {
    const ledger = new RuntimeLifecycleLedger();
    const calls: string[] = [];
    const resource = { id: "health-server" };

    await expect(ledger.startResource({
      name: "health",
      stage: "health",
      kind: "non-writer",
      start: async () => resource,
      stop: async (started) => { calls.push(`stop:${started.id}`); }
    })).resolves.toBe(resource);
    await ledger.shutdownPlan()[0]!.stop({ signal: new AbortController().signal, deadlineAt: Date.now(), remainingMs: () => 0 });

    expect(calls).toEqual(["stop:health-server"]);
  });
});
