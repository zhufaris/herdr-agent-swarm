import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderModelResultCard } from "../cards/model-card.js";
import { renderMessageRejectedCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ModelSelectionStore } from "../domain/ports/workflow.js";
import type { Binding, IncomingLarkCardAction, IncomingLarkMessage, PaneControlOperation, ProjectConfig } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";

interface Options { config: BridgeConfig; store: ModelSelectionStore; herdr: HerdrPort; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; scheduler: PromptWorkScheduler; activeTurn(bindingId: string): { promptId: string; paneId: string } | null; logger: Logger; }

const UNSUPPORTED_MODEL_MESSAGE = "运行中的 Agent 不支持远程切换模型。请在创建 Agent 时选择模型，或显式替换 Agent 后使用新模型。";

export interface ModelSelectionWorkflowPort {
  recover(): Promise<void>;
  shutdown(): void;
  runModel(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean>;
  selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void>;
  selectModelMode(action: IncomingLarkCardAction, bindingId: string, operationId: string, mode: string): Promise<void>;
  execute(operation: PaneControlOperation, binding: Binding): Promise<void>;
}

export class ModelSelectionWorkflow implements ModelSelectionWorkflowPort {
  private readonly projectsById: Map<string, ProjectConfig>;
  private readonly uniqueProjectByWorkspace: Map<string, ProjectConfig | null>;

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.config.projects.map((project) => [project.id, project]));
    this.uniqueProjectByWorkspace = uniqueProjectsByWorkspace(options.config.projects);
  }

  shutdown(): void {}

  async recover(): Promise<void> {
    for (const operation of this.options.store.listRecoverablePaneControlOperations()) {
      if (operation.kind !== "model") continue;
      this.options.store.finishPaneControlOperation(operation.id, "rejected", UNSUPPORTED_MODEL_MESSAGE);
      const binding = this.options.store.getBinding(operation.bindingId);
      if (binding) await this.publishUnsupported(binding, operation.sourceMessageId, operation.id);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: operation.bindingId });
    }
  }

  async execute(operation: PaneControlOperation, binding: Binding): Promise<void> {
    this.options.store.finishPaneControlOperation(operation.id, "rejected", UNSUPPORTED_MODEL_MESSAGE);
    await this.publishUnsupported(binding, operation.sourceMessageId, operation.id);
    this.options.store.audit({ actorOpenId: operation.actorOpenId, action: "model.run", target: operation.payload ?? "list", outcome: "unsupported" });
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
  }

  async runModel(message: IncomingLarkMessage, binding: Binding | null, name: string | null): Promise<boolean> {
    const target = name ?? "list";
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") {
      await this.reject(message, "这个话题没有活动的 TraeX Agent。");
      this.options.store.audit({ actorOpenId: message.actorOpenId, action: "model.run", target, outcome: "inactive_binding" });
      return false;
    }
    const accepted = this.options.store.acceptPaneControlOperation({
      id: randomUUID(), idempotencyKey: `message:${message.messageId}:model`, bindingId: binding.id, paneId: binding.paneId, terminalId: binding.traexSessionId,
      bindingGeneration: binding.generation, kind: "model", payload: name, actorOpenId: message.actorOpenId, sourceMessageId: message.messageId
    });
    if (accepted.inserted) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
    return true;
  }

  async selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void> {
    const binding = this.options.store.getBinding(bindingId);
    if (!binding?.paneId || binding.chatId !== action.chatId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return;
    const accepted = this.options.store.acceptPaneControlOperation({
      id: randomUUID(), idempotencyKey: `card:${action.messageId}:${binding.id}:model:${model}`, bindingId: binding.id, paneId: binding.paneId, terminalId: binding.traexSessionId,
      bindingGeneration: binding.generation, kind: "model", payload: model, actorOpenId: action.operatorOpenId, sourceMessageId: action.messageId
    });
    if (accepted.inserted) this.options.scheduler.wake({ kind: "control-ready", bindingId: binding.id });
  }

  async selectModelMode(action: IncomingLarkCardAction, bindingId: string, operationId: string, _mode: string): Promise<void> {
    const binding = this.options.store.getBinding(bindingId);
    const operation = this.options.store.getPaneControlOperation(operationId);
    if (!binding || binding.chatId !== action.chatId || !operation || operation.bindingId !== binding.id || operation.kind !== "model") return;
    if (operation.state === "applied") this.options.store.rejectAppliedPaneControlOperation(operation.id, UNSUPPORTED_MODEL_MESSAGE);
    else if (operation.state === "accepted" || operation.state === "running") this.options.store.finishPaneControlOperation(operation.id, "rejected", UNSUPPORTED_MODEL_MESSAGE);
    await this.publishUnsupported(binding, action.messageId, operation.id);
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
  }

  private async publishUnsupported(binding: Binding, messageId: string, operationId: string): Promise<void> {
    if (!binding.paneId) return;
    await this.options.outbound.enqueueCardUpdate(binding.id, messageId, `model:${operationId}:unsupported`, renderModelResultCard({
      bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: binding.paneId, output: UNSUPPORTED_MODEL_MESSAGE, switched: false
    }));
  }

  private spaceNameFor(binding: Binding): string {
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : this.uniqueProjectByWorkspace.get(binding.workspaceId);
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }

  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> {
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason));
  }
}

function uniqueProjectsByWorkspace(projects: readonly ProjectConfig[]): Map<string, ProjectConfig | null> {
  const result = new Map<string, ProjectConfig | null>();
  for (const project of projects) result.set(project.workspaceId, result.has(project.workspaceId) ? null : project);
  return result;
}
