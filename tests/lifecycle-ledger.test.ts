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
});
