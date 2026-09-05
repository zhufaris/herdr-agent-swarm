import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("application composition boundaries", () => {
  it("keeps durable prompt safety scans out of Herdr reconciliation", () => {
    const reconciler = readFileSync(new URL("../src/coordinator/herdr-runtime-reconciler.ts", import.meta.url), "utf8");
    expect(reconciler).not.toContain("scanDurablePromptWork");
    expect(reconciler).not.toContain("listDetachedPrompts");
    expect(reconciler).not.toContain('scheduler.wake({ kind: "prompt-ready", bindingId: binding.id })');
  });

  it("keeps concrete workflow and adapter construction in the composition factory", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const factory = readFileSync(new URL("../src/composition/create-bridge-runtime.ts", import.meta.url), "utf8");
    expect(router).not.toMatch(/new (?:InboundMessageDispatcher|CardActionRouter|PromptRunWorkflow|BindingProvisioningWorkflow|ModelSelectionWorkflow|PaneControlWorkflow|OperationsQueryWorkflow|SessionAdministrationWorkflow|DeliveryRecoveryWorkflow|PaneClosureWorkflow|HerdrRuntimeReconciler|StartupViewConverger|StartupRecoveryWorkflow)/);
    expect(router).not.toMatch(/import (?!type).*?(?:bridge-event-bus|lark-outbox-dispatcher|prompt-work-scheduler|inbound-work-notifier)/);
    expect(router).not.toContain("BindingStorePort");
    for (const component of ["InboundMessageDispatcher", "CardActionRouter", "PromptRunWorkflow", "BindingProvisioningWorkflow", "ModelSelectionWorkflow", "PaneControlWorkflow", "OperationsQueryWorkflow", "SessionAdministrationWorkflow", "DeliveryRecoveryWorkflow", "PaneClosureWorkflow", "HerdrRuntimeReconciler", "StartupViewConverger", "StartupRecoveryWorkflow"]) {
      expect(factory).toContain(`new ${component}`);
      expect(main).not.toContain(`new ${component}`);
    }
    expect(main).toContain("createBridgeRuntime(config, store, logger, { codex, claude, pi })");
    expect(factory).not.toContain("lease.acquire(");
    expect(factory).not.toContain("activateWriteFence(");
    expect(factory).not.toContain("startHealthServer(");
  });

  it("keeps ordered startup recovery and diagnostics outside the inbound facade", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const recovery = readFileSync(new URL("../src/coordinator/startup-recovery-workflow.ts", import.meta.url), "utf8");
    expect(router).toContain("StartupRecoveryWorkflowPort");
    expect(router).not.toContain("view-convergence");
    expect(router).not.toContain("runStage(");
    expect(recovery).toContain("view-convergence");
    expect(recovery).toContain("runtime-reconciliation");
    expect(recovery).toContain("startup-recovery-stage-failed");
  });

  it("keeps periodic scheduling mechanics in the runtime runner", () => {
    const retention = readFileSync(new URL("../src/coordinator/pane-retention-workflow.ts", import.meta.url), "utf8");
    const cleanup = readFileSync(new URL("../src/coordinator/retired-pane-cleanup-workflow.ts", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../src/runtime/periodic-workflow-runner.ts", import.meta.url), "utf8");
    expect(retention).toContain("PeriodicWorkflowRunner");
    expect(cleanup).toContain("PeriodicWorkflowRunner");
    expect(retention).not.toContain("setInterval(");
    expect(cleanup).not.toContain("setInterval(");
    expect(runner).toContain("setInterval(");
    expect(runner).toContain("async stop()");
  });

  it("keeps reconciliation metrics behind one runtime module", () => {
    const herdrReconciler = readFileSync(new URL("../src/coordinator/herdr-runtime-reconciler.ts", import.meta.url), "utf8");
    const instanceReconciler = readFileSync(new URL("../src/coordinator/instance-runtime-reconciler.ts", import.meta.url), "utf8");
    const metrics = readFileSync(new URL("../src/runtime/reconciliation-run-metrics.ts", import.meta.url), "utf8");
    expect(herdrReconciler).toContain("ReconciliationRunMetrics");
    expect(instanceReconciler).toContain("ReconciliationRunMetrics");
    expect(herdrReconciler).not.toContain("private runCount");
    expect(instanceReconciler).not.toContain("private runCount");
    expect(metrics).toContain("async measure<T>");
    expect(metrics).toContain("markCoalesced");
  });

  it("keeps per-binding projection serialization in the runtime queue", () => {
    const conversation = readFileSync(new URL("../src/events/conversation-view-projector.ts", import.meta.url), "utf8");
    const queueFeedback = readFileSync(new URL("../src/events/queue-feedback-projector.ts", import.meta.url), "utf8");
    const queue = readFileSync(new URL("../src/runtime/keyed-serial-work-queue.ts", import.meta.url), "utf8");
    expect(conversation).toContain("KeyedSerialWorkQueue");
    expect(queueFeedback).toContain("KeyedSerialWorkQueue");
    expect(conversation).not.toContain("bindingTails");
    expect(queueFeedback).not.toContain("bindingTails");
    expect(queue).toContain("previous.catch(() => undefined).then(work)");
    expect(queue).toContain("async stop()");
  });

  it("keeps durable inbound persistence and retry mechanics outside message routing", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const dispatcher = readFileSync(new URL("../src/coordinator/inbound-message-dispatcher.ts", import.meta.url), "utf8");
    expect(router).toContain("InboundMessageDispatcherPort");
    expect(router).not.toContain("claimNextInboundMessage");
    expect(router).not.toContain("scheduleRetry");
    expect(dispatcher).toContain("claimNextInboundMessage");
    expect(dispatcher).toContain("scheduleRetry");
  });

  it("keeps card action parsing and authorization outside message routing", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const cardActions = readFileSync(new URL("../src/coordinator/card-action-router.ts", import.meta.url), "utf8");
    expect(router).toContain("CardActionRouterPort");
    expect(router).not.toContain("parseModelSelectionAction");
    expect(router).not.toContain("parsePaneClaimAction");
    expect(cardActions).toContain("parseModelSelectionAction");
    expect(cardActions).toContain("parsePaneClaimAction");
  });

  it("routes query and session administration through dedicated workflow seams", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const routing = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    const commands = readFileSync(new URL("../src/coordinator/swarm-command-gateway.ts", import.meta.url), "utf8");
    const recovery = readFileSync(new URL("../src/coordinator/startup-recovery-workflow.ts", import.meta.url), "utf8");
    expect(router).toContain("StartupRecoveryWorkflowPort");
    expect(router).not.toContain("operationsQuery.listSpaces");
    expect(routing).toContain("SwarmCommandGatewayPort");
    expect(routing).not.toContain("operationsQuery.listSpaces");
    expect(commands).toContain("OperationsQueryWorkflowPort");
    expect(commands).toContain("SessionAdministrationWorkflowPort");
    expect(commands).toContain("ModelSelectionWorkflowPort");
    expect(commands).toContain("PaneControlWorkflowPort");
    expect(commands).toContain("PaneClosureWorkflowPort");
    expect(recovery).toContain("InboundMessageRoutingWorkflowPort");
    expect(commands).toContain("operationsQuery.listSpaces");
    expect(commands).toContain("sessionAdministration.archive");
    expect(commands).toContain("async stop(): Promise<void>");
    expect(router).toContain("swarmCommands.stop()");
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
    const coordinators = ["inbound-router.ts", "binding-provisioning-workflow.ts", "model-selection-workflow.ts", "pane-control-workflow.ts", "pane-closure-workflow.ts", "session-administration-workflow.ts", "operations-query-workflow.ts", "delivery-recovery-workflow.ts", "prompt-run-workflow.ts", "herdr-runtime-reconciler.ts"]
      .map((file) => readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8"))
      .join("\n");
    expect(writer).toContain("implements OutboundIntentPort");
    expect(writer).not.toContain("LarkPort");
    expect(dispatcher).toContain("implements OutboxDispatcherControl, OutboundCheckpointSubscriber");
    expect(dispatcher).not.toContain("implements OutboundIntentPort");
    expect(coordinators).not.toMatch(/(?:outbound|channelPublisher)\.drain\(|retryPending/);
  });

  it("starts the database lease heartbeat before long startup audits", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main.indexOf("lease.start(")).toBeGreaterThan(main.indexOf("lease.acquire()"));
    expect(main.indexOf("lease.start(")).toBeLessThan(main.indexOf("await sqliteIntegrity.run()"));
  });

  it("puts the integrity auditor inside the shared runtime shutdown boundary", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("integrityAuditor: sqliteIntegrity");
    expect(main).not.toContain("await sqliteIntegrity.stop(); return shutdown.shutdown(signal)");
  });
});
