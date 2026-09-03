import type { Logger } from "pino";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { InboundRoutingStore } from "../domain/ports/workflow.js";
import type { Binding, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, ProjectSelection } from "../domain/types.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { CardInteractionWorkflowPort } from "./card-interaction-workflow.js";
import type { DeliveryRecoveryWorkflowPort } from "./delivery-recovery-workflow.js";
import type { InstanceInteractionWorkflow } from "./instance-interaction-workflow.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ActiveWorkTracker } from "../runtime/active-work-tracker.js";

export interface CardActionRouterPort {
  handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void>;
  stop(): Promise<void>;
}

interface Options {
  chatId: string; allowedOpenIds: readonly string[]; adminOpenIds: readonly string[];
  projects: BridgeConfig["projects"];
  store: Pick<InboundRoutingStore, "getBinding">;
  provisioning: Pick<BindingProvisioningWorkflowPort, "attach" | "completeSelection">;
  cardInteractions: CardInteractionWorkflowPort;
  modelSelection: ModelSelectionWorkflowPort;
  deliveryRecovery: DeliveryRecoveryWorkflowPort;
  instanceInteractions?: InstanceInteractionWorkflow;
  logger: Pick<Logger, "info" | "error">;
  enqueueInitialPrompt(binding: Binding, selection: ProjectSelection): Promise<void>;
}

export class CardActionRouter implements CardActionRouterPort {
  private readonly projectsById: Map<string, BridgeConfig["projects"][number]>;
  private readonly tasks = new ActiveWorkTracker();

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.projects.map((project) => [project.id, project]));
  }

  async handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (action.chatId !== this.options.chatId) return;
    if (!this.options.allowedOpenIds.includes(action.operatorOpenId)) return { toast: { type: "error", content: "你没有访问权限。" } };
    const instanceInteraction = await this.options.instanceInteractions?.handleCardAction(action);
    if (instanceInteraction) return instanceInteraction;
    const interaction = await this.options.cardInteractions.handle(action);
    if (interaction) return interaction;
    const model = parseModelSelectionAction(action.value, action.option);
    if (model) {
      if (!this.isCreator(action, model.bindingId)) return { toast: { type: "error", content: "只有会话创建者可以切换模型。" } };
      return this.options.modelSelection.selectModel(action, model.bindingId, model.model);
    }
    const mode = parseModelModeSelectionAction(action.value, action.option);
    if (mode) {
      if (!this.isCreator(action, mode.bindingId)) return { toast: { type: "error", content: "只有会话创建者可以切换模型。" } };
      return this.options.modelSelection.selectModelMode(action, mode.bindingId, mode.operationId, mode.mode);
    }
    const open = parseOpenThreadAction(action.value);
    if (open) return this.options.deliveryRecovery.openThread(action, open.bindingId);
    const deadLetter = parseDeadLetterAction(action.value);
    if (deadLetter) return this.options.deliveryRecovery.decideDeadLetter(action, deadLetter.replyId, deadLetter.action);
    const selection = parseProjectAction(action.value);
    if (selection) {
      if (!this.isAdmin(action)) return { toast: { type: "error", content: "你没有管理权限。" } };
      this.track(this.options.provisioning.completeSelection(action, selection.selectionId, selection.projectId)
        .then(async (completed) => { if (completed) await this.options.enqueueInitialPrompt(completed.binding, completed.selection); })
        .catch((error) => this.options.logger.error({ event: "project-selection-background-failed", err: safeLogError(error), selectionId: selection.selectionId, projectId: selection.projectId, outcome: "checkpointed" }, "background project selection failed after the card callback returned")));
      return { toast: { type: "success", content: "项目创建已开始。" } };
    }
    const paneClaim = parsePaneClaimAction(action.value);
    if (!paneClaim) return;
    if (!this.isAdmin(action)) return { toast: { type: "error", content: "你没有管理权限。" } };
    const project = this.projectsById.get(paneClaim.projectId);
    if (!project || project.workspaceId !== paneClaim.workspaceId) return;
    const synthetic: IncomingLarkMessage = { eventId: `claim:${action.messageId}:${paneClaim.paneId}`, messageId: action.messageId, parentMessageId: null, chatId: action.chatId, topicId: null, rootMessageId: action.messageId, actorOpenId: action.operatorOpenId, text: `/swarm attach ${projectSpaceName(project)} ${paneClaim.paneId}`, mentionsBot: true, isRootMessage: true };
    const attached = await this.options.provisioning.attach(synthetic, projectSpaceName(project), paneClaim.paneId);
    this.options.logger.info({ event: "space-pane-claim-decided", projectId: project.id, workspaceId: project.workspaceId, paneId: paneClaim.paneId, outcome: attached ? "attached" : "rejected" }, "processed Space pane claim");
  }

  async stop(): Promise<void> { await this.tasks.settle(); }

  private track(task: Promise<void>): void {
    this.tasks.track(task);
  }

  private isCreator(action: IncomingLarkCardAction, bindingId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    return Boolean(binding && binding.chatId === action.chatId && (binding.creatorOpenId === null || binding.creatorOpenId === action.operatorOpenId));
  }

  private isAdmin(action: IncomingLarkCardAction): boolean { return this.options.adminOpenIds.includes(action.operatorOpenId); }
}

function parseOpenThreadAction(value: unknown): { bindingId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "open_project_thread" && typeof item.bindingId === "string" ? { bindingId: item.bindingId } : null; }
function parseModelSelectionAction(value: unknown, option?: string | null): { bindingId: string; model: string } | null { if (!value || typeof value !== "object" || !option) return null; const item = value as Record<string, unknown>; return item.action === "select_model" && typeof item.bindingId === "string" && /^[a-z0-9][a-z0-9._:+/-]{0,127}$/i.test(option) ? { bindingId: item.bindingId, model: option } : null; }
function parseModelModeSelectionAction(value: unknown, option?: string | null): { bindingId: string; operationId: string; mode: string } | null { if (!value || typeof value !== "object" || !option) return null; const item = value as Record<string, unknown>; return item.action === "select_model_mode" && typeof item.bindingId === "string" && typeof item.operationId === "string" && option.length <= 128 ? { bindingId: item.bindingId, operationId: item.operationId, mode: option } : null; }
function parseDeadLetterAction(value: unknown): { action: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return (item.action === "retry_dead_letter" || item.action === "dismiss_dead_letter") && typeof item.replyId === "string" ? { action: item.action, replyId: item.replyId } : null; }
function parsePaneClaimAction(value: unknown): { projectId: string; workspaceId: string; paneId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "claim_pane" && typeof item.projectId === "string" && typeof item.workspaceId === "string" && typeof item.paneId === "string" ? { projectId: item.projectId, workspaceId: item.workspaceId, paneId: item.paneId } : null; }
function parseProjectAction(value: unknown): { selectionId: string; projectId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "select_project" && typeof item.selectionId === "string" && typeof item.projectId === "string" ? { selectionId: item.selectionId, projectId: item.projectId } : null; }
