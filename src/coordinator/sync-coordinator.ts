import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderHelpCard, renderRunCard } from "../cards/run-card.js";
import type { BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand } from "../domain/commands.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingStorePort, HerdrPort, LarkPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { Binding, EventOrigin, IncomingLarkMessage } from "../domain/types.js";
import type { BridgeEventBus } from "../events/bridge-event-bus.js";
import { cleanTerminalOutput, outputFingerprint } from "../runtime/output.js";

export class SyncCoordinator {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly observedAgentStates = new Map<string, Binding["lastAgentState"]>();
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStorePort,
    private readonly herdr: HerdrPort,
    private readonly lark: LarkPort,
    private readonly bus: BridgeEventBus,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    const recovered = this.store.recoverRunningPrompts();
    if (recovered > 0) this.logger.warn({ recovered }, "recovered interrupted prompt jobs");
    await this.herdr.assertWorkspace(this.config.herdr.workspaceId);
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error) => this.logger.error({ err: error }, "reconciliation failed"));
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref();
    await this.lark.start((message) => this.handleMessage(message));
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) this.scheduleWorker(binding.id);
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.lark.stop();
    await Promise.allSettled(this.workers.values());
  }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    if (message.chatId !== this.config.lark.chatId || this.store.hasProcessedEvent(message.eventId) || this.store.isBridgeMessage(message.messageId)) return;
    this.store.recordProcessedEvent(message.eventId, message.messageId);
    const command = parseCommand(message.text);
    const binding = this.store.findBindingByLarkScope(message.topicId, message.rootMessageId);

    try {
      if (command?.kind === "help") {
        await this.replyStandalone(message.rootMessageId ?? message.messageId, renderHelpCard());
      } else if (command?.kind === "new") {
        if (binding?.state === "active") throw new Error("This topic is already bound to a TraeX pane");
        await this.createFromLark(message, command.title, null);
      } else if (command?.kind === "status") {
        if (!binding) throw new Error("This topic is not bound to Herdr");
        await this.emitState(binding, binding.lastAgentState);
      } else if (command?.kind === "rename") {
        if (!binding?.paneId || binding.state !== "active") throw new Error("This topic has no active Herdr binding");
        await this.herdr.renamePane(binding.paneId, command.title);
        this.store.updateBinding(binding.id, { title: command.title });
        await this.publish(binding.id, "BindingRenamed", "lark", { title: command.title });
        this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.rename", target: binding.id, outcome: "success" });
      } else if (command?.kind === "close") {
        if (!binding) throw new Error("This topic is not bound to Herdr");
        this.store.updateBinding(binding.id, { state: "archived" });
        await this.publish(binding.id, "BindingArchived", "lark", { reason: "Archived from Lark; TraeX was left running" });
        this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.archive", target: binding.id, outcome: "success" });
      } else if (binding?.state === "active") {
        await this.enqueue(binding, message);
      } else if (message.isRootMessage && message.mentionsBot) {
        await this.createFromLark(message, deriveTopicTitle(message.text), message.text);
      }
    } catch (error) {
      this.logger.error({ err: error, eventId: message.eventId, messageId: message.messageId }, "Lark message handling failed");
      const failedBinding = binding ?? this.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
      if (failedBinding) await this.publish(failedBinding.id, "TurnFailed", "bridge", { promptId: message.messageId, error: errorMessage(error), queueDepth: this.store.countPendingPrompts(failedBinding.id) });
    }
  }

  async reconcile(): Promise<void> {
    const panes = await this.herdr.listPanes(this.config.herdr.workspaceId);
    const paneIds = new Set(panes.map((pane) => pane.paneId));
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) {
      if (binding.paneId && !paneIds.has(binding.paneId)) {
        this.store.updateBinding(binding.id, { state: "orphaned" });
        await this.publish(binding.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${binding.paneId} no longer exists` });
      }
    }

    for (const pane of panes) {
      if (!pane.foregroundExecutables.includes("traex")) continue;
      const existing = this.store.findBindingByPane(pane.paneId);
      if (!existing) {
        await this.createFromHerdr(pane.paneId, pane.label ?? `TraeX ${pane.paneId}`);
        this.observedAgentStates.set(pane.paneId, pane.agentState);
        continue;
      }
      const previous = this.observedAgentStates.get(pane.paneId) ?? existing.lastAgentState;
      this.observedAgentStates.set(pane.paneId, pane.agentState);
      if (existing.state !== "active" || this.workers.has(existing.id) || previous === pane.agentState) continue;
      this.store.updateBinding(existing.id, { lastAgentState: pane.agentState });
      await this.publish(existing.id, "AgentStateChanged", "herdr", {
        state: pane.agentState, queueDepth: this.store.countPendingPrompts(existing.id)
      });
      if (previous === "working" && (pane.agentState === "done" || pane.agentState === "idle")) {
        await this.publishLocalTurn(existing, pane.paneId);
      }
    }
  }

  private async publishLocalTurn(binding: Binding, paneId: string): Promise<void> {
    const answer = cleanTerminalOutput(await this.herdr.readOutput(paneId, 240));
    if (!answer) return;
    const fingerprint = outputFingerprint(answer);
    if (fingerprint === binding.lastOutputFingerprint) return;
    this.store.updateBinding(binding.id, { lastOutputFingerprint: fingerprint });
    await this.publish(binding.id, "TurnCompleted", "herdr", {
      promptId: `local:${fingerprint.slice(0, 16)}`, answer, queueDepth: this.store.countPendingPrompts(binding.id)
    });
  }

  private async createFromLark(message: IncomingLarkMessage, title: string, initialPrompt: string | null): Promise<void> {
    const bindingId = randomUUID();
    let binding = this.store.createPendingBinding({
      id: bindingId, workspaceId: this.config.herdr.workspaceId, chatId: message.chatId,
      topicId: message.topicId ?? message.messageId, rootMessageId: message.rootMessageId ?? message.messageId, title
    });
    await this.publish(binding.id, "BindingCreated", "lark", { title, workspaceId: binding.workspaceId, paneId: null });
    try {
      const pane = await this.herdr.createPane(binding.workspaceId, this.config.herdr.workspaceCwd);
      await this.herdr.startTraex(pane.paneId, this.config.traex.executable);
      binding = this.store.updateBinding(binding.id, { paneId: pane.paneId, state: "active", lastAgentState: "idle" });
      await this.publish(binding.id, "BindingActivated", "bridge", { paneId: pane.paneId, topicId: binding.topicId! });
      this.store.audit({ actorOpenId: message.actorOpenId, action: "binding.create", target: binding.id, outcome: "success" });
      if (initialPrompt) await this.enqueue(binding, message, initialPrompt);
    } catch (error) {
      this.store.updateBinding(binding.id, { state: "failed" });
      await this.publish(binding.id, "TurnFailed", "bridge", { promptId: message.messageId, error: errorMessage(error), queueDepth: 0 });
      throw error;
    }
  }

  private async createFromHerdr(paneId: string, title: string): Promise<void> {
    const id = randomUUID();
    let binding = this.store.createPendingBinding({ id, workspaceId: this.config.herdr.workspaceId, chatId: this.config.lark.chatId, topicId: null, rootMessageId: null, title });
    const createdEvent = this.event(binding.id, "BindingCreated", "herdr", { title, workspaceId: binding.workspaceId, paneId });
    const initialView = reduceTopicView(initialTopicView(binding.id), createdEvent);
    this.store.saveTopicView(initialView);
    const topic = await this.lark.createTopic(renderRunCard(initialView));
    this.store.recordBridgeMessage(topic.rootMessageId);
    binding = this.store.updateBinding(binding.id, {
      paneId, topicId: topic.topicId, rootMessageId: topic.rootMessageId, statusMessageId: topic.rootMessageId, state: "active"
    });
    await this.bus.publish(createdEvent);
    await this.publish(binding.id, "BindingActivated", "bridge", { paneId, topicId: topic.topicId });
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text): Promise<void> {
    if (this.store.countPendingPrompts(binding.id) >= this.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    const prompt = this.store.enqueuePrompt({ id: randomUUID(), bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body });
    const depth = this.store.countPendingPrompts(binding.id);
    await this.publish(binding.id, "PromptQueued", "lark", { promptId: prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    this.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.queue", target: binding.id, outcome: "success" });
    this.scheduleWorker(binding.id);
  }

  private scheduleWorker(bindingId: string): void {
    if (this.workers.has(bindingId)) return;
    const worker = this.drain(bindingId).finally(() => this.workers.delete(bindingId));
    this.workers.set(bindingId, worker);
  }

  private async drain(bindingId: string): Promise<void> {
    let binding = this.store.listBindings().find((item) => item.id === bindingId);
    if (!binding?.paneId || binding.state !== "active") return;
    const paneId = binding.paneId;
    for (let prompt = this.store.claimNextPrompt(bindingId); prompt; prompt = this.store.claimNextPrompt(bindingId)) {
      const queueDepth = this.store.countPendingPrompts(bindingId);
      try {
        await this.publish(bindingId, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth });
        const before = await this.herdr.readOutput(paneId, 240);
        const state = await this.herdr.runPrompt(paneId, prompt.body, this.config.turnTimeoutMs);
        this.observedAgentStates.set(paneId, state);
        binding = this.store.updateBinding(bindingId, { lastAgentState: state });
        await this.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth });
        if (state === "blocked") {
          this.store.updatePrompt(prompt.id, "failed", "TraeX is waiting for terminal approval");
          continue;
        }
        const after = await this.herdr.readOutput(paneId, 240);
        const answer = cleanTerminalOutput(extractNewOutput(before, after));
        const fingerprint = outputFingerprint(answer);
        this.store.updateBinding(bindingId, { lastOutputFingerprint: fingerprint });
        this.store.updatePrompt(prompt.id, "delivered");
        await this.publish(bindingId, "TurnCompleted", "herdr", { promptId: prompt.id, answer: answer || "TraeX 已完成，但没有可可靠提取的文本输出。请查看 Herdr pane。", queueDepth: this.store.countPendingPrompts(bindingId) });
      } catch (error) {
        this.store.updatePrompt(prompt.id, "failed", errorMessage(error));
        await this.publish(bindingId, "TurnFailed", "bridge", { promptId: prompt.id, error: errorMessage(error), queueDepth: this.store.countPendingPrompts(bindingId) });
      }
    }
  }

  private async emitState(binding: Binding, state: Binding["lastAgentState"]): Promise<void> {
    await this.publish(binding.id, "AgentStateChanged", "bridge", { state, queueDepth: this.store.countPendingPrompts(binding.id) });
  }

  private async replyStandalone(rootMessageId: string, card: object): Promise<void> {
    const sent = await this.lark.replyCard(rootMessageId, card);
    this.store.recordBridgeMessage(sent.messageId);
  }

  private event<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: Extract<BridgeEvent, { type: T }>["payload"]): Extract<BridgeEvent, { type: T }> {
    return { eventId: randomUUID(), bindingId, type, origin, occurredAt: new Date().toISOString(), payload } as Extract<BridgeEvent, { type: T }>;
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: Extract<BridgeEvent, { type: T }>["payload"]): Promise<void> {
    const event = { eventId: randomUUID(), bindingId, type, origin, occurredAt: new Date().toISOString(), payload } as BridgeEvent;
    await this.bus.publish(event);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function extractNewOutput(before: string, after: string): string {
  if (!before || !after.startsWith(before)) return after;
  return after.slice(before.length).trimStart();
}
