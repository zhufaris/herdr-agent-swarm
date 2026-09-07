import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("application composition boundaries", () => {
  it("enforces the source import graph", () => {
    expect(execFileSync(process.execPath, ["scripts/check-architecture-imports.mjs"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }))
      .toMatch(/Architecture imports valid/);
  });

  it("keeps durable prompt safety scans out of Herdr reconciliation", () => {
    const reconciler = readFileSync(new URL("../src/coordinator/herdr-runtime-reconciler.ts", import.meta.url), "utf8");
    expect(reconciler).not.toContain("scanDurablePromptWork");
    expect(reconciler).not.toContain("listDetachedPrompts");
    expect(reconciler).not.toContain('scheduler.wake({ kind: "prompt-ready", bindingId: binding.id })');
  });

  it("keeps latest SQLite schema bootstrap separate from compatibility migrations", () => {
    const schema = readFileSync(new URL("../src/store/sqlite/schema.ts", import.meta.url), "utf8");
    const migrations = readFileSync(new URL("../src/store/sqlite/migrations.ts", import.meta.url), "utf8");
    expect(schema).toContain("export function createLatestSchema");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(migrations).toContain("createLatestSchema(this.context)");
    expect(migrations).not.toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
  });

  it("keeps concrete workflow and adapter construction in the composition factory", () => {
    const router = readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const factory = readFileSync(new URL("../src/composition/create-bridge-runtime.ts", import.meta.url), "utf8");
    const lifecycle = readFileSync(new URL("../src/composition/managed-bridge-runtime.ts", import.meta.url), "utf8");
    const application = readFileSync(new URL("../src/composition/create-application-runtime.ts", import.meta.url), "utf8");
    const bindingSession = readFileSync(new URL("../src/composition/create-binding-session-runtime.ts", import.meta.url), "utf8");
    const commandControl = readFileSync(new URL("../src/composition/create-command-control-runtime.ts", import.meta.url), "utf8");
    const ingressRecovery = readFileSync(new URL("../src/composition/create-ingress-recovery-runtime.ts", import.meta.url), "utf8");
    const primary = readFileSync(new URL("../src/composition/create-primary-runtime.ts", import.meta.url), "utf8");
    const storeBundle = readFileSync(new URL("../src/store/sqlite-store-bundle.ts", import.meta.url), "utf8");
    const composition = `${factory}\n${application}\n${bindingSession}\n${commandControl}\n${ingressRecovery}\n${primary}`;
    expect(router).not.toMatch(/new (?:InboundMessageDispatcher|CardActionRouter|PromptRunWorkflow|BindingProvisioningWorkflow|ModelSelectionWorkflow|PaneControlWorkflow|OperationsQueryWorkflow|SessionAdministrationWorkflow|DeliveryRecoveryWorkflow|PaneClosureWorkflow|HerdrRuntimeReconciler|StartupViewConverger|StartupRecoveryWorkflow)/);
    expect(router).not.toMatch(/import (?!type).*?(?:bridge-event-bus|lark-outbox-dispatcher|prompt-work-scheduler|inbound-work-notifier)/);
    expect(router).not.toContain("BindingStorePort");
    for (const component of ["InboundMessageDispatcher", "CardActionRouter", "PromptRunWorkflow", "BindingProvisioningWorkflow", "ModelSelectionWorkflow", "PaneControlWorkflow", "OperationsQueryWorkflow", "SessionAdministrationWorkflow", "DeliveryRecoveryWorkflow", "PaneClosureWorkflow", "HerdrRuntimeReconciler", "StartupViewConverger", "StartupRecoveryWorkflow"]) {
      expect(composition).toContain(`new ${component}`);
      expect(main).not.toContain(`new ${component}`);
    }
    for (const childFactory of ["createBindingSessionRuntime", "createCommandControlRuntime", "createIngressRecoveryRuntime"]) {
      expect(application).toContain(`${childFactory}({`);
    }
    expect(application).not.toMatch(/new (?:InboundMessageDispatcher|CardActionRouter|BindingProvisioningWorkflow|ModelSelectionWorkflow|PaneControlWorkflow|OperationsQueryWorkflow|SessionAdministrationWorkflow|DeliveryRecoveryWorkflow|PaneClosureWorkflow|HerdrRuntimeReconciler|StartupViewConverger|StartupRecoveryWorkflow)/);
    expect(main).toContain("createManagedBridgeRuntime({");
    expect(main).not.toContain("createSqliteStoreBundle");
    expect(main).not.toContain("createBridgeRuntime");
    expect(lifecycle).toContain("const stores = createSqliteStoreBundle(config.databasePath)");
    expect(lifecycle).toContain("createBridgeRuntime(config, stores, logger, { codex, claude, pi })");
    expect(main).not.toContain("new SqliteBindingStore");
    expect(storeBundle).toContain("new SqliteStoreKernel");
    expect(storeBundle).toContain("const modules = store.capabilityModules()");
    expect(storeBundle).toContain("lease: modules.lease");
    expect(storeBundle).toContain("lifecycle: modules.lifecycle");
    expect(storeBundle).toContain("health: modules.health");
    expect(storeBundle).toContain("retention: modules.retention");
    expect(storeBundle).toContain("inboundDispatch: modules.inboundDispatch");
    expect(storeBundle).not.toMatch(/inboundDispatch:\s*store/);
    expect(storeBundle).toContain("operationsQuery: modules.operationsQuery");
    expect(storeBundle).toContain("workerCardDisplay: modules.workerCardDisplay");
    expect(storeBundle).toContain("instance: modules.instance");
    expect(storeBundle).toContain("instanceLifecycle: modules.instance");
    expect(storeBundle).toContain("instanceTurns: modules.instance");
    expect(storeBundle).not.toMatch(/instance(?:Lifecycle|Turns)?:\s*store/);
    expect(storeBundle).toContain("commandIntents: modules.commandIntents");
    expect(storeBundle).toContain("sessionOperations: modules.sessionOperations");
    expect(storeBundle).toContain("cardContext: modules.cardContext");
    expect(readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8")).not.toContain("createApprovalRequest");
    expect(readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8")).not.toContain("listPendingCardContextInvalidations");
    const workflowPorts = readFileSync(new URL("../src/domain/ports/workflow.ts", import.meta.url), "utf8");
    const routingPort = workflowPorts.slice(workflowPorts.indexOf("export interface InboundRoutingStore"), workflowPorts.indexOf("export interface InboundMessageDispatchStore"));
    expect(routingPort).not.toMatch(/recordInboundMessage|claimNextInboundMessage|markInboundMessageAccepted|releaseInboundMessage|recoverProcessingInboundMessages/);
    const kernel = readFileSync(new URL("../src/store/sqlite-store-kernel.ts", import.meta.url), "utf8");
    expect(kernel).not.toMatch(/^  (?:recordInboundMessage|claimNextInboundMessage|markInboundMessageAccepted|releaseInboundMessage|recoverProcessingInboundMessages)\(/m);
    expect(kernel).not.toMatch(/^  (?:createAgentInstance|createWorkerAgentInstance|attachAgentInstanceRuntime|updateAgentInstanceLifecycle|acceptInstanceOperation|projectLegacyBindingAsAgentInstance)\(/m);
    const instancePorts = readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8");
    expect(instancePorts).toContain("export type InstanceLifecycleStore");
    expect(instancePorts).toContain("export type InstanceTurnStore");
    for (const path of ["instance-control-workflow.ts", "instance-runtime-reconciler.ts", "instance-turn-supervisor.ts", "worker-turn-observer.ts"]) {
      expect(readFileSync(new URL(
        `../src/coordinator/${path}`, import.meta.url
      ), "utf8")).not.toMatch(/store: InstanceStore(?:;|,)/);
    }
    expect(storeBundle).not.toContain("SqliteBindingStore");
    expect(composition).toContain("stores.promptRun");
    expect(composition).toContain("stores.instance");
    const worker = readFileSync(new URL("../src/composition/create-worker-runtime.ts", import.meta.url), "utf8");
    expect(worker).toContain("stores.instanceLifecycle");
    expect(worker).toContain("stores.instanceTurns");
    for (const component of ["WorkerTurnObserver", "InstanceWorkScheduler", "InstanceTurnSupervisor", "InstanceRuntimeReconciler"]) {
      expect(worker).toMatch(new RegExp(`new ${component}\\(\\{[^\\n]*store: executionStore`));
    }
    expect(readFileSync(new URL("../src/composition/create-outbound-runtime.ts", import.meta.url), "utf8")).toContain("stores.outbox");
    expect(factory).not.toContain("SqliteBindingStore");
    expect(factory).not.toContain("lease.acquire(");
    expect(factory).not.toContain("activateWriteFence(");
    expect(factory).not.toContain("startHealthServer(");
  });

  it("gives child composition factories consumer-specific SQLite capabilities", () => {
    for (const file of ["create-outbound-runtime.ts", "create-worker-runtime.ts", "create-primary-runtime.ts", "create-application-runtime.ts", "create-binding-session-runtime.ts", "create-command-control-runtime.ts", "create-ingress-recovery-runtime.ts"]) {
      const source = readFileSync(new URL(`../src/composition/${file}`, import.meta.url), "utf8");
      expect(source).toMatch(/export type [A-Za-z]+Stores = Pick<SqliteStoreBundle,/);
      expect(source).not.toMatch(/stores:\s*SqliteStoreBundle/);
    }
  });

  it("keeps context-owned delivery, runtime, and project-selection models out of the compatibility type barrel", () => {
    const types = readFileSync(new URL("../src/domain/types.ts", import.meta.url), "utf8");
    expect(types).toContain('export type { AnswerPage');
    expect(types).toContain('from "./delivery.js"');
    expect(types).toContain('from "./runtime-observation.js"');
    expect(types).toContain('from "./project-selection.js"');
    expect(types).toContain('from "../runtime/diagnostics.js"');
    expect(types).toContain('from "../adapters/lark-ingress.js"');
    expect(types).not.toMatch(/export interface (?:Binding|PromptJob|OutboundReply|AnswerPage|ProjectSelection|HerdrPane|RuntimeObservation|IncomingLarkMessage|IncomingLarkCardAction|OutboxDispatcherDiagnostics|PromptWorkerDiagnostics)\b/);
  });

  it("keeps production composition off the broad SQLite compatibility facade", () => {
    const productionFiles = [
      "../src/main.ts",
      "../src/composition/create-bridge-runtime.ts",
      "../src/composition/create-application-runtime.ts",
      "../src/composition/create-binding-session-runtime.ts",
      "../src/composition/create-command-control-runtime.ts",
      "../src/composition/create-ingress-recovery-runtime.ts",
      "../src/composition/create-primary-runtime.ts",
      "../src/composition/create-worker-runtime.ts",
      "../src/composition/create-outbound-runtime.ts",
      "../src/store/sqlite-store-bundle.ts"
    ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    expect(productionFiles).not.toContain("SqliteBindingStore");
    expect(productionFiles).not.toContain('from "../store/sqlite-store.js"');
    expect(existsSync(new URL("../src/store/sqlite-store.ts", import.meta.url))).toBe(false);
    const compatibility = readFileSync(new URL("./helpers/sqlite-binding-store.ts", import.meta.url), "utf8");
    expect(compatibility).toContain("new SqliteStoreKernel(path)");
    expect(compatibility).not.toContain("extends SqliteStoreKernel");
  });

  it("bounds renderer-bearing store ports to documented atomic transition seams", () => {
    const ports = new URL("../src/domain/ports/", import.meta.url);
    const rendererBearing = readdirSync(ports)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /\brender[A-Z]\w*|\brender\??s*[:(]/.test(readFileSync(new URL(file, ports), "utf8")))
      .sort();
    expect(rendererBearing).toEqual([
      "instance.ts",
      "pane-operations.ts",
      "prompt-acceptance.ts",
      "prompt-run.ts",
      "turn-control.ts",
      "worker-card-display.ts",
      "workflow.ts"
    ]);
  });

  it("provides capability-oriented test construction without the compatibility facade", () => {
    const helper = readFileSync(new URL("./helpers/create-test-store-bundle.ts", import.meta.url), "utf8");
    const mainCardTests = readFileSync(new URL("./main-card-workflow.test.ts", import.meta.url), "utf8");
    const workerCardTests = readFileSync(new URL("./worker-turn-card-workflow.test.ts", import.meta.url), "utf8");
    expect(helper).toContain("createTestStoreBundle");
    expect(helper).toContain("SqliteStoreKernel");
    expect(helper).not.toContain("SqliteBindingStore");
    expect(mainCardTests).toContain("stores.mainCards");
    expect(workerCardTests).toContain("stores.workerTurnCards");
    expect(`${mainCardTests}\n${workerCardTests}`).not.toContain("SqliteBindingStore");
  });

  it("routes prompt workflows through consumer-specific port modules", () => {
    const run = readFileSync(new URL("../src/coordinator/prompt-run-workflow.ts", import.meta.url), "utf8");
    const safety = readFileSync(new URL("../src/coordinator/prompt-safety-scanner.ts", import.meta.url), "utf8");
    const routing = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    expect(`${run}\n${safety}`).toContain("ports/prompt-run.js");
    expect(routing).toContain("ports/prompt-acceptance.js");
    expect(`${run}\n${safety}\n${routing}`).not.toContain("ports/prompt.js");
  });

  it("keeps ordinary card replies on the Primary prompt path", () => {
    const routing = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    const interactions = readFileSync(new URL("../src/coordinator/instance-interaction-workflow.ts", import.meta.url), "utf8");
    expect(routing).not.toContain("worker-card-reply");
    expect(interactions).not.toContain("handleWorkerCardReply");
    expect(interactions).toContain("if (message.parentMessageId) return false");
  });

  it("keeps instance interaction as a router over focused use cases", () => {
    const facade = readFileSync(new URL("../src/coordinator/instance-interaction-workflow.ts", import.meta.url), "utf8");
    expect(facade).toContain("InstanceCommandActions");
    expect(facade).toContain("WorkerCardActions");
    expect(facade).toContain("WorkerLifecycleActions");
    expect(facade).not.toContain("instance_plan_removal");
    expect(facade).not.toContain("instance_create_submit");
    expect(facade).not.toContain("decideWorkerCardBindingOwnership");
  });

  it("routes every binding runtime transition through one converger", () => {
    const reconciler = readFileSync(new URL("../src/coordinator/herdr-runtime-reconciler.ts", import.meta.url), "utf8");
    const converger = readFileSync(new URL("../src/coordinator/binding-runtime-converger.ts", import.meta.url), "utf8");
    expect(reconciler).toContain("BindingRuntimeConverger");
    expect(reconciler).toContain("this.converger.converge");
    expect(reconciler).toContain("this.converger.orphan");
    expect(reconciler).not.toContain("applyRuntimeObservation");
    expect(reconciler).not.toContain("orphanBindingWithProjection");
    expect(converger).toContain("applyRuntimeObservation");
    expect(converger).toContain("orphanBindingWithProjection");
  });

  it("keeps attachment and startup recovery behind provisioning use cases", () => {
    const facade = readFileSync(new URL("../src/coordinator/binding-provisioning-workflow.ts", import.meta.url), "utf8");
    expect(facade).toContain("BindingAttachmentUseCase");
    expect(facade).toContain("BindingStartupRecovery");
    expect(facade).toContain("this.attachment.attach");
    expect(facade).toContain("this.startupRecovery.recover");
    expect(facade).not.toContain("ambiguous_pane_label");
    expect(facade).not.toContain("discovered-binding-recovery-failed");
    expect(facade).toContain("decideSelectedCheckpoint");
    expect(facade).toContain("decidePaneCreatedCheckpoint");
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

  it("keeps coordinator transcript cursor mechanics behind the exact-turn observer", () => {
    const coordinator = new URL("../src/coordinator/", import.meta.url);
    const sources = readdirSync(coordinator)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({ file, source: readFileSync(new URL(file, coordinator), "utf8") }));
    const directCursorReaders = sources
      .filter(({ source }) => /\.readObservation\(|\.readDelta\(/.test(source))
      .map(({ file }) => file);
    expect(directCursorReaders).toEqual([]);
    for (const file of ["transcript-observer.ts", "worker-turn-observer.ts", "external-turn-observer.ts"]) {
      expect(sources.find((source) => source.file === file)?.source).toContain("ExactTurnObserver");
    }
  });

  it("keeps reconciliation metrics behind one runtime module", () => {
    const herdrReconciler = readFileSync(new URL("../src/coordinator/herdr-runtime-reconciler.ts", import.meta.url), "utf8");
    const instanceReconciler = readFileSync(new URL("../src/coordinator/instance-runtime-reconciler.ts", import.meta.url), "utf8");
    const scheduler = readFileSync(new URL("../src/coordinator/reconciliation-scheduler.ts", import.meta.url), "utf8");
    const metrics = readFileSync(new URL("../src/runtime/reconciliation-run-metrics.ts", import.meta.url), "utf8");
    expect(herdrReconciler).toContain("ReconciliationScheduler");
    expect(herdrReconciler).not.toContain("ReconciliationRunMetrics");
    expect(scheduler).toContain("ReconciliationRunMetrics");
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
    const parser = readFileSync(new URL("../src/coordinator/card-action-command.ts", import.meta.url), "utf8");
    expect(router).toContain("CardActionRouterPort");
    expect(router).not.toContain("parseCardActionCommand");
    expect(cardActions).toContain("parseCardActionCommand(action.value, action.option)");
    expect(cardActions).not.toContain("parseModelSelectionAction");
    expect(cardActions).not.toContain("parsePaneClaimAction");
    expect(parser).toContain("export type CardActionCommand");
    expect(parser).toContain("export function parseCardActionCommand");
    const actionOwners = ["card-interaction-workflow.ts", "instance-interaction-workflow.ts", "instance-interactions/worker-card-actions.ts", "instance-interactions/worker-lifecycle-actions.ts"]
      .map((file) => readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8"))
      .join("\n");
    expect(actionOwners).not.toContain("action.value");
    expect(actionOwners).not.toContain("Record<string, unknown>");
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
    expect(router).not.toContain("modelSelection");
    expect(readFileSync(new URL("../src/coordinator/model-selection-workflow.ts", import.meta.url), "utf8")).not.toContain("shutdown(): void");
  });

  it("centralizes coordinator project lookup in ProjectCatalog", () => {
    const coordinator = new URL("../src/coordinator/", import.meta.url);
    const coordinatorSources = readdirSync(coordinator).filter((file) => file.endsWith(".ts"));
    for (const file of coordinatorSources) {
      const source = readFileSync(new URL(file, coordinator), "utf8");
      expect(source, file).not.toContain("project-route-index");
      if (file !== "project-catalog.ts") {
        expect(source, file).not.toContain("projectsBySpaceName");
        expect(source, file).not.toContain("projectsByWorkspaceAndCwd");
      }
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
    const lifecycle = readFileSync(new URL("../src/composition/managed-bridge-runtime.ts", import.meta.url), "utf8");
    expect(lifecycle.indexOf("d.lease.start(")).toBeGreaterThan(lifecycle.indexOf("d.lease.acquire()"));
    expect(lifecycle.indexOf("d.lease.start(")).toBeLessThan(lifecycle.indexOf("await d.sqliteIntegrity.run()"));
  });

  it("puts the integrity auditor inside the shared runtime shutdown boundary", () => {
    const lifecycle = readFileSync(new URL("../src/composition/managed-bridge-runtime.ts", import.meta.url), "utf8");
    expect(lifecycle).toContain("integrityAuditor: d.sqliteIntegrity");
    expect(lifecycle).not.toContain("await d.sqliteIntegrity.stop(); return shutdown.shutdown(signal)");
  });

  it("keeps process entrypoint lifecycle-free beyond start and stop", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    for (const implementation of ["BridgeRuntimeShutdown", "cleanupStartupFailure", "startHealthServer", "InstanceLeaseController", "createSqliteStoreBundle", "createBridgeRuntime"]) {
      expect(main).not.toContain(implementation);
    }
    expect(main).toContain("await runtime.start()");
    expect(main).toContain("await runtime.stop(signal)");
  });
});
