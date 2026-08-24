import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("application composition boundaries", () => {
  it("keeps concrete workflow and adapter construction in the composition root", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(router).not.toMatch(/new (?:PromptRunWorkflow|BindingProvisioningWorkflow|OperationsWorkflow|HerdrRuntimeReconciler|StartupViewConverger)/);
    expect(router).not.toMatch(/import (?!type).*?(?:bridge-event-bus|lark-outbox-dispatcher|prompt-work-scheduler|inbound-work-notifier)/);
    expect(router).not.toContain("BindingStorePort");
    for (const component of ["PromptRunWorkflow", "BindingProvisioningWorkflow", "OperationsWorkflow", "HerdrRuntimeReconciler", "StartupViewConverger"]) {
      expect(main).toContain(`new ${component}`);
    }
  });

  it("keeps lifecycle publishers and subscribers behind their ports", () => {
    const promptRun = readFileSync(new URL("../src/coordinator/prompt-run-workflow.ts", import.meta.url), "utf8");
    const projector = readFileSync(new URL("../src/events/conversation-view-projector.ts", import.meta.url), "utf8");
    const dispatcher = readFileSync(new URL("../src/events/lark-outbox-dispatcher.ts", import.meta.url), "utf8");
    expect(promptRun).toContain("LifecycleEventPublisher");
    expect(promptRun).not.toContain("BridgeEventBus");
    expect(projector).toContain("LifecycleEventSubscriber");
    expect(projector).not.toContain("BridgeEventBus");
    expect(dispatcher).not.toContain("BridgeEventBus");
  });

  it("keeps outbound intent persistence separate from Lark delivery", () => {
    const writer = readFileSync(new URL("../src/events/outbound-intent-writer.ts", import.meta.url), "utf8");
    const dispatcher = readFileSync(new URL("../src/events/lark-outbox-dispatcher.ts", import.meta.url), "utf8");
    const coordinators = ["inbound-router.ts", "binding-provisioning-workflow.ts", "operations-workflow.ts", "prompt-run-workflow.ts", "herdr-runtime-reconciler.ts"]
      .map((file) => readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8"))
      .join("\n");
    expect(writer).toContain("implements OutboundIntentPort");
    expect(writer).not.toContain("LarkPort");
    expect(dispatcher).toContain("implements OutboxDispatcherControl, OutboundCheckpointSubscriber");
    expect(dispatcher).not.toContain("implements OutboundIntentPort");
    expect(coordinators).not.toMatch(/(?:outbound|channelPublisher)\.drain\(|retryPending/);
  });
});
