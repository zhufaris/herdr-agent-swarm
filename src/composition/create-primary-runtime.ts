import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { HerdrPort, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import { cardKitPrimaryPresentation } from "../cards/cardkit-primary-presentation.js";
import { ExternalTurnObserver } from "../coordinator/external-turn-observer.js";
import type { MainCardWorkflowPort } from "../coordinator/main-card-workflow.js";
import { PromptRunWorkflow } from "../coordinator/prompt-run-workflow.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { SqliteBindingStore } from "../store/sqlite-store.js";
import { RuntimeLink } from "./runtime-link.js";

export function createPrimaryRuntime(options: {
  config: BridgeConfig; store: SqliteBindingStore; logger: Logger; herdr: HerdrPort; bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler; outboundWork: OutboundWorkNotifier; transcriptReader: TraexTranscriptReaderPort;
  mainCards: Pick<MainCardWorkflowPort, "converge">;
}) {
  const { config, store, logger, herdr, bus, scheduler, outboundWork, transcriptReader, mainCards } = options;
  const promptRunLink = new RuntimeLink<PromptRunWorkflow>("Primary prompt runtime");
  const externalTurns = new ExternalTurnObserver({
    store, transcriptReader, bus, outboundWork, logger, presentation: cardKitPrimaryPresentation,
    isBindingBusy: (bindingId) => promptRunLink.get().isBindingBusy(bindingId),
    wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId })
  });
  const promptRun = new PromptRunWorkflow({
    store, herdr, bus, scheduler, outboundWork, logger, presentation: cardKitPrimaryPresentation, turnTimeoutMs: config.turnTimeoutMs,
    transcriptReader, mainCards, handoffExternalTurns: (bindingId) => externalTurns.handoff(bindingId),
    observeSupersedingExternalTurn: (binding, prompt, observation) => externalTurns.observeSupersedingTurn(binding, prompt, observation),
    recoverExternalTurns: (binding, prompt) => externalTurns.recoverAfterDetachedTurn(binding, prompt)
  });
  promptRunLink.connect(promptRun);
  return { externalTurns, promptRun };
}
