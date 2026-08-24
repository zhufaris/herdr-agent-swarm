import type { Logger } from "pino";
import type { BridgeConfig } from "../../src/config.js";
import { BindingProvisioningWorkflow } from "../../src/coordinator/binding-provisioning-workflow.js";
import { HerdrRuntimeReconciler } from "../../src/coordinator/herdr-runtime-reconciler.js";
import { InboundRouter } from "../../src/coordinator/inbound-router.js";
import { OperationsWorkflow } from "../../src/coordinator/operations-workflow.js";
import { PromptRunWorkflow } from "../../src/coordinator/prompt-run-workflow.js";
import { StartupViewConverger } from "../../src/coordinator/startup-view-converger.js";
import type { HerdrPort, LarkPort } from "../../src/domain/ports.js";
import type { BridgeEventBus } from "../../src/events/bridge-event-bus.js";
import { InProcessInboundWorkNotifier, type InboundWorkNotifier } from "../../src/events/inbound-work-notifier.js";
import type { LarkOutboxDispatcher } from "../../src/events/lark-outbox-dispatcher.js";
import { InProcessPromptWorkScheduler, type PromptWorkScheduler } from "../../src/events/prompt-work-scheduler.js";
import type { SqliteBindingStore } from "../../src/store/sqlite-store.js";

export function createTestRouter(
  config: BridgeConfig,
  store: SqliteBindingStore,
  herdr: HerdrPort,
  lark: LarkPort,
  bus: BridgeEventBus,
  outbound: LarkOutboxDispatcher,
  logger: Logger,
  shutdownGraceMs = 30_000,
  scheduler: PromptWorkScheduler = new InProcessPromptWorkScheduler(logger),
  inboundWork: InboundWorkNotifier = new InProcessInboundWorkNotifier()
): InboundRouter {
  outbound.connectPromptScheduler(scheduler);
  const promptRun = new PromptRunWorkflow({ store, herdr, bus, scheduler, channelPublisher: outbound, logger, turnTimeoutMs: config.turnTimeoutMs, shutdownGraceMs });
  const provisioning = new BindingProvisioningWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound, scheduler, logger });
  const operations = new OperationsWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound, scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), logger });
  const reconciler = new HerdrRuntimeReconciler({
    projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher: outbound, logger,
    discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler,
    isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId)
  });
  return new InboundRouter({
    config, store, herdr, lark, lifecycleEvents: bus, outbound, logger, scheduler, inboundWork,
    promptRun, provisioning, operations, reconciler, startupViews: new StartupViewConverger(config, store, outbound)
  });
}
