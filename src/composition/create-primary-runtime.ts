import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { HerdrPort, TraexControlPort, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import { feishuGatewayPrimaryPresentation } from "../gateways/feishu/presentation.js";
import { ExternalTurnObserver } from "../coordinator/external-turn-observer.js";
import type { MainCardWorkflowPort } from "../coordinator/main-card-workflow.js";
import { PromptRunWorkflow } from "../coordinator/prompt-run-workflow.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { RuntimeLink } from "./runtime-link.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { PromptDispatchStore, PromptRecoveryStore, PromptSessionStore } from "../domain/ports/prompt.js";
import type { ExternalTurnObservationStore } from "../domain/ports/workflow.js";
import type { PrimaryRuntimeStatePort } from "../domain/ports/primary-runtime-state.js";

export interface PrimaryRuntimeStores {
  externalTurns: ExternalTurnObservationStore; promptDispatch: PromptDispatchStore; promptRecovery: PromptRecoveryStore;
  promptSession: PromptSessionStore; runtimeReconciliation: RuntimeReconciliationStore;
}

export function createPrimaryRuntime(options: {
  config: BridgeConfig; stores: PrimaryRuntimeStores; logger: Logger; herdr: HerdrPort; traexControl: TraexControlPort; bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler; outboundWork: OutboundWorkNotifier; transcriptReader: TraexTranscriptReaderPort;
  mainCards: Pick<MainCardWorkflowPort, "converge">;
  agentDrivers: AgentDriverRegistry;
  presentation?: PrimaryPresentation;
}) {
  const { config, stores, logger, herdr, traexControl, bus, scheduler, outboundWork, transcriptReader, mainCards, agentDrivers } = options;
  const presentation = options.presentation ?? feishuGatewayPrimaryPresentation;
  const promptRunLink = new RuntimeLink<PromptRunWorkflow>("Primary prompt runtime");
  const externalTurns = new ExternalTurnObserver({
    store: stores.externalTurns, transcriptReader, bus, outboundWork, logger, presentation,
    isBindingBusy: (bindingId) => promptRunLink.get().isBindingBusy(bindingId),
    wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }),
    pollIntervalMs: config.runtimeTuning.polling.externalTurnMs
  });
  const promptRun = new PromptRunWorkflow({
    stores: { dispatch: stores.promptDispatch, recovery: stores.promptRecovery, session: stores.promptSession }, herdr, traexControl, agentDrivers, bus, scheduler, outboundWork, logger, presentation, turnTimeoutMs: config.turnTimeoutMs,
    adoptRuntimeIdentity: (input) => stores.runtimeReconciliation.applyRuntimeObservation(input),
    transcriptReader, mainCards, transcriptPolling: { identityMs: config.runtimeTuning.polling.transcriptIdentityMs, attachedMs: config.runtimeTuning.polling.attachedTranscriptMs }, handoffExternalTurns: (bindingId) => externalTurns.handoff(bindingId),
    observeSupersedingExternalTurn: (binding, prompt, observation) => externalTurns.observeSupersedingTurn(binding, prompt, observation),
    recoverExternalTurns: (binding, prompt) => externalTurns.recoverAfterDetachedTurn(binding, prompt)
  });
  promptRunLink.connect(promptRun);
  const primaryState: PrimaryRuntimeStatePort = promptRun;
  return { externalTurns, promptRun, primaryState };
}
