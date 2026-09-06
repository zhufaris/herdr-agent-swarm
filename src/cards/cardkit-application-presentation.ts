import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { cardKitPrimaryPresentation } from "./cardkit-primary-presentation.js";
import { cardKitWorkerPresentation } from "./cardkit-worker-presentation.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard, renderWorkerNewTaskCard, renderWorkerTaskInstructionCard } from "./instance-control-card.js";
import { renderInstanceDetailCard } from "./instance-detail-card.js";
import { renderInstanceDirectoryCard } from "./instance-directory-card.js";
import { interactionToast, renderInteractionGuidanceCard, renderMoreActionsCard, renderQueueSummaryCard, renderReattachInputCard, renderRenameInputCard } from "./interaction-card.js";
import { renderModelResultCard, renderModelSelectionCard } from "./model-card.js";
import { renderFailureCards, renderSessionCards } from "./operations-card.js";
import { renderAttachStatusCard, renderAwakeStatusCard, renderHelpCard, renderProjectSelectionStatusCard, renderProjectSelectorCard, renderSkipStatusCard } from "./run-card.js";
import { renderSpaceDirectoryCards } from "./space-directory-card.js";
import { renderWorkerMainCard } from "./worker-main-card.js";

export const cardKitApplicationPresentation: ApplicationPresentation = {
  ...cardKitPrimaryPresentation, ...cardKitWorkerPresentation,
  projectSelector: renderProjectSelectorCard, projectSelectionStatus: renderProjectSelectionStatusCard, attachStatus: renderAttachStatusCard,
  help: renderHelpCard, awakeStatus: renderAwakeStatusCard, skipStatus: renderSkipStatusCard,
  modelSelection: renderModelSelectionCard, modelResult: renderModelResultCard, sessions: renderSessionCards, failures: renderFailureCards, spaces: renderSpaceDirectoryCards,
  interactionToast, interactionGuidance: renderInteractionGuidanceCard, moreActions: renderMoreActionsCard, renameInput: renderRenameInputCard, reattachInput: renderReattachInputCard, queueSummary: renderQueueSummaryCard,
  instanceDirectory: renderInstanceDirectoryCard, instanceDetail: renderInstanceDetailCard, instanceCreate: renderInstanceCreateCard, instanceSteer: renderInstanceSteerCard, instanceRemovalPlan: renderInstanceRemovalPlanCard,
  workerTaskInstruction: renderWorkerTaskInstructionCard, workerNewTask: renderWorkerNewTaskCard, workerMain: renderWorkerMainCard
};
