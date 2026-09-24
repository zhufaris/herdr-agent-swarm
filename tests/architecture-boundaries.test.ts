import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("application composition boundaries", () => {
  it("runs the architecture check exactly once through the Vitest suite", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts["architecture:check"]).toBe("node scripts/check-architecture-imports.mjs");
  });

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

  it("keeps SQLite migration ordering in one runner over isolated domain modules", () => {
    const runner = readFileSync(new URL("../src/store/sqlite/migrations.ts", import.meta.url), "utf8");
    const modules = [
      "binding-session-migrations.ts", "prompt-turn-migrations.ts", "card-outbox-migrations.ts",
      "worker-migrations.ts", "retired-schema-migrations.ts"
    ].map((file) => readFileSync(new URL(`../src/store/sqlite/migrations/${file}`, import.meta.url), "utf8"));
    for (const className of ["BindingSessionMigrations", "PromptTurnMigrations", "CardOutboxMigrations", "WorkerMigrations", "RetiredSchemaMigrations"]) {
      expect(runner).toContain(`new ${className}(context)`);
    }
    expect(runner).toContain("createLatestSchema(this.context)");
    expect(runner.indexOf("this.binding.ensureAgentSessionColumns()")).toBeLessThan(runner.indexOf("this.retired.removeReportedTraexSessionColumns()"));
    expect(runner.indexOf("this.cards.ensureRunCardActivityColumn()")).toBeLessThan(runner.indexOf("this.retired.convergeRetiredPromptSteering()"));
    expect(modules.join("\n")).not.toContain("createLatestSchema");
    for (const source of modules) expect(source).not.toMatch(/from "\.\/(?:binding-session|prompt-turn|card-outbox|worker|retired-schema)-migrations/);
  });

  it("centralizes foreign-key-disabled table rebuilds in the guarded migration helper", () => {
    const directory = new URL("../src/store/sqlite/migrations/", import.meta.url);
    const migrationFiles = readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && file !== "foreign-key-safe-rebuild.ts");
    for (const file of migrationFiles) {
      const source = readFileSync(new URL(file, directory), "utf8");
      expect(source).not.toMatch(/PRAGMA\s+foreign_keys\s*=\s*OFF/i);
    }
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
    const workerFactory = readFileSync(new URL("../src/composition/create-worker-runtime.ts", import.meta.url), "utf8");
    const storeBundle = readFileSync(new URL("../src/store/sqlite-store-bundle.ts", import.meta.url), "utf8");
    const kernel = readFileSync(new URL("./helpers/sqlite-store-kernel.ts", import.meta.url), "utf8");
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
    expect(lifecycle).toContain("const bootstrap = openSqliteLeaseBootstrap(config.databasePath)");
    expect(lifecycle.indexOf("lease.acquire()")).toBeLessThan(lifecycle.indexOf("bootstrap.complete(lease.writeFence())"));
    expect(lifecycle).not.toContain("createSqliteStoreBundle(config.databasePath)");
    expect(lifecycle).toContain("createBridgeRuntime(config, completedStores, logger, { codex, claude, pi })");
    expect(factory).toContain("return { lifecycle, health, operations");
    expect(lifecycle).toContain("...runtime.lifecycle");
    expect(lifecycle).toContain("...runtime.health");
    expect(lifecycle).not.toContain("const { herdr, herdrCircuitBreaker, herdrSocketSubscriber");
    expect(workerFactory).toContain("instanceWorker");
    expect(factory).not.toContain("const instanceWorker =");
    expect(main).not.toContain("new SqliteBindingStore");
    expect(storeBundle).toContain("createSqliteStoreBundleFromGraph(new SqliteCapabilityGraph(path))");
    expect(storeBundle).not.toContain("SqliteStoreKernel");
    const capabilityGraph = readFileSync(new URL("../src/store/sqlite/capability-graph.ts", import.meta.url), "utf8");
    expect(kernel).toContain("new SqliteCapabilityGraph(path)");
    expect(kernel).not.toContain("new SqliteContext");
    expect(kernel).not.toContain("new SqliteMigrations");
    expect(capabilityGraph).toContain('typeof pathOrContext === "string" ? new SqliteContext(pathOrContext) : pathOrContext');
    expect(capabilityGraph).toContain("this.migrations.run()");
    expect(capabilityGraph).toContain("Object.assign(this, createStoreCluster(this.context))");
    expect(capabilityGraph.indexOf("this.migrations.run()")).toBeLessThan(capabilityGraph.indexOf("createStoreCluster(this.context)"));
    expect(capabilityGraph).not.toContain("{} as StoreCluster");
    expect(capabilityGraph).not.toContain("Partial<StoreCluster>");
    expect(capabilityGraph).toContain("new StoreLink<");
    const bindingProjection = readFileSync(new URL("../src/store/sqlite/binding-projection-store.ts", import.meta.url), "utf8");
    expect(bindingProjection).toContain('listRunCardsByPhases(input.bindingId, ["running", "blocked", "queued"])');
    expect(bindingProjection).not.toContain("listRunCards(input.bindingId)");
    expect(storeBundle).toContain("lease: modules.lease");
    expect(storeBundle).toContain("lifecycle: modules.lifecycle");
    expect(storeBundle).toContain("health: modules.health");
    expect(storeBundle).toContain("retention: modules.retention");
    expect(storeBundle).toContain("outbox: modules.outbox");
    expect(storeBundle).toContain("outboundIntent: modules.outbox");
    expect(storeBundle).not.toMatch(/outbox:\s*store/);
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
    for (const capability of ["answerPages", "mainCards", "projection", "queueFeedback"]) {
      expect(storeBundle).toContain(`${capability}: modules.${capability}`);
      expect(storeBundle).not.toMatch(new RegExp(`${capability}:\\s*store`));
    }
    expect(storeBundle).toContain("promptAcceptance: modules.promptAcceptance");
    for (const capability of ["promptDispatch", "promptRecovery", "promptSession"]) {
      expect(storeBundle).toContain(`${capability}: modules.${capability}`);
      expect(storeBundle).not.toMatch(new RegExp(`${capability}:\s*store`));
    }
    expect(storeBundle).not.toMatch(/promptAcceptance:\s*store/);
    for (const capability of ["bindingProvisioning", "runtimeReconciliation", "retiredPaneCleanup", "sessionAdministration", "paneRetention"]) {
      expect(storeBundle).toContain(`${capability}: modules.${capability}`);
      expect(storeBundle).not.toMatch(new RegExp(`${capability}:\\s*store`));
    }
    for (const capability of ["turnControl", "paneControl", "paneClose", "inboundRouting", "deliveryRecovery", "cardInteraction", "externalTurns", "modelSelection", "startupRecovery"]) {
      expect(storeBundle).toContain(`${capability}: modules.${capability}`);
      expect(storeBundle).not.toMatch(new RegExp(`${capability}:\\s*store`));
    }
    expect(storeBundle).toContain("startupViews: modules.startupViews");
    expect(storeBundle).not.toMatch(/readonly (?:turnControl|commandIntents|startupRecovery):[^;]*&/);
    const promptAcceptance = readFileSync(new URL("../src/domain/ports/prompt-acceptance.ts", import.meta.url), "utf8");
    expect(promptAcceptance).not.toMatch(/recoverLegacyElementIdDeadLetters|recoverUnsupportedWorkerCardCreates|convergeWorkerTaskCardRenderer|recoverStaleOutboxQuarantines|listRunCards|loadTopicView|reserveMainCard/);
    expect(readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8")).not.toContain("createApprovalRequest");
    expect(readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8")).not.toContain("listPendingCardContextInvalidations");
    const workflowPorts = readFileSync(new URL("../src/domain/ports/workflow.ts", import.meta.url), "utf8");
    const routingPort = workflowPorts.slice(workflowPorts.indexOf("export interface InboundRoutingStore"), workflowPorts.indexOf("export interface InboundMessageDispatchStore"));
    expect(routingPort).not.toMatch(/recordInboundMessage|claimNextInboundMessage|markInboundMessageAccepted|releaseInboundMessage|recoverProcessingInboundMessages/);
    expect(kernel).not.toMatch(/^  (?:recordInboundMessage|claimNextInboundMessage|markInboundMessageAccepted|releaseInboundMessage|recoverProcessingInboundMessages)\(/m);
    expect(kernel).not.toMatch(/^  (?:createAgentInstance|createWorkerAgentInstance|attachAgentInstanceRuntime|updateAgentInstanceLifecycle|acceptInstanceOperation|projectLegacyBindingAsAgentInstance)\(/m);
    expect(kernel).not.toMatch(/^  (?:enqueueOutboundReply|listPendingOutboundReplies|getOutboundReply|dismissSupersededAnswerStream|listOutboundLaneHeads|getNextOutboundLaneHeadAttemptAt|markOutboundReplyDelivered|checkpointOutboundReplyCard|markOutboundReplyFailed|markOutboundReplyDeadLetter|markOutboundReplyFailedWithQuarantine|recoverEligibleDeadLetters)\(/m);
    const instancePorts = readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8");
    expect(instancePorts).toContain("export type InstanceLifecycleStore");
    expect(instancePorts).toContain("export type InstanceTurnStore");
    for (const path of ["instance-control-workflow.ts", "instance-runtime-reconciler.ts", "instance-turn-supervisor.ts", "worker-turn-observer.ts"]) {
      expect(readFileSync(new URL(
        `../src/coordinator/${path}`, import.meta.url
      ), "utf8")).not.toMatch(/store: InstanceStore(?:;|,)/);
    }
    expect(storeBundle).not.toContain("SqliteBindingStore");
    expect(composition).toContain("stores.promptDispatch");
    expect(composition).toContain("stores.promptRecovery");
    expect(composition).toContain("stores.promptSession");
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

  it("keeps Conversation Gateway selection in composition and isolates its contract from workflows and runtimes", () => {
    const infrastructure = readFileSync(new URL("../src/composition/create-infrastructure-runtime.ts", import.meta.url), "utf8");
    const registry = readFileSync(new URL("../src/gateways/registry.ts", import.meta.url), "utf8");
    const contract = readFileSync(new URL("../src/gateways/contract/plugin.ts", import.meta.url), "utf8");
    expect(infrastructure).toContain("new BuiltinGatewayRegistry");
    expect(infrastructure).not.toContain("new LarkSdkAdapter");
    expect(registry).not.toMatch(/from .*coordinator|from .*runtime\/herdr|from .*traex|from .*prompt/);
    expect(contract).not.toMatch(/from .*coordinator|from .*runtime|from .*adapters|Herdr|Traex|PromptRun/);
    expect(readFileSync(new URL("../src/coordinator/startup-recovery-workflow.ts", import.meta.url), "utf8")).not.toContain("LarkPort");
    expect(readFileSync(new URL("../src/coordinator/inbound-router.ts", import.meta.url), "utf8")).not.toContain("LarkPort");
    for (const file of ["binding-provisioning-workflow.ts", "delivery-recovery-workflow.ts", "binding-provisioning/binding-startup-recovery.ts"]) {
      expect(readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8")).not.toContain("LarkPort");
    }
  });

  it("owns process-local event integration in one composition module", () => {
    const factory = readFileSync(new URL("../src/composition/create-bridge-runtime.ts", import.meta.url), "utf8");
    const outbound = readFileSync(new URL("../src/composition/create-outbound-runtime.ts", import.meta.url), "utf8");
    const integration = readFileSync(new URL("../src/composition/runtime-event-integration.ts", import.meta.url), "utf8");
    expect(factory).toContain("new RuntimeEventIntegration(logger)");
    expect(factory).not.toMatch(/new (?:BridgeEventBus|InProcessPromptWorkScheduler|InProcessInboundWorkNotifier|InProcessOutboundWorkNotifier|WorkWakeupHub)/);
    expect(outbound).toContain("outboundWork: OutboundWorkNotifier");
    expect(outbound).not.toContain("new InProcessOutboundWorkNotifier");
    const dispatcher = readFileSync(new URL("../src/events/gateway-outbox-dispatcher.ts", import.meta.url), "utf8");
    expect(dispatcher).toContain("private readonly work: OutboundWorkNotifier,");
    expect(dispatcher).not.toContain("InProcessOutboundWorkNotifier");
    for (const file of ["create-application-runtime.ts", "create-binding-session-runtime.ts", "create-command-control-runtime.ts", "create-ingress-recovery-runtime.ts"]) {
      const source = readFileSync(new URL(`../src/composition/${file}`, import.meta.url), "utf8");
      expect(source).not.toContain("BridgeEventBus");
      expect(source).not.toContain("InProcessInboundWorkNotifier");
      expect(source).not.toContain("InProcessPromptWorkScheduler");
    }
    for (const implementation of ["BridgeEventBus", "InProcessInboundWorkNotifier", "InProcessOutboundWorkNotifier", "InProcessPromptWorkScheduler", "WorkWakeupHub"]) {
      expect(integration).toContain(`new ${implementation}`);
    }
    expect(integration).not.toContain("publish(event: unknown");
    expect(integration).not.toContain("publish(event: any");
  });

  it("separates outbound drain scheduling from single-reply delivery", () => {
    const drain = readFileSync(new URL("../src/events/gateway-outbox-dispatcher.ts", import.meta.url), "utf8");
    const delivery = readFileSync(new URL("../src/events/outbound-delivery-executor.ts", import.meta.url), "utf8");
    expect(drain).toContain("new OutboundDeliveryExecutor(store, gateway, logger)");
    expect(drain).not.toContain("outbound-intent-materializer");
    expect(drain).not.toContain("outbound-target-validation");
    expect(drain).not.toContain("delivery-error-classifier");
    expect(delivery).toContain("prepareOutboundGatewayIntent");
    expect(delivery).toContain("GatewayDeliveryPort");
    expect(delivery).not.toContain("LarkPort");
    expect(delivery).toContain("classifyCoreDeliveryFailure");
    expect(delivery).not.toContain("delivery-error-classifier");
    expect(delivery).toContain("markOutboundReplyDelivered");
  });

  it("keeps SQLite outbox responsibilities in focused modules over one context", () => {
    const facade = readFileSync(new URL("../src/store/sqlite/outbox-store.ts", import.meta.url), "utf8");
    const queue = readFileSync(new URL("../src/store/sqlite/outbox-queue-store.ts", import.meta.url), "utf8");
    const delivery = readFileSync(new URL("../src/store/sqlite/outbox-delivery-store.ts", import.meta.url), "utf8");
    const recovery = readFileSync(new URL("../src/store/sqlite/outbox-recovery-store.ts", import.meta.url), "utf8");
    const retention = readFileSync(new URL("../src/store/sqlite/outbox-retention-store.ts", import.meta.url), "utf8");
    const aliases = readFileSync(new URL("../src/store/sqlite/binding-thread-alias-store.ts", import.meta.url), "utf8");
    for (const moduleName of ["SqliteOutboxQueueStore", "SqliteOutboxDeliveryStore", "SqliteOutboxRecoveryStore", "SqliteOutboxRetentionStore"]) {
      expect(facade).toContain(`new ${moduleName}`);
    }
    expect(facade).not.toContain("context.database.prepare");
    expect(queue).toContain("private readonly context: SqliteContext");
    expect(delivery).toContain("private readonly context: SqliteContext");
    expect(recovery).toContain("private readonly context: SqliteContext");
    expect(retention).toContain("private readonly context: SqliteContext");
    expect(aliases).toContain("private readonly context: SqliteContext");
    expect(facade).toContain("SqliteBindingThreadAliasStore");
    expect(recovery).not.toContain("new SqliteOutboxQueueStore");
    expect(recovery).not.toContain("new SqliteOutboxDeliveryStore");
  });

  it("keeps Primary prompt recovery in one deep SQLite module", () => {
    const prompt = readFileSync(new URL("../src/store/sqlite/prompt-store.ts", import.meta.url), "utf8");
    const recoveryPath = new URL("../src/store/sqlite/prompt-recovery-store.ts", import.meta.url);
    expect(existsSync(recoveryPath)).toBe(true);
    const recovery = readFileSync(recoveryPath, "utf8");
    const capability = readFileSync(new URL("../src/store/sqlite/prompt-capability-store.ts", import.meta.url), "utf8");
    const graph = readFileSync(new URL("../src/store/sqlite/capability-graph.ts", import.meta.url), "utf8");
    const recoveryMethods = [
      "recoverRunningPrompts", "scanDurablePromptWork", "listStaleUndispatchedPromptClaims",
      "requeueStaleUndispatchedPromptClaim", "releaseUndispatchedPromptClaim", "listDetachedPrompts",
      "settleDetachedPrompt", "skipOldestDetachedPrompt"
    ];
    for (const method of recoveryMethods) {
      expect(recovery).toContain(`${method}(`);
      expect(prompt).not.toContain(`${method}(`);
    }
    expect(recovery).toContain("private readonly context: SqliteContext");
    expect(capability).toContain("private readonly recovery: SqlitePromptRecoveryStore");
    expect(capability).toContain("this.recovery.");
    expect(graph).toContain("new SqlitePromptRecoveryStore");
  });

  it("keeps Primary prompt acceptance in one deep SQLite module", () => {
    const prompt = readFileSync(new URL("../src/store/sqlite/prompt-store.ts", import.meta.url), "utf8");
    const acceptancePath = new URL("../src/store/sqlite/prompt-acceptance-store.ts", import.meta.url);
    expect(existsSync(acceptancePath)).toBe(true);
    const acceptance = readFileSync(acceptancePath, "utf8");
    const capability = readFileSync(new URL("../src/store/sqlite/prompt-capability-store.ts", import.meta.url), "utf8");
    const graph = readFileSync(new URL("../src/store/sqlite/capability-graph.ts", import.meta.url), "utf8");
    const acceptanceMethods = [
      "enqueuePrompt", "acceptPrompt", "acceptPromptWithEffects",
      "acceptInterruptedContinuation"
    ];
    for (const method of acceptanceMethods) {
      expect(acceptance).toContain(`${method}(`);
      expect(prompt).not.toContain(`${method}(`);
    }
    expect(acceptance).toContain("private readonly context: SqliteContext");
    expect(capability).toContain("private readonly acceptance: SqlitePromptAcceptanceStore");
    expect(capability).toContain("this.acceptance.");
    expect(graph).toContain("new SqlitePromptAcceptanceStore");
  });

  it("keeps external Primary turn adoption in one deep SQLite module", () => {
    const prompt = readFileSync(new URL("../src/store/sqlite/prompt-store.ts", import.meta.url), "utf8");
    const adoptionPath = new URL("../src/store/sqlite/external-turn-adoption-store.ts", import.meta.url);
    expect(existsSync(adoptionPath)).toBe(true);
    const adoption = readFileSync(adoptionPath, "utf8");
    const capability = readFileSync(new URL("../src/store/sqlite/recovery-capability-store.ts", import.meta.url), "utf8");
    const graph = readFileSync(new URL("../src/store/sqlite/capability-graph.ts", import.meta.url), "utf8");
    for (const method of ["adoptExternalTurn", "getActiveExternalPrompt"]) {
      expect(adoption).toContain(`${method}(`);
      expect(prompt).not.toContain(`${method}(`);
    }
    expect(adoption).toContain("private readonly context: SqliteContext");
    expect(capability).toContain("private readonly adoption: SqliteExternalTurnAdoptionStore");
    expect(capability).toContain("this.adoption.");
    expect(graph).toContain("new SqliteExternalTurnAdoptionStore");
  });

  it("keeps Primary prompt dispatch in one deep SQLite module", () => {
    const prompt = readFileSync(new URL("../src/store/sqlite/prompt-store.ts", import.meta.url), "utf8");
    const dispatchPath = new URL("../src/store/sqlite/prompt-dispatch-store.ts", import.meta.url);
    expect(existsSync(dispatchPath)).toBe(true);
    const dispatch = readFileSync(dispatchPath, "utf8");
    const capability = readFileSync(new URL("../src/store/sqlite/prompt-capability-store.ts", import.meta.url), "utf8");
    const graph = readFileSync(new URL("../src/store/sqlite/capability-graph.ts", import.meta.url), "utf8");
    const dispatchMethods = [
      "getActiveOrdinaryPrompt", "getPrompt", "claimNextDispatchablePrompt",
      "markPromptDispatched", "markModelPromptPrepared", "markModelPromptAccepted",
      "rollbackPreparedModelPrompt", "claimPromptTranscriptTurn", "updatePrompt",
      "completeTurn", "failPrompt"
    ];
    for (const method of dispatchMethods) {
      expect(dispatch).toContain(`${method}(`);
      expect(prompt).not.toContain(`${method}(`);
    }
    expect(dispatch).toContain("private readonly context: SqliteContext");
    expect(capability).toContain("private readonly dispatch: SqlitePromptDispatchStore");
    expect(capability).toContain("this.dispatch.");
    expect(graph).toContain("new SqlitePromptDispatchStore");
  });

  it("gives Primary prompt consumers separate dispatch recovery and session ports", () => {
    const ports = readFileSync(new URL("../src/domain/ports/prompt-run.ts", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../src/coordinator/prompt-run-workflow.ts", import.meta.url), "utf8");
    const executor = readFileSync(new URL("../src/coordinator/prompt-turn-executor.ts", import.meta.url), "utf8");
    const scanner = readFileSync(new URL("../src/coordinator/prompt-safety-scanner.ts", import.meta.url), "utf8");
    const bundle = readFileSync(new URL("../src/store/sqlite-store-bundle.ts", import.meta.url), "utf8");
    for (const name of ["PromptDispatchStore", "PromptRecoveryStore", "PromptSessionStore"]) expect(ports).toContain(`interface ${name}`);
    expect(ports).not.toContain("interface PromptRunStore");
    expect(workflow).toContain("stores:");
    expect(workflow).not.toContain("store: PromptRunStore");
    expect(executor).toContain("store: PromptDispatchStore");
    expect(scanner).toContain("store: PromptRecoveryStore");
    expect(bundle).toContain("readonly promptDispatch: PromptDispatchStore");
    expect(bundle).toContain("readonly promptRecovery: PromptRecoveryStore");
    expect(bundle).toContain("readonly promptSession: PromptSessionStore");
    expect(bundle).not.toContain("readonly promptRun: PromptRunStore");
  });

  it("exposes Primary runtime state through a read-only domain seam", () => {
    const statePort = readFileSync(new URL("../src/domain/ports/primary-runtime-state.ts", import.meta.url), "utf8");
    const promptRun = readFileSync(new URL("../src/coordinator/prompt-run-workflow.ts", import.meta.url), "utf8");
    const primary = readFileSync(new URL("../src/composition/create-primary-runtime.ts", import.meta.url), "utf8");
    const bindingSession = readFileSync(new URL("../src/composition/create-binding-session-runtime.ts", import.meta.url), "utf8");
    const commandControl = readFileSync(new URL("../src/composition/create-command-control-runtime.ts", import.meta.url), "utf8");
    const ingressRecovery = readFileSync(new URL("../src/composition/create-ingress-recovery-runtime.ts", import.meta.url), "utf8");
    const inboundRouting = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    expect(statePort).toContain("export interface PrimaryRuntimeStatePort");
    expect(statePort).toContain("activeTurn(bindingId: string)");
    expect(statePort).toContain("isBindingBusy(bindingId: string)");
    expect(promptRun).toContain("PromptRunWorkflowPort extends PrimaryRuntimeStatePort");
    expect(primary).toContain("const primaryState: PrimaryRuntimeStatePort = promptRun");
    expect(primary).toContain("return { externalTurns, promptRun, primaryState }");
    expect(bindingSession).not.toMatch(/promptRun\.isBindingBusy/);
    expect(commandControl).not.toMatch(/promptRun\.activeTurn/);
    expect(inboundRouting).toContain("primaryState: Pick<PrimaryRuntimeStatePort, \"activeTurn\">");
    expect(inboundRouting).not.toContain("PromptRunWorkflowPort");
    expect(ingressRecovery).toContain("primaryState, provisioning");
  });

  it("gives inbound message routing separate routing and prompt acceptance ports", () => {
    const workflow = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    const recoveryCapabilities = readFileSync(new URL("../src/store/sqlite/recovery-capability-store.ts", import.meta.url), "utf8");
    const bundle = readFileSync(new URL("../src/store/sqlite-store-bundle.ts", import.meta.url), "utf8");
    const graph = readFileSync(new URL("../src/store/sqlite/capability-graph.ts", import.meta.url), "utf8");
    expect(workflow).not.toContain("interface InboundMessageRoutingStore");
    expect(workflow).toContain("stores: { routing:");
    expect(workflow).toContain("promptAcceptance: PromptAcceptanceStore");
    expect(recoveryCapabilities).not.toContain("SqliteIngressCapabilityStore");
    expect(bundle).not.toContain("inboundMessages");
    expect(graph).not.toContain("inboundMessages:");
  });

  it("executes prompt acceptance effects only from a committed typed receipt", () => {
    const routing = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    const effects = readFileSync(new URL("../src/coordinator/prompt-acceptance-effects.ts", import.meta.url), "utf8");
    const context = readFileSync(new URL("../src/store/sqlite/context.ts", import.meta.url), "utf8");
    expect(routing).toContain("acceptPromptWithEffects");
    expect(routing).toContain("executePromptAcceptanceEffects(receipt, this.options)");
    expect(routing).not.toContain('scheduler.wake({ kind: "prompt-ready"');
    expect(effects).toContain("receipt.consumeEffects()");
    expect(context).toContain("receipt.markCommitted()");
    expect(context).toContain("receipt.markRolledBack()");
  });

  it("gives child composition factories consumer-shaped domain capabilities", () => {
    for (const file of ["create-outbound-runtime.ts", "create-worker-runtime.ts", "create-primary-runtime.ts", "create-application-runtime.ts", "create-binding-session-runtime.ts", "create-command-control-runtime.ts", "create-ingress-recovery-runtime.ts"]) {
      const source = readFileSync(new URL(`../src/composition/${file}`, import.meta.url), "utf8");
      expect(source).toMatch(/export interface [A-Za-z]+Stores/);
      expect(source).not.toContain("SqliteStoreBundle");
      expect(source).toMatch(/from \"\.\.\/domain\/ports\//);
      expect(source).not.toMatch(/stores:\s*SqliteStoreBundle/);
    }
  });

  it("keeps Primary tool runtime dependencies behind domain ports", () => {
    const port = readFileSync(new URL("../src/domain/ports/worker-card-display.ts", import.meta.url), "utf8");
    expect(port).toContain("export interface WorkerCardDisplayPort");
    for (const file of ["primary-tool-broker.ts", "primary-tool-gateway.ts"]) {
      const source = readFileSync(new URL(`../src/runtime/${file}`, import.meta.url), "utf8");
      expect(source).toContain("WorkerCardDisplayPort");
      expect(source).not.toMatch(/from \"\.\.\/coordinator\//);
    }
  });

  it("keeps runtime modules independent from coordinator implementations", () => {
    const runtimeDir = fileURLToPath(new URL("../src/runtime", import.meta.url));
    for (const entry of readdirSync(runtimeDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(entry.parentPath, entry.name), "utf8");
      expect(source, relative(runtimeDir, join(entry.parentPath, entry.name))).not.toMatch(/from \"(?:\.\.\/)+coordinator\//);
    }
  });

  it("keeps Worker turn observation consumers behind a domain port", () => {
    const port = readFileSync(new URL("../src/domain/ports/worker-turn-observation.ts", import.meta.url), "utf8");
    const observer = readFileSync(new URL("../src/coordinator/worker-turn-observer.ts", import.meta.url), "utf8");
    const scheduler = readFileSync(new URL("../src/events/instance-work-scheduler.ts", import.meta.url), "utf8");
    const supervisor = readFileSync(new URL("../src/coordinator/instance-turn-supervisor.ts", import.meta.url), "utf8");
    expect(port).toContain("export interface WorkerTurnObservationPort");
    expect(observer).toContain("implements WorkerTurnObservationPort");
    expect(scheduler).toContain('Pick<WorkerTurnObservationPort, "watch">');
    expect(scheduler).not.toContain("WorkerTurnObserver");
    expect(supervisor).toContain('Pick<WorkerTurnObservationPort, "recover">');
    expect(supervisor).not.toContain("WorkerTurnObserver");
  });

  it("keeps Agent driver lookup behind a domain catalog", () => {
    const contract = readFileSync(new URL("../src/domain/agent-runtime.ts", import.meta.url), "utf8");
    const registry = readFileSync(new URL("../src/runtime/agents/agent-driver.ts", import.meta.url), "utf8");
    expect(contract).toContain("export interface AgentDriverCatalog");
    expect(registry).toContain("implements AgentDriverCatalog");
    for (const file of [
      "instance-control-workflow.ts", "instance-interaction-workflow.ts", "prompt-run-workflow.ts",
      "prompt-turn-executor.ts", "binding-provisioning-workflow.ts"
    ]) {
      const source = readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8");
      expect(source).not.toContain("AgentDriverRegistry");
    }
    expect(readFileSync(new URL("../src/events/instance-work-scheduler.ts", import.meta.url), "utf8")).not.toContain("AgentDriverRegistry");
  });

  it("keeps Herdr pane operations behind a domain port", () => {
    const port = readFileSync(new URL("../src/domain/ports/pane-host.ts", import.meta.url), "utf8");
    const adapter = readFileSync(new URL("../src/runtime/herdr/pane-host.ts", import.meta.url), "utf8");
    expect(port).toContain("export interface PaneHost");
    expect(adapter).toContain("class HerdrPaneHost implements PaneHost");
    for (const file of ["instance-control-workflow.ts", "instance-runtime-reconciler.ts", "instance-turn-supervisor.ts"]) {
      const source = readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8");
      expect(source).toContain('from "../domain/ports/pane-host.js"');
      expect(source).not.toContain('from "../runtime/herdr/pane-host.js"');
    }
  });

  it("keeps Git worktree operations behind a domain port", () => {
    const port = readFileSync(new URL("../src/domain/ports/worktree.ts", import.meta.url), "utf8");
    const adapter = readFileSync(new URL("../src/runtime/worktree-manager.ts", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../src/coordinator/instance-control-workflow.ts", import.meta.url), "utf8");
    expect(port).toContain("export interface WorktreePort");
    expect(adapter).toContain("class WorktreeManager implements WorktreePort");
    expect(workflow).toContain("worktrees: WorktreePort");
    expect(workflow).not.toContain("WorktreeManager");
  });

  it("composes startup projection workflows through explicit consumer stores", () => {
    const converger = readFileSync(new URL("../src/coordinator/startup-view-converger.ts", import.meta.url), "utf8");
    const composition = readFileSync(new URL("../src/composition/create-ingress-recovery-runtime.ts", import.meta.url), "utf8");
    const outbound = readFileSync(new URL("../src/composition/create-outbound-runtime.ts", import.meta.url), "utf8");
    const projector = readFileSync(new URL("../src/events/conversation-view-projector.ts", import.meta.url), "utf8");
    const port = readFileSync(new URL("../src/domain/ports/card-convergence.ts", import.meta.url), "utf8");
    expect(converger).toContain("export interface StartupViewProjectionStores");
    expect(converger).toContain("startupViews: StartupViewStore");
    expect(converger).not.toContain("AnswerPageStore");
    expect(converger).not.toContain("MainCardStore");
    expect(converger).not.toMatch(/store as .*Store/);
    expect(converger).not.toContain("new AnswerPageWorkflow");
    expect(converger).not.toContain("new MainCardWorkflow");
    expect(projector).not.toMatch(/from .*coordinator/);
    expect(projector).not.toContain("new AnswerPageWorkflow");
    expect(projector).not.toContain("new MainCardWorkflow");
    expect(port).toContain("export interface AnswerPageConvergencePort");
    expect(port).toContain("export interface MainCardConvergencePort");
    expect(composition).toContain("new StartupViewConverger({");
    expect(composition).toContain("stores: { startupViews: stores.startupViews }");
    expect(composition).toContain("answerPages, mainCards");
    expect(outbound).toContain("new AnswerPageWorkflow");
    expect(outbound).toContain("new MainCardWorkflow");
    expect(readFileSync(new URL("../scripts/check-architecture-imports.mjs", import.meta.url), "utf8")).toContain('importer.startsWith("src/events/") && target.startsWith("src/coordinator/")');
  });

  it("bounds startup Answer convergence to durable actionable Run Cards", () => {
    const converger = readFileSync(new URL("../src/coordinator/startup-view-converger.ts", import.meta.url), "utf8");
    const startupStore = readFileSync(new URL("../src/store/sqlite/recovery-capability-store.ts", import.meta.url), "utf8");
    const projection = readFileSync(new URL("../src/store/sqlite/projection-store.ts", import.meta.url), "utf8");
    expect(converger).toContain("listActionableStartupRunCards");
    expect(converger).toContain("loadStartupMainRunCard");
    expect(converger).not.toContain("listRunCards(binding.id)");
    expect(startupStore).toContain("listActionableStartupRunCards");
    expect(startupStore).toContain("loadStartupMainRunCard");
    expect(projection).toContain("listActionableStartupRunCards(");
    expect(projection).toContain("loadStartupMainRunCard(");
  });

  it("gives instance workflows named consumer-shaped store interfaces", () => {
    const ports = readFileSync(new URL("../src/domain/ports/instance.ts", import.meta.url), "utf8");
    const consumers = [
      ["instance-messaging-workflow.ts", "InstanceMessagingStore"],
      ["instance-turn-supervisor.ts", "InstanceTurnSupervisionStore"],
      ["worker-turn-observer.ts", "WorkerTurnObservationStore"],
      ["instance-runtime-reconciler.ts", "InstanceRuntimeReconciliationStore"],
      ["instance-control-workflow.ts", "InstanceControlStore"]
    ] as const;
    for (const [file, interfaceName] of consumers) {
      expect(ports).toContain(`export type ${interfaceName} = Pick<InstanceStore,`);
      const source = readFileSync(new URL(`../src/coordinator/${file}`, import.meta.url), "utf8");
      expect(source).toContain(`store: ${interfaceName}`);
      expect(source).not.toMatch(/type Store =/);
      expect(source).not.toMatch(/store: [^;\n]*(?:InstanceLifecycleStore|InstanceTurnStore|InstanceStore)[^;\n]*&/);
    }
  });

  it("keeps context-owned delivery, runtime, and project-selection models out of the compatibility type barrel", () => {
    const types = readFileSync(new URL("../src/domain/types.ts", import.meta.url), "utf8");
    expect(types).toContain('export type { AnswerPage');
    expect(types).toContain('from "./delivery.js"');
    expect(types).toContain('from "./runtime-observation.js"');
    expect(types).toContain('from "./project-selection.js"');
    expect(types).toContain('from "./diagnostics.js"');
    expect(types).toContain('from "./inbound.js"');
    expect(types).not.toMatch(/export interface (?:Binding|PromptJob|OutboundReply|AnswerPage|ProjectSelection|HerdrPane|RuntimeObservation|IncomingLarkMessage|IncomingLarkCardAction|OutboxDispatcherDiagnostics|PromptWorkerDiagnostics)\b/);
  });

  it("keeps domain contracts independent from runtime implementations", () => {
    const domainDir = fileURLToPath(new URL("../src/domain", import.meta.url));
    for (const entry of readdirSync(domainDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(entry.parentPath, entry.name), "utf8");
      expect(source, relative(domainDir, join(entry.parentPath, entry.name))).not.toMatch(/from "(?:\.\.\/)+runtime\//);
    }
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
    expect(existsSync(new URL("../src/store/sqlite-store-kernel.ts", import.meta.url))).toBe(false);
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
      "prompt-run.ts",
      "turn-control.ts",
      "worker-card-display.ts",
      "worker-session-thread.ts",
      "workflow.ts"
    ]);
  });

  it("provides capability-oriented test construction without the compatibility facade", () => {
    const helper = readFileSync(new URL("./helpers/create-test-store-bundle.ts", import.meta.url), "utf8");
    const mainCardTests = readFileSync(new URL("./main-card-workflow.test.ts", import.meta.url), "utf8");
    expect(helper).toContain("createTestStoreBundle");
    expect(helper).toContain("SqliteStoreKernel");
    expect(helper).not.toContain("SqliteBindingStore");
    expect(mainCardTests).toContain("stores.mainCards");
    expect(mainCardTests).not.toContain("SqliteBindingStore");
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
    expect(facade).toContain("implements InstanceInteractionWorkflowPort");
    for (const path of ["card-action-router.ts", "inbound-message-routing-workflow.ts", "natural-language-command-workflow.ts"]) {
      const source = readFileSync(new URL(`../src/coordinator/${path}`, import.meta.url), "utf8");
      expect(source).toContain("InstanceInteractionWorkflowPort");
      expect(source).not.toMatch(/import type \{ InstanceInteractionWorkflow \}/);
    }
  });

  it("keeps instance control and messaging behind domain workflow ports", () => {
    const ports = readFileSync(new URL("../src/domain/ports/instance-workflows.ts", import.meta.url), "utf8");
    expect(ports).toContain("export interface InstanceControlPort");
    expect(ports).toContain("export interface InstanceMessagingPort");
    expect(readFileSync(new URL("../src/coordinator/instance-control-workflow.ts", import.meta.url), "utf8")).toContain("implements InstanceControlPort");
    expect(readFileSync(new URL("../src/coordinator/instance-messaging-workflow.ts", import.meta.url), "utf8")).toContain("implements InstanceMessagingPort");
    for (const path of [
      "instance-interaction-workflow.ts", "worker-session-thread-workflow.ts", "swarm-command-gateway.ts",
      "instance-interactions/conversation-context.ts", "instance-interactions/instance-command-actions.ts",
      "instance-interactions/instance-view-query.ts", "instance-interactions/worker-card-actions.ts",
      "instance-interactions/worker-lifecycle-actions.ts"
    ]) {
      const source = readFileSync(new URL(`../src/coordinator/${path}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/import type \{ Instance(?:Control|Messaging)Workflow \}/);
    }
  });

  it("keeps turn control consumers behind its domain port", () => {
    const port = readFileSync(new URL("../src/domain/ports/turn-control.ts", import.meta.url), "utf8");
    const implementation = readFileSync(new URL("../src/coordinator/turn-control-workflow.ts", import.meta.url), "utf8");
    expect(port).toContain("export interface TurnControlPort");
    expect(implementation).toContain("implements TurnControlPort");
    for (const path of [
      "src/coordinator/pane-control-workflow.ts",
      "src/coordinator/instance-messaging-workflow.ts",
      "src/composition/create-worker-runtime.ts",
      "src/composition/create-command-control-runtime.ts",
      "src/composition/create-application-runtime.ts"
    ]) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source).toContain("TurnControlPort");
      expect(source).not.toMatch(/import type \{ TurnControlWorkflow \}/);
    }
  });

  it("keeps Worker Session Thread protocol behind its deep modules", () => {
    const routing = readFileSync(new URL("../src/coordinator/inbound-message-routing-workflow.ts", import.meta.url), "utf8");
    const instances = readFileSync(new URL("../src/coordinator/instance-interaction-workflow.ts", import.meta.url), "utf8");
    const lifecycle = readFileSync(new URL("../src/coordinator/instance-interactions/worker-lifecycle-actions.ts", import.meta.url), "utf8");
    const cardContext = readFileSync(new URL("../src/store/sqlite/card-context-store.ts", import.meta.url), "utf8");
    const delivery = readFileSync(new URL("../src/store/sqlite/outbox-delivery-store.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../src/store/sqlite/worker-session-thread-store.ts", import.meta.url), "utf8");
    expect(routing).toContain("workerSessionThreads.handleMessage(message)");
    expect(routing).not.toContain("findWorkerSessionThread");
    expect(instances).not.toContain("handleWorkerThreadMessage");
    expect(lifecycle).not.toContain("legacy-unpublished");
    expect(cardContext).toContain("reserveWorkerMainPlacement");
    expect(cardContext).not.toContain("canonical-main");
    expect(delivery).toContain("settlePublication");
    expect(delivery).not.toContain("worker_session_threads");
    expect(store).toContain("worker_session_threads");
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
    const runner = readFileSync(new URL("../src/runtime/priority-reconciliation-runner.ts", import.meta.url), "utf8");
    const metrics = readFileSync(new URL("../src/runtime/reconciliation-run-metrics.ts", import.meta.url), "utf8");
    expect(herdrReconciler).toContain("PriorityReconciliationRunner");
    expect(herdrReconciler).not.toContain("ReconciliationRunMetrics");
    expect(runner).toContain("ReconciliationRunMetrics");
    expect(instanceReconciler).toContain("PriorityReconciliationRunner");
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
    expect(commands).toContain("sessionAdministration.rename");
    expect(commands).toContain("paneClosure.requestPaneClose");
    expect(commands).not.toContain("sessionAdministration.archive");
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

  it("keeps outbound intent persistence separate from Gateway delivery", () => {
    const writer = readFileSync(new URL("../src/events/outbound-intent-writer.ts", import.meta.url), "utf8");
    const dispatcher = readFileSync(new URL("../src/events/gateway-outbox-dispatcher.ts", import.meta.url), "utf8");
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
    expect(lifecycle).toContain('this.lifecycle.startRuntime({ name: "integrityAuditor", stage: "workers", kind: "non-writer" }, d.sqliteIntegrity)');
    expect(lifecycle).toContain("cleanupEntries: this.lifecycle.shutdownPlan()");
    expect(lifecycle).not.toContain("await d.sqliteIntegrity.stop(); return shutdown.shutdown(signal)");
  });

  it("pairs ordinary runtime startup and cleanup through the lifecycle ledger", () => {
    const lifecycle = readFileSync(new URL("../src/composition/managed-bridge-runtime.ts", import.meta.url), "utf8");
    expect(lifecycle).toContain("this.lifecycle.startResource({");
    expect(lifecycle.match(/this\.lifecycle\.startRuntime\(/g)?.length).toBe(10);
    for (const ordinaryResource of ["integrityAuditor", "healthServer", "publisher", "outboxRetention", "projector", "cardContextRebuilder", "queueFeedbackProjector", "paneRetention", "externalTurns", "instanceRuntime", "instanceTurns"]) {
      expect(lifecycle).not.toContain(`this.registerCleanup("${ordinaryResource}"`);
    }
    for (const specialResource of ["primaryToolGateway", "naturalLanguageCommands", "coordinator", "instanceWork", "herdrSocketEventDrain", "herdrSocketIngress"]) {
      expect(lifecycle).toContain(`this.registerCleanup("${specialResource}"`);
    }
  });

  it("keeps process entrypoint lifecycle-free beyond start and stop", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    for (const implementation of ["BridgeRuntimeShutdown", "cleanupStartupFailure", "startHealthServer", "InstanceLeaseController", "openSqliteLeaseBootstrap", "createBridgeRuntime"]) {
      expect(main).not.toContain(implementation);
    }
    expect(main).toContain("await runtime.start()");
    expect(main).toContain("await runtime.stop(signal)");
  });
});
