import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderHelpCard, renderRequestRunCard, renderRunCard } from "../cards/run-card.js";
import type { BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand } from "../domain/commands.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingStorePort, HerdrPort, LarkPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, EventOrigin, IncomingLarkMessage } from "../domain/types.js";
import type { BridgeEventBus } from "../events/bridge-event-bus.js";
import type { LarkChannelPublisher } from "../events/lark-channel-publisher.js";
import { cleanTerminalOutput, outputFingerprint } from "../runtime/output.js";
import { extractFinalTraexAnswer, parseTraexOutput } from "../runtime/traex-output-parser.js";

export class SyncCoordinator {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, { promptId: string; paneId: string; state: Binding["lastAgentState"] }>();
  private readonly steeringWorkers = new Map<string, Promise<void>>();
  private readonly observedAgentStates = new Map<string, Binding["lastAgentState"]>();
  private readonly observedTerminalOutputs = new Map<string, string>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopInboundSubscription: (() => void) | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStorePort,
    private readonly herdr: HerdrPort,
    private readonly lark: LarkPort,
    private readonly bus: BridgeEventBus,
    private readonly channelPublisher: LarkChannelPublisher,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    const recovered = this.store.recoverRunningPrompts();
    if (recovered > 0) this.logger.warn({ recovered }, "marked interrupted prompt jobs as failed without replay");
    for (const binding of this.store.listBindings()) {
      for (const view of this.store.listRunCards(binding.id).filter((item) => item.larkMessageId && item.viewVersion > item.deliveredVersion)) {
        await this.channelPublisher.enqueueRunCardUpdate(view.bindingId, view.promptId, view.larkMessageId!, view.viewVersion, renderRequestRunCard(view));
      }
    }
    const recoveredInbound = this.store.recoverProcessingInboundMessages();
    if (recoveredInbound > 0) this.logger.warn({ recoveredInbound }, "returned interrupted inbound messages to acceptance queue");
    await this.herdr.assertWorkspace(this.config.herdr.workspaceId);
    await this.captureOutputBaselines();
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error) => this.logger.error({ err: error }, "reconciliation failed"));
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref();
    this.stopInboundSubscription = this.bus.onInboundMessage((event) => this.acceptInboundMessage(event.payload));
    await this.lark.start((message) => this.handleMessage(message));
    await this.drainInboundMessages();
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) this.scheduleWorker(binding.id);
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.lark.stop();
    this.stopInboundSubscription?.();
    await Promise.allSettled([...this.workers.values(), ...this.steeringWorkers.values()]);
  }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    if (message.chatId !== this.config.lark.chatId || this.store.isBridgeMessage(message.messageId)) return;
    if (!this.store.recordInboundMessage(message)) return;
    await this.drainInboundMessages();
  }

  private async drainInboundMessages(): Promise<void> {
    for (let message = this.store.claimNextInboundMessage(); message; message = this.store.claimNextInboundMessage()) {
      try {
        await this.bus.publishInbound({
          eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: message
        });
        this.store.markInboundMessageAccepted(message.eventId);
      } catch (error) {
        this.store.releaseInboundMessage(message.eventId, errorMessage(error));
        this.logger.error({ err: error, eventId: message.eventId }, "inbound message acceptance failed; retained for retry");
        return;
      }
    }
  }

  private async acceptInboundMessage(message: IncomingLarkMessage): Promise<void> {
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
    await this.channelPublisher.drain();
    const panes = await this.herdr.listPanes(this.config.herdr.workspaceId);
    const paneIds = new Set(panes.map((pane) => pane.paneId));
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) {
      if (binding.paneId && !paneIds.has(binding.paneId)) {
        this.store.updateBinding(binding.id, { state: "orphaned" });
        const occurredAt = new Date().toISOString();
        for (const view of this.store.listRunCards(binding.id).filter((item) => item.phase === "running" || item.phase === "blocked")) {
          const next = { ...view, phase: "failed" as const, notice: `Herdr pane ${binding.paneId} no longer exists`, finishedAt: occurredAt, queuePosition: 0, viewVersion: view.viewVersion + 1, updatedAt: occurredAt };
          this.store.saveRunCard(next);
          if (next.larkMessageId) await this.channelPublisher.enqueueRunCardUpdate(next.bindingId, next.promptId, next.larkMessageId, next.viewVersion, renderRequestRunCard(next));
        }
        for (const view of this.store.listRunCards(binding.id).filter((item) => item.phase === "queued")) {
          const next = { ...view, phase: "blocked" as const, notice: `Herdr pane ${binding.paneId} no longer exists，请恢复绑定后重试。`, viewVersion: view.viewVersion + 1, updatedAt: occurredAt };
          this.store.saveRunCard(next);
          if (next.larkMessageId) await this.channelPublisher.enqueueRunCardUpdate(next.bindingId, next.promptId, next.larkMessageId, next.viewVersion, renderRequestRunCard(next));
        }
        await this.publish(binding.id, "BindingOrphaned", "herdr", { reason: `Herdr pane ${binding.paneId} no longer exists` });
      }
    }

    for (const pane of panes) {
      if (!pane.foregroundExecutables.includes("traex")) continue;
      const existing = this.store.findBindingByPane(pane.paneId);
      if (!existing) {
        await this.createFromHerdr(pane.paneId, pane.label ?? `TraeX ${pane.paneId}`);
        const output = cleanTerminalOutput(await this.herdr.readOutput(pane.paneId, 240));
        this.observedTerminalOutputs.set(pane.paneId, output);
        this.observedAgentStates.set(pane.paneId, pane.agentState);
        continue;
      }
      const previous = this.observedAgentStates.get(pane.paneId) ?? existing.lastAgentState;
      this.observedAgentStates.set(pane.paneId, pane.agentState);
      if (existing.state !== "active" || this.workers.has(existing.id)) continue;
      if (previous !== pane.agentState) {
        this.store.updateBinding(existing.id, { lastAgentState: pane.agentState });
        await this.publish(existing.id, "AgentStateChanged", "herdr", {
          state: pane.agentState, queueDepth: this.store.countPendingPrompts(existing.id)
        });
      }
      if (previous === "blocked" && pane.agentState !== "blocked" && this.store.countPendingPrompts(existing.id) > 0) {
        this.scheduleWorker(existing.id);
      }
      if (previous === "working" && (pane.agentState === "done" || pane.agentState === "idle")) {
        await this.publishChangedLocalOutput(existing, pane.paneId);
      } else {
        await this.publishChangedLocalOutput(existing, pane.paneId);
      }
    }
    for (const binding of this.store.listBindings().filter((item) => item.state === "active")) this.scheduleWorker(binding.id);
  }

  private async captureOutputBaselines(): Promise<void> {
    for (const binding of this.store.listBindings().filter((item) => item.state === "active" && item.paneId)) {
      try {
        const output = cleanTerminalOutput(await this.herdr.readOutput(binding.paneId!, 240));
        this.observedTerminalOutputs.set(binding.paneId!, output);
        if (output) this.store.updateBinding(binding.id, { lastOutputFingerprint: outputFingerprint(output) });
      } catch (error) {
        this.store.updateBinding(binding.id, { state: "orphaned" });
        await this.publish(binding.id, "BindingOrphaned", "herdr", { reason: `Unable to read Herdr pane ${binding.paneId}: ${errorMessage(error)}` });
        this.logger.warn({ err: error, bindingId: binding.id, paneId: binding.paneId }, "marked missing Herdr pane as orphaned during startup");
      }
    }
  }

  private async publishChangedLocalOutput(binding: Binding, paneId: string): Promise<void> {
    const output = cleanTerminalOutput(await this.herdr.readOutput(paneId, 240));
    if (!output) return;
    const previous = this.observedTerminalOutputs.get(paneId) ?? "";
    this.observedTerminalOutputs.set(paneId, output);
    const fingerprint = outputFingerprint(output);
    if (fingerprint === binding.lastOutputFingerprint) return;
    this.store.updateBinding(binding.id, { lastOutputFingerprint: fingerprint });
    const answer = extractTraexAnswer(extractNewOutput(previous, output));
    if (!answer) return;
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
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID();
    const occurredAt = new Date().toISOString();
    const activeRun = this.activeRuns.get(binding.id);
    const parentPromptId = activeRun?.state === "working" ? activeRun.promptId : null;
    const dispatchKind = parentPromptId ? "steering" as const : "turn" as const;
    const view = createQueuedRunCard({
      promptId, bindingId: binding.id, title: requestTitle(body), workspaceId: binding.workspaceId, paneId: binding.paneId,
      requestText: body, queuePosition: dispatchKind === "steering" ? 0 : this.store.countPendingPrompts(binding.id) + 1, occurredAt
    });
    const { prompt, inserted } = this.store.acceptPrompt({
      prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body, dispatchKind, parentPromptId },
      view, rootMessageId: binding.rootMessageId, card: renderRequestRunCard(view)
    });
    if (!inserted) {
      await this.channelPublisher.drain();
      if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.scheduleSteering(binding.id, prompt.parentPromptId);
      else this.scheduleWorker(binding.id);
      return;
    }
    const depth = this.store.countPendingPrompts(binding.id);
    if (dispatchKind === "steering" && parentPromptId) {
      await this.publish(binding.id, "SteeringQueued", "lark", { promptId: prompt.id, parentPromptId, actorOpenId: message.actorOpenId });
    } else {
      await this.publish(binding.id, "PromptQueued", "lark", { promptId: prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    }
    if (dispatchKind === "turn") await this.refreshQueuePositions(binding.id);
    this.store.audit({ actorOpenId: message.actorOpenId, action: dispatchKind === "steering" ? "prompt.steer" : "prompt.queue", target: binding.id, outcome: "success" });
    await this.channelPublisher.drain();
    if (dispatchKind === "steering" && parentPromptId) this.scheduleSteering(binding.id, parentPromptId);
    else this.scheduleWorker(binding.id);
  }

  private scheduleSteering(bindingId: string, parentPromptId: string): void {
    const previous = this.steeringWorkers.get(bindingId) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(() => this.drainSteering(bindingId, parentPromptId)).finally(() => {
      if (this.steeringWorkers.get(bindingId) === worker) this.steeringWorkers.delete(bindingId);
    });
    this.steeringWorkers.set(bindingId, worker);
  }

  private async drainSteering(bindingId: string, parentPromptId: string): Promise<void> {
    const activeRun = this.activeRuns.get(bindingId);
    if (!activeRun || activeRun.promptId !== parentPromptId) return;
    for (let prompt = this.store.claimNextReadySteering(bindingId, parentPromptId); prompt; prompt = this.store.claimNextReadySteering(bindingId, parentPromptId)) {
      try {
        const result = this.herdr.steerPrompt ? await this.herdr.steerPrompt(activeRun.paneId, prompt.body) : "not_working";
        if (result === "not_working") {
          this.store.requeueSteeringAsTurn(prompt.id);
          await this.refreshQueuePositions(bindingId);
          continue;
        }
        await this.publish(bindingId, "SteeringStarted", "bridge", { promptId: prompt.id, parentPromptId });
        this.store.updatePrompt(prompt.id, "delivered");
        await this.publish(bindingId, "SteeringDelivered", "herdr", { promptId: prompt.id, parentPromptId });
      } catch (error) {
        const message = `Steering 注入结果无法确认，请检查 Herdr pane 后按需重试：${errorMessage(error)}`;
        this.store.updatePrompt(prompt.id, "failed", message);
        await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: prompt.id, parentPromptId, error: message });
      }
    }
  }

  private scheduleWorker(bindingId: string): void {
    if (this.workers.has(bindingId)) return;
    const worker = this.drain(bindingId).finally(() => {
      this.workers.delete(bindingId);
      const binding = this.store.listBindings().find((item) => item.id === bindingId);
      if (binding?.lastAgentState !== "blocked" && this.store.countPendingPrompts(bindingId) > 0) {
        this.scheduleWorker(bindingId);
      }
    });
    this.workers.set(bindingId, worker);
  }

  private async drain(bindingId: string): Promise<void> {
    let binding = this.store.listBindings().find((item) => item.id === bindingId);
    if (!binding?.paneId || binding.state !== "active") return;
    const paneId = binding.paneId;
    for (let prompt = this.store.claimNextReadyPrompt(bindingId); prompt; prompt = this.store.claimNextReadyPrompt(bindingId)) {
      const queueDepth = this.store.countPendingPrompts(bindingId);
      try {
        await this.refreshQueuePositions(bindingId);
        await this.publish(bindingId, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth });
        this.activeRuns.set(bindingId, { promptId: prompt.id, paneId, state: "unknown" });
        const before = await this.herdr.readOutput(paneId, 240);
        let previousObservation = before;
        const state = await this.herdr.runPrompt(paneId, prompt.body, this.config.turnTimeoutMs, async ({ state: observedState, output }) => {
          const parsed = parseTraexOutput(previousObservation, output, this.config.herdr.workspaceCwd);
          previousObservation = output;
          if (parsed.answerDelta || parsed.progressEvents.length) {
            await this.publish(bindingId, "TurnOutputObserved", "herdr", { promptId: prompt.id, answerDelta: parsed.answerDelta, progressEvents: parsed.progressEvents });
          }
          const previousState = this.observedAgentStates.get(paneId) ?? binding?.lastAgentState ?? "unknown";
          const activeRun = this.activeRuns.get(bindingId);
          if (activeRun?.promptId === prompt.id) activeRun.state = observedState;
          if (previousState !== observedState) {
            this.observedAgentStates.set(paneId, observedState);
            binding = this.store.updateBinding(bindingId, { lastAgentState: observedState });
            await this.publish(bindingId, "AgentStateChanged", "herdr", {
              state: observedState, queueDepth: this.store.countPendingPrompts(bindingId), promptId: prompt.id
            });
          }
        });
        const stateBeforeReturn = binding.lastAgentState;
        const activeRun = this.activeRuns.get(bindingId);
        if (activeRun?.promptId === prompt.id) activeRun.state = state;
        this.observedAgentStates.set(paneId, state);
        binding = this.store.updateBinding(bindingId, { lastAgentState: state });
        if (stateBeforeReturn !== state) {
          await this.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth, promptId: prompt.id });
        }
        const after = await this.herdr.readOutput(paneId, 240);
        const terminalDelta = cleanTerminalOutput(extractNewOutput(before, after));
        const answer = extractFinalTraexAnswer(after);
        const fingerprint = outputFingerprint(answer);
        this.observedTerminalOutputs.set(paneId, cleanTerminalOutput(after));
        this.store.updateBinding(bindingId, { lastOutputFingerprint: fingerprint });
        this.store.updatePrompt(prompt.id, "delivered");
        await this.publish(bindingId, "TurnCompleted", "herdr", { promptId: prompt.id, answer: answer || "TraeX 已完成，但没有可安全展示的文本输出。请查看 Herdr pane。", queueDepth: this.store.countPendingPrompts(bindingId) });
        await this.refreshQueuePositions(bindingId);
      } catch (error) {
        this.store.updatePrompt(prompt.id, "failed", errorMessage(error));
        await this.publish(bindingId, "TurnFailed", "bridge", { promptId: prompt.id, error: errorMessage(error), queueDepth: this.store.countPendingPrompts(bindingId) });
        await this.refreshQueuePositions(bindingId);
        if (binding.lastAgentState === "blocked") return;
      } finally {
        const steeringWorker = this.steeringWorkers.get(bindingId);
        if (steeringWorker) await steeringWorker;
        if (this.store.requeueQueuedSteering(bindingId, prompt.id) > 0) await this.refreshQueuePositions(bindingId);
        if (this.activeRuns.get(bindingId)?.promptId === prompt.id) this.activeRuns.delete(bindingId);
      }
    }
  }

  private async emitState(binding: Binding, state: Binding["lastAgentState"]): Promise<void> {
    await this.publish(binding.id, "AgentStateChanged", "bridge", { state, queueDepth: this.store.countPendingPrompts(binding.id) });
  }

  private async refreshQueuePositions(bindingId: string): Promise<void> {
    const queuedTurnIds = new Set(this.store.listQueuedTurnPromptIds(bindingId));
    const queued = this.store.listRunCards(bindingId).filter((view) => view.phase === "queued" && queuedTurnIds.has(view.promptId));
    for (const [index, view] of queued.entries()) {
      const position = index + 1;
      if (view.queuePosition !== position) await this.publish(bindingId, "RunQueuePositionChanged", "bridge", { promptId: view.promptId, queuePosition: position });
    }
  }

  private async replyStandalone(rootMessageId: string, card: object): Promise<void> {
    await this.channelPublisher.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card);
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
function requestTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " " ).trim();
  return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request";
}

function extractTraexAnswer(output: string): string | null {
  const marker = /^\s*◆\s+/m.exec(output);
  if (!marker || marker.index === undefined) return null;
  const answer = output.slice(marker.index + marker[0].length).split(/\n\s*─{3,}/)[0]?.trim() ?? "";
  return answer || null;
}

export function extractNewOutput(before: string, after: string): string {
  if (!before || !after.startsWith(before)) return after;
  return after.slice(before.length).trimStart();
}
