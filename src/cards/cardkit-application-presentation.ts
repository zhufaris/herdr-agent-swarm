import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { createCardKitPrimaryPresentation, type CardKitPresentationLimits } from "./cardkit-primary-presentation.js";
import { cardKitWorkerPresentation } from "./cardkit-worker-presentation.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard, renderWorkerNewTaskCard, renderWorkerTaskInstructionCard } from "./instance-control-card.js";
import { renderInstanceDetailCard } from "./instance-detail-card.js";
import { renderInstanceDirectoryCard } from "./instance-directory-card.js";
import { interactionToast, renderInteractionGuidanceCard, renderMoreActionsCard, renderPrimaryContinuationInputCard, renderQueueSummaryCard, renderReattachInputCard, renderRenameInputCard } from "./interaction-card.js";
import { renderModelResultCard, renderModelSelectionCard } from "./model-card.js";
import { renderFailureCards, renderSessionCards } from "./operations-card.js";
import { renderAttachStatusCard, renderAwakeStatusCard, renderHelpCard, renderProjectSelectionStatusCard, renderProjectSelectorCard, renderSkipStatusCard } from "./run-card.js";
import { renderSpaceDirectoryCards } from "./space-directory-card.js";
import { renderWorkerMainCard } from "./worker-main-card.js";

export function createCardKitApplicationPresentation(limits: CardKitPresentationLimits): ApplicationPresentation {
  const primary = createCardKitPrimaryPresentation(limits);
  return {
  ...primary, ...cardKitWorkerPresentation,
  projectSelector: (input) => renderProjectSelectorCard(input, limits.payloadLimitChars), projectSelectionStatus: renderProjectSelectionStatusCard, attachStatus: renderAttachStatusCard,
  help: renderHelpCard, awakeStatus: renderAwakeStatusCard, skipStatus: renderSkipStatusCard,
  modelSelection: renderModelSelectionCard, modelResult: renderModelResultCard, sessions: (input) => renderSessionCards(input, limits.payloadLimitChars), failures: (input, notice) => renderFailureCards(input, notice, limits.payloadLimitChars), spaces: (input) => renderSpaceDirectoryCards(input, limits.payloadLimitChars),
  interactionToast, interactionGuidance: renderInteractionGuidanceCard, moreActions: renderMoreActionsCard, renameInput: renderRenameInputCard, reattachInput: renderReattachInputCard, primaryContinuationInput: renderPrimaryContinuationInputCard, queueSummary: renderQueueSummaryCard,
  instanceDirectory: (input) => renderInstanceDirectoryCard(input, limits.payloadLimitChars), instanceDetail: renderInstanceDetailCard, instanceCreate: renderInstanceCreateCard, instanceSteer: renderInstanceSteerCard, instanceRemovalPlan: renderInstanceRemovalPlanCard,
  workerTaskInstruction: renderWorkerTaskInstructionCard, workerNewTask: renderWorkerNewTaskCard, workerMain: renderWorkerMainCard
  };
}

export const cardKitApplicationPresentation = createCardKitApplicationPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
