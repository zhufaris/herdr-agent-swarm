import { describe, expect, it } from "vitest";
import { AgentInputCapabilityGate } from "../src/runtime/agent-input-capability.js";
import type { AgentInputCorePort } from "../src/domain/ports/agent-input.js";

describe("AgentInputCapabilityGate", () => {
  it("fails closed when the configured route requires unavailable Core Agent Input v3", async () => {
    const gate = new AgentInputCapabilityGate(coreWithCapability(false), true);

    await gate.detect();

    expect(gate.snapshot()).toEqual({
      required: true,
      detected: true,
      supported: false,
      ready: false,
      error: "Herdr Core does not advertise agent_input_submission_v3"
    });
  });

  it("reports absence without failing readiness before the new route is enabled", async () => {
    const gate = new AgentInputCapabilityGate(coreWithCapability(false), false);

    await gate.detect();

    expect(gate.snapshot()).toEqual({
      required: false,
      detected: true,
      supported: false,
      ready: true,
      error: null
    });
  });

  it("keeps v3 readiness available when only typed choice submission is absent", async () => {
    const gate = new AgentInputCapabilityGate({
      async capabilities() {
        return { agentInputSubmissionV2: true, agentInputSubmissionV3: true, agentInputTypedMessageV1: false };
      },
      async submit() { throw new Error("must not submit during capability detection"); },
      async queryReceipt() { throw new Error("must not query during capability detection"); }
    }, true);

    await gate.detect();

    expect(gate.snapshot()).toEqual({
      required: true,
      detected: true,
      supported: true,
      ready: true,
      error: null
    });
  });
});

function coreWithCapability(supported: boolean): AgentInputCorePort {
  return {
    async capabilities() { return { agentInputSubmissionV2: supported, agentInputSubmissionV3: supported }; },
    async submit() { throw new Error("must not submit during capability detection"); },
    async queryReceipt() { throw new Error("must not query during capability detection"); }
  };
}
