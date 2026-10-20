import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { AgentTranscriptReaderPort } from "../domain/ports/external.js";
import { feishuGatewayPrimaryPresentation } from "../gateways/feishu/presentation.js";
import { ExternalTurnObserver } from "../coordinator/external-turn-observer.js";
import { BindingPromptWorkflow } from "../coordinator/binding-prompt-workflow.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { ExternalTurnObservationStore } from "../domain/ports/workflow.js";
import type { PrimaryRuntimeStatePort } from "../domain/ports/primary-runtime-state.js";
import { CoreSessionIngestionSupervisor, type CoreSessionIngestionSupervisorOptions } from "../coordinator/core-session-ingestion-supervisor.js";
import type { CanonicalInputRecoverySummary } from "../domain/ports/agent-input.js";
import type { Binding } from "../domain/types.js";
import type { AgentInstance } from "../domain/agent-instance.js";
import type { CoreSessionEventMultiplexFrame, CoreSessionEventMultiplexTarget } from "../domain/herdr-events.js";
import { safeLogError } from "../runtime/safe-error.js";

export interface PrimaryRuntimeStores {
  externalTurns: ExternalTurnObservationStore;
}

export function createPrimaryRuntime(options: {
  config: BridgeConfig; stores: PrimaryRuntimeStores; logger: Logger; bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler; outboundWork: OutboundWorkNotifier; transcriptReader: AgentTranscriptReaderPort;
  sessionIngestor?: CoreSessionIngestionSupervisorOptions["ingestor"] | null;
  resolveSessionSource?(binding: Binding): ReturnType<NonNullable<CoreSessionIngestionSupervisorOptions["resolveSource"]>>;
  workerSessions?: { listWorkerSessions(): AgentInstance[] };
  resolveWorkerSessionSource?(instance: AgentInstance): ReturnType<NonNullable<CoreSessionIngestionSupervisorOptions["resolveWorkerSource"]>>;
  onWorkerSessionIngested?(instanceId: string, paneId: string): void | Promise<void>;
  reconcileCanonicalHumanMessages?(): number | Promise<number>;
  retireLegacyInputCards?(limit?: number): number | Promise<number>;
  recoverCanonicalTurns?(): CanonicalInputRecoverySummary | void | Promise<CanonicalInputRecoverySummary | void>;
  requiresSessionIngestion?(ownerKind: "primary" | "worker", ownerId: string, generation: number): boolean;
  presentation?: PrimaryPresentation;
  bindingPrompts: BindingPromptWorkflow;
  sessionEventMultiplex?: {
    replaceTargets(targets: readonly CoreSessionEventMultiplexTarget[]): Promise<number>;
    clearTargets(): Promise<void>;
    connectFrames(consumer: (frame: CoreSessionEventMultiplexFrame, generation: number) => void): void;
    connectActivation(consumer: (targets: readonly CoreSessionEventMultiplexTarget[], generation: number) => void): void;
    connectTargetRefresh(consumer: () => Promise<readonly CoreSessionEventMultiplexTarget[]>): void;
    connectTransportState(consumer: (state: "connected" | "disconnected", generation: number) => void): void;
  };
}) {
  const { config, stores, logger, bus, scheduler, outboundWork, transcriptReader } = options;
  const presentation = options.presentation ?? feishuGatewayPrimaryPresentation;
  const bindingPrompts = options.bindingPrompts;
  const externalTurns = new ExternalTurnObserver({
    store: stores.externalTurns, workflow: bindingPrompts, transcriptReader, bus, outboundWork, logger, presentation,
    wakePrompt: () => undefined,
    pollIntervalMs: config.runtimeTuning.polling.externalTurnMs,
    recoveryNotFoundMaxAttempts: config.runtimeTuning.recovery.externalTurnNotFoundMaxAttempts
  });
  const coreSessionIngestion = options.sessionIngestor ? new CoreSessionIngestionSupervisor({
    routes: stores.externalTurns,
    ingestor: options.sessionIngestor,
    ...(options.resolveSessionSource ? { resolveSource: options.resolveSessionSource } : {}),
    ...(options.workerSessions ? { workers: options.workerSessions } : {}),
    ...(options.resolveWorkerSessionSource ? { resolveWorkerSource: options.resolveWorkerSessionSource } : {}),
    ...(options.onWorkerSessionIngested ? { onWorkerIngested: options.onWorkerSessionIngested } : {}),
    ...(options.reconcileCanonicalHumanMessages ? { reconcileCanonicalHumanMessages: options.reconcileCanonicalHumanMessages } : {}),
    ...(options.retireLegacyInputCards ? { retireLegacyInputCards: options.retireLegacyInputCards, wakeOutbound: () => outboundWork.wake() } : {}),
    ...(options.recoverCanonicalTurns ? { recoverCanonicalTurns: options.recoverCanonicalTurns } : {}),
    ...(options.requiresSessionIngestion ? { requiresIngestion: options.requiresSessionIngestion } : {}),
    ...(options.sessionEventMultiplex ? {
      replaceMultiplexTargets: options.sessionEventMultiplex.replaceTargets,
      clearMultiplexTargets: options.sessionEventMultiplex.clearTargets
    } : {}),
    onIngested: (bindingId) => externalTurns.catchUp(bindingId),
    logger,
    pollIntervalMs: config.runtimeTuning.polling.externalTurnMs
  }) : null;
  if (coreSessionIngestion && options.sessionEventMultiplex) {
    options.sessionEventMultiplex.connectActivation((targets, generation) => {
      coreSessionIngestion.activateMultiplexTargets(targets, generation);
    });
    options.sessionEventMultiplex.connectTargetRefresh(() => coreSessionIngestion.refreshMultiplexTargets());
    options.sessionEventMultiplex.connectTransportState((state, generation) => {
      void coreSessionIngestion.handleMultiplexTransportState(state, generation).catch((error: unknown) => {
        logger.warn({ event: "core-session-multiplex-transport-state-failed", state, generation, err: safeLogError(error), outcome: "v2_fallback" }, "Core session multiplex transport state handling failed");
      });
    });
    options.sessionEventMultiplex.connectFrames((frame, generation) => {
      void coreSessionIngestion.handleMultiplexFrame(frame, generation).catch((error: unknown) => {
        logger.warn({ event: "core-session-multiplex-frame-failed", err: safeLogError(error), outcome: "v2_fallback" }, "Core session multiplex frame handling failed");
      });
    });
  }
  const primaryState: PrimaryRuntimeStatePort = {
    activeTurn: () => null,
    isBindingBusy: (bindingId) => {
      const binding = stores.externalTurns.getBinding(bindingId);
      return binding?.lastAgentState === "working" || binding?.lastAgentState === "blocked";
    }
  };
  return { externalTurns, coreSessionIngestion, primaryState, bindingPrompts };
}
