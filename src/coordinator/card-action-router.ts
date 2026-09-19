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
import { parseCardActionCommand, type CardActionCommand } from "./card-action-command.js";
import { ProjectCatalog } from "./project-catalog.js";
import type { NaturalLanguageCommandWorkflow } from "./natural-language-command-workflow.js";

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
  naturalLanguageCommands?: Pick<NaturalLanguageCommandWorkflow, "decide">;
  logger: Pick<Logger, "info" | "error">;
  enqueueInitialPrompt(binding: Binding, selection: ProjectSelection): Promise<void>;
}

export class CardActionRouter implements CardActionRouterPort {
  private readonly projects: ProjectCatalog;
  private readonly tasks = new ActiveWorkTracker();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.projects);
  }

  handle(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (this.stopping) return Promise.resolve(staleAction());
    return this.tasks.track(this.handleAdmitted(action));
  }

  private async handleAdmitted(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (action.chatId !== this.options.chatId) return;
    if (!(this.options.allowedOpenIds ?? []).includes(action.operatorOpenId)) return { toast: { type: "error", content: "你没有访问权限。" } };
    const command = parseCardActionCommand(action.value, action.option);
    switch (command.kind) {
      case "natural-language-confirmation":
        return this.options.naturalLanguageCommands?.decide(action, command.confirmationId, command.decision) ?? staleAction();
      case "instance":
        return this.options.instanceInteractions?.handleCardAction(action, command) ?? staleAction();
      case "session":
        return this.options.cardInteractions.handle(action, command);
      case "model":
        if (!this.isCreator(action, command.bindingId)) return { toast: { type: "error", content: "只有会话创建者可以切换模型。" } };
        return this.options.modelSelection.selectModel(action, command.bindingId, command.model);
      case "model-mode":
        if (!this.isCreator(action, command.bindingId)) return { toast: { type: "error", content: "只有会话创建者可以切换模型。" } };
        return this.options.modelSelection.selectModelMode(action, command.bindingId, command.operationId, command.mode);
      case "open-thread":
        return this.options.deliveryRecovery.openThread(action, command.bindingId);
      case "pane-directory": {
        const outcome = await this.options.deliveryRecovery.forwardPaneThread(action, command);
        if (outcome === "stale") return { toast: { type: "warning", content: "该 Thread 尚未就绪或已失效，请刷新 `/swarm panes` 后重试。" } };
        return { toast: { type: "success", content: command.action === "pane_primary_thread_forward" ? "已将原始 Primary Thread 发送到群底部。" : "已将原始 Worker Thread 发送到群底部。" } };
      }
      case "dead-letter":
        return this.options.deliveryRecovery.decideDeadLetter(action, command.replyId, command.decision);
      case "project-selection": {
      if (!this.isAdmin(action)) return { toast: { type: "error", content: "你没有管理权限。" } };
      this.track(this.options.provisioning.completeSelection(action, command.selectionId, command.projectId)
        .then(async (completed) => { if (completed) await this.options.enqueueInitialPrompt(completed.binding, completed.selection); })
        .catch((error) => this.options.logger.error({ event: "project-selection-background-failed", err: safeLogError(error), selectionId: command.selectionId, projectId: command.projectId, outcome: "checkpointed" }, "background project selection failed after the card callback returned")));
      return { toast: { type: "success", content: "项目创建已开始。" } };
      }
      case "pane-claim": {
        if (!this.isAdmin(action)) return { toast: { type: "error", content: "你没有管理权限。" } };
        const project = this.projects.projectById(command.projectId);
        if (!project || project.workspaceId !== command.workspaceId) return staleAction();
        const synthetic: IncomingLarkMessage = { eventId: `claim:${action.messageId}:${command.paneId}`, messageId: action.messageId, parentMessageId: null, chatId: action.chatId, topicId: null, rootMessageId: action.messageId, actorOpenId: action.operatorOpenId, text: `/swarm attach ${projectSpaceName(project)} ${command.paneId}`, mentionsBot: true, isRootMessage: true };
        const attached = await this.options.provisioning.attach(synthetic, projectSpaceName(project), command.paneId);
        this.options.logger.info({ event: "space-pane-claim-decided", projectId: project.id, workspaceId: project.workspaceId, paneId: command.paneId, outcome: attached ? "attached" : "rejected" }, "processed Space pane claim");
        return;
      }
      case "retired":
        return retiredAction(command.action);
      case "unknown":
        return staleAction();
      default:
        return assertNever(command);
    }
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.stopPromise ??= this.tasks.settle();
    return this.stopPromise;
  }

  private track(task: Promise<void>): void {
    this.tasks.track(task);
  }

  private isCreator(action: IncomingLarkCardAction, bindingId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    return Boolean(binding && binding.chatId === action.chatId && (binding.creatorOpenId === null || binding.creatorOpenId === action.operatorOpenId));
  }

  private isAdmin(action: IncomingLarkCardAction): boolean { return (this.options.adminOpenIds ?? []).includes(action.operatorOpenId); }
}

function retiredAction(action: Extract<CardActionCommand, { kind: "retired" }>["action"]): LarkCardActionResult {
  return action === "open_supplement" || action === "submit_supplement"
    ? { toast: { type: "warning", content: "当前 Agent 不支持立即补充；请将内容作为普通消息发送。" } }
    : staleAction();
}
function staleAction(): LarkCardActionResult { return { toast: { type: "warning", content: "该操作已失效，请刷新卡片后重试。" } }; }
function assertNever(value: never): never { throw new Error(`unhandled card action command: ${String(value)}`); }
