import pino from "pino";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HerdrCliAdapter } from "./adapters/herdr-adapter.js";
import { LarkSdkAdapter } from "./adapters/lark-adapter.js";
import { loadConfig, validateProjectDirectories } from "./config.js";
import { InboundRouter } from "./coordinator/inbound-router.js";
import { BindingProvisioningWorkflow } from "./coordinator/binding-provisioning-workflow.js";
import { HerdrRuntimeReconciler } from "./coordinator/herdr-runtime-reconciler.js";
import { ModelSelectionWorkflow } from "./coordinator/model-selection-workflow.js";
import { PaneControlWorkflow } from "./coordinator/pane-control-workflow.js";
import { OperationsQueryWorkflow } from "./coordinator/operations-query-workflow.js";
import { SessionAdministrationWorkflow } from "./coordinator/session-administration-workflow.js";
import { DeliveryRecoveryWorkflow } from "./coordinator/delivery-recovery-workflow.js";
import { PaneClosureWorkflow } from "./coordinator/pane-closure-workflow.js";
import { PromptRunWorkflow } from "./coordinator/prompt-run-workflow.js";
import { RetiredPaneCleanupWorkflow } from "./coordinator/retired-pane-cleanup-workflow.js";
import { StartupViewConverger } from "./coordinator/startup-view-converger.js";
import { BridgeEventBus } from "./events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "./events/prompt-work-scheduler.js";
import { InProcessInboundWorkNotifier } from "./events/inbound-work-notifier.js";
import { ConversationViewProjector } from "./events/conversation-view-projector.js";
import { LarkOutboxDispatcher } from "./events/lark-outbox-dispatcher.js";
import { OutboundIntentWriter } from "./events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "./events/outbound-work-notifier.js";
import { startHealthServer } from "./health/server.js";
import { ExecFileCommandRunner } from "./infra/command-runner.js";
import { BridgeRuntimeShutdown } from "./runtime/shutdown.js";
import { InstanceLeaseController } from "./runtime/instance-lease.js";
import { WorkspaceSnapshotCache } from "./runtime/workspace-snapshot-cache.js";
import { HerdrCircuitBreaker } from "./runtime/herdr-circuit-breaker.js";
import { loadBuildIdentity } from "./runtime/build-identity.js";
import { HerdrEventInbox } from "./runtime/herdr-event-inbox.js";
import { HerdrSocketSubscriber } from "./runtime/herdr-socket-subscriber.js";
import { OutboxRetentionMaintainer } from "./runtime/outbox-retention-maintainer.js";
import { SqliteIntegrityAuditor } from "./runtime/sqlite-integrity-auditor.js";
import { AnswerPageWorkflow } from "./coordinator/answer-page-workflow.js";
import { MainCardWorkflow } from "./coordinator/main-card-workflow.js";
import { WorktreeNameResolver } from "./runtime/worktree-name-resolver.js";
import { safeLogError } from "./runtime/safe-error.js";
import { TraexTranscriptReader } from "./runtime/traex-transcript.js";
import { TraexSessionReporter } from "./runtime/traex-session-reporter.js";
import { SqliteBindingStore } from "./store/sqlite-store.js";

const buildIdentity = loadBuildIdentity(fileURLToPath(new URL("./build-info.json", import.meta.url)), process.env.BRIDGE_EXPECTED_BUILD_ID);
const config = loadConfig();
validateProjectDirectories(config.projects);
const logger = pino({ level: config.logLevel, serializers: { err: safeLogError }, redact: [
  "lark.appSecret", "appSecret", "*.appSecret", "token", "*.token", "authorization", "*.authorization",
  "cookie", "*.cookie", "password", "*.password", "privateKey", "*.privateKey"
] });
const startupStartedAt = Date.now();
const store = new SqliteBindingStore(config.databasePath);
const traexSessionReporter = new TraexSessionReporter(join(dirname(config.databasePath), "traex-session-reporter.sock"), store, logger);
const lease = new InstanceLeaseController(store, config.instanceLease, logger);
const runner = new ExecFileCommandRunner(config.commandTimeoutMs);
const worktreeNameResolver = new WorktreeNameResolver(runner, config.commandTimeoutMs);
let rawHerdr!: HerdrCliAdapter;
let herdrCircuitBreaker!: HerdrCircuitBreaker;
let herdr!: WorkspaceSnapshotCache;
const herdrSocketSubscriber = process.env.HERDR_SOCKET_PATH
  ? new HerdrSocketSubscriber(
      process.env.HERDR_SOCKET_PATH,
      async () => {
        const configuredWorkspaceIds = new Set(config.projects.map((project) => project.workspaceId));
        return (await herdr.listAllPanes()).filter((pane) => configuredWorkspaceIds.has(pane.workspaceId)).map((pane) => pane.paneId);
      },
      ({ workspaceIds }) => {
        for (const workspaceId of workspaceIds) herdr.invalidate(workspaceId);
        return coordinator.reconcileHerdrWorkspaces(workspaceIds.length > 0 ? workspaceIds : undefined);
      },
      logger
    )
  : null;
rawHerdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs, config.traex.permissionMode, herdrSocketSubscriber ?? undefined);
herdrCircuitBreaker = new HerdrCircuitBreaker(rawHerdr, config.herdrCircuitBreaker, logger);
herdr = new WorkspaceSnapshotCache(herdrCircuitBreaker, 2_000, logger);
const lark = new LarkSdkAdapter(config.lark, logger);
const bus = new BridgeEventBus(logger);
const scheduler = new InProcessPromptWorkScheduler(logger);
const inboundWork = new InProcessInboundWorkNotifier();
const outboundWork = new InProcessOutboundWorkNotifier(logger);
const outbound = new OutboundIntentWriter(store, outboundWork);
const channelPublisher = new LarkOutboxDispatcher(store, lark, logger, outboundWork);
const answerPages = new AnswerPageWorkflow(store, () => { outboundWork.wake(); }, logger);
const mainCards = new MainCardWorkflow(store, () => { outboundWork.wake(); }, logger);
const outboxRetention = new OutboxRetentionMaintainer(store, { retentionDays: config.outboxRetention.days, batchSize: config.outboxRetention.batchSize, maxBatches: config.outboxRetention.maxBatches }, logger);
const sqliteIntegrity = new SqliteIntegrityAuditor(store, config.sqliteIntegrityAudit, logger);
const transcriptReader = new TraexTranscriptReader({ sessionsRoot: config.traex.sessionsRoot });
const projector = new ConversationViewProjector(bus, store, outbound, channelPublisher, logger, answerPages, mainCards);
channelPublisher.connectPromptScheduler(scheduler);
const promptRun = new PromptRunWorkflow({ store, herdr, bus, scheduler, outboundWork, logger, turnTimeoutMs: config.turnTimeoutMs, transcriptReader });
const retiredPaneCleanup = new RetiredPaneCleanupWorkflow({ store, herdr, logger });
const provisioning = new BindingProvisioningWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound, outboundWork, scheduler, wakeRetiredPaneCleanup: () => void retiredPaneCleanup.requestScan(), sessionReporter: traexSessionReporter, logger });
const modelSelection = new ModelSelectionWorkflow({ config, store, herdr, outbound, outboundWork, scheduler, activeTurn: (bindingId) => promptRun.activeTurn(bindingId), logger });
const paneControl = new PaneControlWorkflow({ store, herdr, outbound, scheduler, model: modelSelection, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
const operationsQuery = new OperationsQueryWorkflow({ config, store, herdr, outbound, logger });
const sessionAdministration = new SessionAdministrationWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound, outboundWork, scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
const deliveryRecovery = new DeliveryRecoveryWorkflow({ store, lark, outbound, outboundWork, logger });
const paneClosure = new PaneClosureWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
const reconciler = new HerdrRuntimeReconciler({
  projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher: outbound, logger,
  discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler,
  isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId),
  worktreeNameFor: (cwd) => worktreeNameResolver.resolve(cwd)
});
const startupViews = new StartupViewConverger(config, store, outbound, outboundWork, answerPages, mainCards, logger);
const coordinator = new InboundRouter({ config, store, herdr, lark, lifecycleEvents: bus, outbound, outboundWork, logger, scheduler, inboundWork, promptRun, provisioning, modelSelection, paneControl, operationsQuery, sessionAdministration, deliveryRecovery, paneClosure, reconciler, retiredPaneCleanup, startupViews });
let runtimeShutdown: BridgeRuntimeShutdown | null = null;
const herdrEventInbox = process.env.HERDR_PLUGIN_ROOT
  ? new HerdrEventInbox(Number(process.env.HERDR_BRIDGE_EVENT_PORT || "18787"), (workspaceIds) => coordinator.reconcileHerdrWorkspaces(workspaceIds), logger)
  : null;
try {
  await herdrEventInbox?.start();
  lease.acquire();
  const writeFence = lease.writeFence();
  store.activateWriteFence(writeFence.ownerId, writeFence.fencingToken);
  await traexSessionReporter.start();
  sqliteIntegrity.start();
  await sqliteIntegrity.run();
  const healthServer = await startHealthServer({ ...config.http, store, herdr, lark, projects: config.projects, lease, workspaceCache: herdr, herdrCircuitBreaker, startupRecovery: coordinator, sqliteIntegrity, lifecycleEvents: bus, outboxDispatcher: channelPublisher, promptWorker: promptRun, ...(herdrSocketSubscriber ? { herdrSocket: herdrSocketSubscriber } : {}), buildIdentity });
  runtimeShutdown = new BridgeRuntimeShutdown({ ...(herdrEventInbox ? { herdrEventInbox } : {}), ...(herdrSocketSubscriber ? { herdrSocketSubscriber } : {}), traexSessionReporter, coordinator, projector, publisher: channelPublisher, healthServer, lease, store, logger });
  const shutdown = runtimeShutdown;
  const stopRuntime = async (signal: string) => { outboxRetention.stop(); await sqliteIntegrity.stop(); return shutdown.shutdown(signal); };
  lease.start(() => stopRuntime("lease-lost").then(() => { process.exitCode = 1; }));
  channelPublisher.start();
  outboxRetention.start();
  projector.start();
  process.once("SIGINT", () => { void stopRuntime("SIGINT"); });
  process.once("SIGTERM", () => { void stopRuntime("SIGTERM"); });
  logger.info({ event: "bridge-startup-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], databasePath: config.databasePath, http: config.http, logLevel: config.logLevel }, "bridge startup started");
  await coordinator.start();
  herdrEventInbox?.activate();
  herdrSocketSubscriber?.startEvents();
  logger.info({ event: "bridge-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], http: config.http, durationMs: Date.now() - startupStartedAt, outcome: "ready" }, "bridge started");
} catch (error) {
  logger.fatal({ event: "bridge-startup-failed", err: safeLogError(error), durationMs: Date.now() - startupStartedAt, outcome: "failed" }, "bridge failed to start");
  outboxRetention.stop();
  await sqliteIntegrity.stop();
  if (runtimeShutdown) await runtimeShutdown.shutdown("startup-failure");
  else { await Promise.all([herdrEventInbox?.stop(), herdrSocketSubscriber?.stop(), traexSessionReporter.stop()]); lease.release(); store.close(); }
  process.exitCode = 1;
}
