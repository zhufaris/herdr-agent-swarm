import type { Logger } from "pino";
import type { BridgeConfig } from "../../src/config.js";
import { BindingPromptWorkflow } from "../../src/coordinator/binding-prompt-workflow.js";
import type { LifecycleEventPublisher } from "../../src/events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../../src/events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../../src/events/prompt-work-scheduler.js";
import type { PrimaryPresentation } from "../../src/domain/ports/presentation.js";
import type { TestStoreBundle } from "./create-test-store-bundle.js";

export function createTestBindingPromptWorkflow(options: {
  config: Pick<BridgeConfig, "lark" | "projects" | "defaultProjectId" | "maxQueueDepth">;
  stores: TestStoreBundle;
  lifecycleEvents: LifecycleEventPublisher;
  outboundWork: OutboundWorkNotifier;
  scheduler: PromptWorkScheduler;
  logger: Logger;
  presentation: PrimaryPresentation;
}): BindingPromptWorkflow {
  const { stores } = options;
  return new BindingPromptWorkflow({
    config: options.config,
    store: {
      getCurrentGoal: stores.promptAcceptance.getCurrentGoal.bind(stores.promptAcceptance),
      acceptPrompt: stores.promptAcceptance.acceptPrompt.bind(stores.promptAcceptance),
      acceptPromptWithEffects: stores.promptAcceptance.acceptPromptWithEffects.bind(stores.promptAcceptance),
      acceptImmediateNativeInputBatch: stores.promptAcceptance.acceptImmediateNativeInputBatch.bind(stores.promptAcceptance),
      acceptCollectingNativeInput: stores.promptAcceptance.acceptCollectingNativeInput.bind(stores.promptAcceptance),
      formDueNativeInputBatch: stores.promptAcceptance.formDueNativeInputBatch.bind(stores.promptAcceptance),
      hasAcceptedPromptSource: stores.promptAcceptance.hasAcceptedPromptSource.bind(stores.promptAcceptance),
      getNativeInputBacklog: stores.promptAcceptance.getNativeInputBacklog.bind(stores.promptAcceptance),
      acceptInterruptedContinuation: stores.promptAcceptance.acceptInterruptedContinuation.bind(stores.promptAcceptance),
      acceptPrimaryCompletionAction: stores.promptAcceptance.acceptPrimaryCompletionAction.bind(stores.promptAcceptance),
      ignorePrimaryCompletionAction: stores.promptAcceptance.ignorePrimaryCompletionAction.bind(stores.promptAcceptance),
      resolvePrimaryCompletionChoice: stores.promptAcceptance.resolvePrimaryCompletionChoice.bind(stores.promptAcceptance),
      audit: stores.promptAcceptance.audit.bind(stores.promptAcceptance),
      countPendingPrompts: stores.promptAcceptance.countPendingPrompts.bind(stores.promptAcceptance),
      adoptExternalTurn: stores.externalTurns.adoptExternalTurn.bind(stores.externalTurns),
      getPrompt: stores.promptDispatch.getPrompt.bind(stores.promptDispatch),
      claimPromptTranscriptTurn: stores.promptDispatch.claimPromptTranscriptTurn.bind(stores.promptDispatch),
      completeTurn: stores.promptDispatch.completeTurn.bind(stores.promptDispatch),
      failPrompt: stores.promptDispatch.failPrompt.bind(stores.promptDispatch),
      markPromptObservationDetached: stores.promptDispatch.markPromptObservationDetached.bind(stores.promptDispatch)
    },
    lifecycleEvents: options.lifecycleEvents,
    outboundWork: options.outboundWork,
    scheduler: options.scheduler,
    logger: options.logger,
    presentation: options.presentation
  });
}
