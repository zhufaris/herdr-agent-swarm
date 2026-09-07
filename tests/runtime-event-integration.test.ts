import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { RuntimeEventIntegration } from "../src/composition/runtime-event-integration.js";

describe("RuntimeEventIntegration", () => {
  it("names distinct reliability classes without exposing a generic publisher", () => {
    const events = new RuntimeEventIntegration(pino({ enabled: false }));
    events.registerInstanceWakeup(() => {});
    events.connectHerdrHints({ async handle() {} });
    events.seal();

    expect(events.snapshot()).toEqual({
      reliability: {
        inbound: "durable-record-plus-hint",
        lifecycle: "transactional-state-plus-fanout",
        work: "best-effort-wakeup",
        herdr: "bounded-reconciliation-hint"
      },
      lifecycle: { subscriberFailures: 0, lastFailureAt: null, lastFailedSubscriber: null }
    });
    expect(events).not.toHaveProperty("publish");
  });

  it("coalesces typed work hints before all consumers are wired", async () => {
    const instances: string[] = [];
    const prompts: string[] = [];
    const events = new RuntimeEventIntegration(pino({ enabled: false }));
    events.promptWork.subscribe((hint) => { prompts.push(hint.bindingId); });
    events.wakePrimary("binding-1");
    events.wakePrimary("binding-1");
    events.wakeInstance("instance-1");
    events.wakeInstance("instance-1");
    events.registerInstanceWakeup((instanceId) => { instances.push(instanceId); });
    events.connectHerdrHints({ async handle() {} });

    events.seal();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(prompts).toEqual(["binding-1"]);
    expect(instances).toEqual(["instance-1"]);
  });

  it("fails fast when required work or Herdr hint wiring is incomplete", async () => {
    const events = new RuntimeEventIntegration(pino({ enabled: false }));
    expect(() => events.seal()).toThrow("Missing wake-up channel registration: instance");
    expect(() => events.handleHerdrHint({ kind: "unknown", scope: "all", workspaceIds: [], paneIds: [] })).toThrow("Runtime link is not connected: Herdr event router");
  });

  it("routes bounded Herdr hints only through the connected reconciliation consumer", async () => {
    const handle = vi.fn(async () => {});
    const events = new RuntimeEventIntegration(pino({ enabled: false }));
    events.registerInstanceWakeup(() => {});
    events.connectHerdrHints({ handle });
    events.seal();
    const hint = { kind: "agent-status" as const, scope: "panes" as const, workspaceIds: ["w1"], paneIds: ["p1"] };

    await events.handleHerdrHint(hint);

    expect(handle).toHaveBeenCalledWith(hint);
  });
});
