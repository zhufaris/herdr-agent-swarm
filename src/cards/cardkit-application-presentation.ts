import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { createCardKitPrimaryPresentation, type CardKitPresentationLimits } from "./cardkit-primary-presentation.js";
import { cardKitWorkerPresentation } from "./cardkit-worker-presentation.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard, renderWorkerNewTaskCard, renderWorkerTaskInstructionCard } from "./instance-control-card.js";
import { renderInstanceDetailCard } from "./instance-detail-card.js";
import { renderInstanceDirectoryCard } from "./instance-directory-card.js";
import { interactionToast, renderInteractionGuidanceCard, renderMoreActionsCard, renderPrimaryContinuationInputCard, renderQueueSummaryCard, renderReattachInputCard, renderRenameInputCard } from "./interaction-card.js";
import { renderModelResultCard, renderModelSelectionCard } from "./model-card.js";
import { renderFailureCards, renderSessionCards } from "./operations-card.js";
import { renderAttachStatusCard, renderAwakeStatusCard, renderHelpCard, renderProjectSelectionStatusCard, renderProjectSelectorCard } from "./run-card.js";
import { renderSpaceDirectoryCards } from "./space-directory-card.js";
import { renderTopicPaneDirectoryCard } from "./topic-pane-directory-card.js";
import { renderWorkerMainCard, renderWorkerStatusSnapshot, renderWorkerThreadEntryCard, renderWorkerThreadEntryReadyCard } from "./worker-main-card.js";
import type { ProjectConfig } from "../domain/types.js";
import { renderNaturalLanguageCommandConfirmationCard, renderNaturalLanguageCommandGuidanceCard } from "./natural-language-command-card.js";
import { renderCommandStatusCard } from "./command-status-card.js";
import { renderOrchestratorClearResultCard } from "./orchestrator-clear-card.js";
import { renderInputCard } from "./input-card.js";
import { planAndRenderTurnCard, renderTurnCard } from "./turn-card.js";
import { renderDeliveryQuarantineReview } from "./delivery-quarantine-review.js";
import { renderCompletionReviewCard } from "./completion-actions.js";

export type CardKitApplicationPresentation = Omit<ApplicationPresentation, "turnCardSemanticPolicy">;

export function createCardKitApplicationPresentation(limits: CardKitPresentationLimits, projects: readonly ProjectConfig[] = [], runtimeIdentity: { branch: string | null; gitCommit: string | null } | null = null): CardKitApplicationPresentation {
  const primary = createCardKitPrimaryPresentation(limits);
  return {
  ...primary, ...cardKitWorkerPresentation,
  deliveryQuarantineReview: renderDeliveryQuarantineReview,
  inputCard: renderInputCard,
  turnCard: (view, page, options) => "segmentId" in view
    ? renderTurnCard(view, page, { ...options, runtimeIdentity }, limits.payloadLimitChars)
    : renderInputCard(view),
  turnCardPage: (view, page, options, payloadLimit = limits.payloadLimitChars) =>
    planAndRenderTurnCard(view, page, { ...options, runtimeIdentity }, payloadLimit),
  completionReview: renderCompletionReviewCard,
  commandStatus: renderCommandStatusCard,
  naturalLanguageCommandConfirmation: renderNaturalLanguageCommandConfirmationCard, naturalLanguageCommandGuidance: renderNaturalLanguageCommandGuidanceCard,
  orchestratorClearResult: renderOrchestratorClearResultCard,
  commandResult: ({ title, text }) => ({ schema: "2.0", config: { update_multi: true, summary: { content: title } }, header: { title: { tag: "plain_text", content: title }, template: "blue" }, body: { elements: [{ tag: "markdown", content: text }] } }),
  projectDirectory: ({ projects, selectedProjectId }) => ({ schema: "2.0", config: { update_multi: true, summary: { content: "Projects" } }, header: { title: { tag: "plain_text", content: "Projects" }, template: "blue" }, body: { elements: projects.map((project) => ({ tag: "markdown", content: `${project.id === selectedProjectId ? "▶ " : ""}**${project.displayName}** · \`${project.id}\`\n${project.description}` })) } }),
  projectSelector: (input) => renderProjectSelectorCard(input, limits.payloadLimitChars), projectSelectionStatus: renderProjectSelectionStatusCard, attachStatus: renderAttachStatusCard,
  help: renderHelpCard, awakeStatus: renderAwakeStatusCard,
  modelSelection: renderModelSelectionCard, modelResult: renderModelResultCard, sessions: (input) => renderSessionCards(input.sessions, limits.payloadLimitChars, input.nextCursor), failures: (input, notice) => renderFailureCards(input, notice, limits.payloadLimitChars), spaces: (input) => renderSpaceDirectoryCards(input, limits.payloadLimitChars), topicPanes: renderTopicPaneDirectoryCard,
  interactionToast, interactionGuidance: renderInteractionGuidanceCard, moreActions: renderMoreActionsCard, renameInput: renderRenameInputCard, reattachInput: renderReattachInputCard, primaryContinuationInput: renderPrimaryContinuationInputCard, queueSummary: renderQueueSummaryCard,
  instanceDirectory: (input) => renderInstanceDirectoryCard(input, limits.payloadLimitChars), instanceDetail: renderInstanceDetailCard, instanceCreate: renderInstanceCreateCard, instanceSteer: renderInstanceSteerCard, instanceRemovalPlan: renderInstanceRemovalPlanCard,
  workerTaskInstruction: renderWorkerTaskInstructionCard, workerNewTask: renderWorkerNewTaskCard, workerMain: (view) => { const projectDisplayName = projects.find((project) => project.id === view.projectId)?.displayName; return renderWorkerMainCard(view, projectDisplayName ? { projectDisplayName } : {}); }, workerStatusSnapshot: renderWorkerStatusSnapshot, workerThreadEntry: renderWorkerThreadEntryCard, workerThreadEntryReady: renderWorkerThreadEntryReadyCard
  };
}

export const cardKitApplicationPresentation = createCardKitApplicationPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
