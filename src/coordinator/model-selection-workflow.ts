import type { Logger } from "pino";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ModelSelectionStore } from "../domain/ports/workflow.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { Binding, IncomingLarkCardAction, IncomingLarkMessage, PaneControlOperation, ProjectConfig } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { resolveCatalogModel } from "../domain/model-selection.js";
import type { MainCardWorkflowPort } from "./main-card-workflow.js";

interface Options { config: BridgeConfig; store: ModelSelectionStore; herdr: HerdrPort; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; scheduler: PromptWorkScheduler; presentation: Pick<ApplicationPresentation, "modelResult" | "modelSelection" | "requestRejected">; mainCards?: Pick<MainCardWorkflowPort, "converge">; activeTurn(bindingId: string): { promptId: string; paneId: string } | null; logger: Logger; }

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
    return this.queryOrSelect(binding, name, message.actorOpenId, message.messageId);
  }

  async selectModel(action: IncomingLarkCardAction, bindingId: string, model: string): Promise<void> {
    const binding = this.options.store.getBinding(bindingId);
    if (!binding?.paneId || binding.chatId !== action.chatId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return;
    await this.queryOrSelect(binding, model, action.operatorOpenId, action.messageId);
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
    await this.options.outbound.enqueueCardUpdate(binding.id, messageId, `model:${operationId}:unsupported`, this.options.presentation.modelResult({
      bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: binding.paneId, output: UNSUPPORTED_MODEL_MESSAGE, switched: false
    }));
  }

  private async queryOrSelect(binding: Binding, requested: string | null, actorOpenId: string, messageId: string): Promise<boolean> {
    const session = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
      ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
    if (!session || session.source !== "herdr-traex-shim" || session.agent !== "traex" || session.kind !== "id" || !this.options.herdr.listModels) {
      await this.options.outbound.enqueueCardUpdate(binding.id, messageId, `model:${messageId}:unavailable`, this.options.presentation.modelResult({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: binding.paneId!, output: "当前 Session 不支持结构化模型切换。", switched: false }));
      return false;
    }
    try {
      const models = await this.options.herdr.listModels(binding.paneId!, session);
      let notice: string | undefined;
      let selected = !requested;
      if (requested) {
        const resolved = resolveCatalogModel(requested, models.map((model) => model.name));
        if (resolved.outcome !== "resolved") { notice = resolved.outcome === "ambiguous" ? "模型名称不唯一，请从列表选择。" : "当前 Session 的模型目录中没有该模型。"; }
        else {
          const accepted = this.options.store.acceptModelPreference({ bindingId: binding.id, bindingGeneration: binding.generation, model: resolved.name });
          selected = accepted.outcome === "accepted";
          notice = accepted.outcome === "accepted" ? `已保存 ${resolved.name}，将在下一条普通消息生效。` : accepted.outcome === "busy" ? "上一项模型切换仍在应用或待确认，暂不能覆盖。" : "Session 已变化，请重新打开模型列表。";
          this.options.store.audit({ actorOpenId, action: "model.select", target: resolved.name, outcome: accepted.outcome });
          if (accepted.outcome === "accepted") {
            await this.convergeMainCard(binding.id);
            this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
          }
        }
      }
      const preference = this.options.store.getModelPreference(binding.id);
      await this.options.outbound.enqueueCardUpdate(binding.id, messageId, `model:${messageId}:${preference?.desiredRevision ?? "list"}`, this.options.presentation.modelSelection({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: binding.paneId!, models, preference, ...(notice ? { notice } : {}) }));
      return selected;
    } catch (error) {
      await this.options.outbound.enqueueCardUpdate(binding.id, messageId, `model:${messageId}:failed`, this.options.presentation.modelResult({ bindingId: binding.id, spaceName: this.spaceNameFor(binding), paneId: binding.paneId!, output: `模型目录读取失败：${errorMessage(error)}`, switched: false }));
      return false;
    }
  }

  private spaceNameFor(binding: Binding): string {
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : this.uniqueProjectByWorkspace.get(binding.workspaceId);
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }

  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> {
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason));
  }

  private async convergeMainCard(bindingId: string): Promise<void> {
    try { await this.options.mainCards?.converge(bindingId); }
    catch (error) { this.options.logger.warn({ event: "model-main-card-convergence-failed", bindingId, error: errorMessage(error), outcome: "deferred" }, "deferred model state projection to normal Main Card convergence"); }
  }
}
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " " ).slice(0, 300); }

function uniqueProjectsByWorkspace(projects: readonly ProjectConfig[]): Map<string, ProjectConfig | null> {
  const result = new Map<string, ProjectConfig | null>();
  for (const project of projects) result.set(project.workspaceId, result.has(project.workspaceId) ? null : project);
  return result;
}
