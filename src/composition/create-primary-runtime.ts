import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { HerdrPort, TraexControlPort, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import { cardKitPrimaryPresentation } from "../cards/cardkit-primary-presentation.js";
import { ExternalTurnObserver } from "../coordinator/external-turn-observer.js";
import type { MainCardWorkflowPort } from "../coordinator/main-card-workflow.js";
import { PromptRunWorkflow } from "../coordinator/prompt-run-workflow.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import { RuntimeLink } from "./runtime-link.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";

export type PrimaryRuntimeStores = Pick<SqliteStoreBundle, "externalTurns" | "promptRun" | "runtimeReconciliation">;

export function createPrimaryRuntime(options: {
  config: BridgeConfig; stores: PrimaryRuntimeStores; logger: Logger; herdr: HerdrPort; traexControl: TraexControlPort; bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler; outboundWork: OutboundWorkNotifier; transcriptReader: TraexTranscriptReaderPort;
  mainCards: Pick<MainCardWorkflowPort, "converge">;
  presentation?: PrimaryPresentation;
}) {
  const { config, stores, logger, herdr, traexControl, bus, scheduler, outboundWork, transcriptReader, mainCards } = options;
  const presentation = options.presentation ?? cardKitPrimaryPresentation;
  const promptRunLink = new RuntimeLink<PromptRunWorkflow>("Primary prompt runtime");
  const externalTurns = new ExternalTurnObserver({
    store: stores.externalTurns, transcriptReader, bus, outboundWork, logger, presentation,
    isBindingBusy: (bindingId) => promptRunLink.get().isBindingBusy(bindingId),
    wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }),
    pollIntervalMs: config.runtimeTuning.polling.externalTurnMs
  });
  const promptRun = new PromptRunWorkflow({
    store: stores.promptRun, herdr, traexControl, bus, scheduler, outboundWork, logger, presentation, turnTimeoutMs: config.turnTimeoutMs,
    adoptRuntimeIdentity: (input) => stores.runtimeReconciliation.applyRuntimeObservation(input),
    transcriptReader, mainCards, transcriptPolling: { identityMs: config.runtimeTuning.polling.transcriptIdentityMs, attachedMs: config.runtimeTuning.polling.attachedTranscriptMs }, handoffExternalTurns: (bindingId) => externalTurns.handoff(bindingId),
    observeSupersedingExternalTurn: (binding, prompt, observation) => externalTurns.observeSupersedingTurn(binding, prompt, observation),
    recoverExternalTurns: (binding, prompt) => externalTurns.recoverAfterDetachedTurn(binding, prompt)
  });
  promptRunLink.connect(promptRun);
  return { externalTurns, promptRun };
}
