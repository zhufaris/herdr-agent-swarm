import type { Logger } from "pino";
import type { InboundMessageDispatchStore } from "../domain/ports/workflow.js";
import type { InboundDispatcherDiagnostics, IncomingLarkMessage } from "../domain/types.js";
import { inputFromIncomingMessage } from "../domain/inbound.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import { CoalescingDrain } from "../runtime/coalescing-drain.js";
import { safeLogError } from "../runtime/safe-error.js";
import { inboundMessageScopeKey } from "../domain/inbound-message-scope.js";
import { compactPromptInput } from "../domain/prompt-input-policy.js";
import type { InboundMessageRouterPort } from "./inbound-message-routing-workflow.js";
import type { DeliveryLatencyTrace } from "../domain/delivery-trace.js";

const INBOUND_RETRY_INITIAL_MS = 250;
const INBOUND_RETRY_MAX_MS = 30_000;
const INBOUND_DISPATCH_CONCURRENCY = 4;

export interface DurableInboundPipelinePort {
  start(): void;
  stop(): Promise<void>;
  recover(): number;
  receive(message: IncomingLarkMessage): Promise<void>;
  snapshot(): InboundDispatcherDiagnostics;
}

interface Options {
  chatId: string;
  allowedOpenIds: readonly string[];
  store: InboundMessageDispatchStore;
  router: InboundMessageRouterPort;
  inboundWork: InboundWorkNotifier;
  logger: Logger;
  deliveryTrace?: DeliveryLatencyTrace;
}

export class DurableInboundPipeline implements DurableInboundPipelinePort {
  private readonly drainWork: CoalescingDrain;
  private stopInboundWork: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private nextRetryAt: string | null = null;
  private lastAcceptedAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;
  private stopping = true;

  constructor(private readonly options: Options) {
    this.drainWork = new CoalescingDrain({
      drain: () => this.runDrainPass(),
      onError: (error) => {
        this.recordFailure(error);
        this.options.logger.error({ event: "inbound-message-drain-failed", err: safeLogError(error), outcome: "retry" }, "durable inbound drain failed; scheduling retry");
        this.scheduleRetry();
      }
    });
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.retryAttempt = 0;
    this.stopInboundWork = this.options.inboundWork.subscribe(() => { this.wake(); });
    this.drainWork.start();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopInboundWork?.();
    this.stopInboundWork = null;
    this.clearRetry();
    await this.drainWork.stop();
  }

  recover(): number { return this.options.store.recoverProcessingInboundMessages(); }

  async receive(message: IncomingLarkMessage): Promise<void> {
    if (!this.persist(message)) return;
    const hint = {
      eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: { eventId: message.eventId }
    } as const;
    void this.options.inboundWork.notify(hint).catch((error) => {
      this.recordFailure(error);
      this.options.logger.warn({ event: "inbound-work-hint-failed", err: safeLogError(error), eventId: message.eventId, outcome: "isolated" }, "durable inbound wake hint failed; continuing from SQLite");
    });
    this.wake();
  }

  snapshot(): InboundDispatcherDiagnostics {
    const drain = this.drainWork.snapshot();
    return {
      state: this.stopping ? "stopping" : this.retryTimer ? "retry_wait" : drain.state,
      drainRequested: drain.requested, retryAttempt: this.retryAttempt, nextRetryAt: this.nextRetryAt,
      lastAcceptedAt: this.lastAcceptedAt, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure
    };
  }

  private persist(message: IncomingLarkMessage): boolean {
    const { chatId, logger, store } = this.options;
    if (message.chatId !== chatId) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "chat_not_allowed" }, "ignored Lark message"); return false; }
    if (!this.options.allowedOpenIds.includes(message.actorOpenId)) { logger.warn({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, actorOpenId: message.actorOpenId, reason: "actor_not_allowed" }, "ignored unauthorized Lark message"); return false; }
    if (store.isBridgeMessage(message.messageId)) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "bridge_message" }, "ignored Lark message"); return false; }
    const input = inputFromIncomingMessage(message);
    const bounded = compactPromptInput(input.text);
    const durableInput = bounded.inputTooLarge ? { ...input, text: bounded.text } : input;
    const durableMessage = { ...message, text: durableInput.text, input: durableInput, ...(bounded.inputTooLarge ? { inputTooLarge: true } : {}) };
    if (!store.recordInboundMessage(durableMessage)) { logger.debug({ event: "lark-message-duplicate", eventId: message.eventId, messageId: message.messageId, outcome: "ignored" }, "ignored duplicate Lark message"); return false; }
    this.options.deliveryTrace?.mark({ stage: "ingress_accepted", correlation: { eventId: message.eventId, messageId: message.messageId } });
    return true;
  }

  private async runDrainPass(): Promise<void> {
    try {
      const outcome = await this.drainOnce();
      if (outcome === "drained") { this.retryAttempt = 0; this.clearRetry(); }
      else this.scheduleRetry(outcome === "deferred");
    } catch (error) {
      this.recordFailure(error);
      this.options.logger.error({ event: "inbound-message-drain-failed", err: safeLogError(error), outcome: "retry" }, "durable inbound drain failed; scheduling retry");
      this.scheduleRetry();
    }
  }

  private wake(): void { if (!this.stopping) { this.clearRetry(); this.drainWork.wake(); } }

  private scheduleRetry(capacityDeferred = false): void {
    if (this.stopping || this.retryTimer) return;
    const delayMs = Math.min(INBOUND_RETRY_INITIAL_MS * (2 ** this.retryAttempt), INBOUND_RETRY_MAX_MS);
    this.retryAttempt += 1;
    this.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.nextRetryAt = null; this.wake(); }, delayMs);
    this.retryTimer.unref?.();
    const record = { event: "inbound-message-retry-scheduled", attempt: this.retryAttempt, delayMs, reason: capacityDeferred ? "capacity_deferred" : "failure", outcome: "scheduled" };
    if (capacityDeferred) this.options.logger.info(record, "scheduled durable inbound capacity retry");
    else this.options.logger.warn(record, "scheduled durable inbound retry");
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  private async drainOnce(): Promise<"drained" | "deferred" | "failed"> {
    const blockedScopeKeys = new Set<string>();
    const activeScopeKeys = new Set<string>();
    let hasDeferred = false;
    let hasFailure = false;
    const drainWorker = async (): Promise<void> => {
      while (!this.stopping) {
        const message = this.options.store.claimNextInboundMessage([...blockedScopeKeys, ...activeScopeKeys]);
        if (!message) return;
        const scopeKey = inboundMessageScopeKey(message);
        activeScopeKeys.add(scopeKey);
        try {
          const outcome = await this.routeClaimedMessage(message);
          if (outcome === "deferred") { blockedScopeKeys.add(scopeKey); hasDeferred = true; }
          else if (outcome === "failed") { blockedScopeKeys.add(scopeKey); hasFailure = true; }
        } finally {
          activeScopeKeys.delete(scopeKey);
        }
      }
    };
    await Promise.all(Array.from({ length: INBOUND_DISPATCH_CONCURRENCY }, () => drainWorker()));
    return hasFailure ? "failed" : hasDeferred ? "deferred" : "drained";
  }

  private async routeClaimedMessage(message: IncomingLarkMessage): Promise<"accepted" | "deferred" | "failed"> {
    try {
      const result = await this.options.router.route(message);
      if (result.disposition === "deferred") {
        this.options.store.deferInboundMessage(message.eventId);
        this.options.logger.info({ event: "lark-message-capacity-deferred", eventId: message.eventId, messageId: message.messageId, decision: result.decision, disposition: result.disposition, outcome: "retry" }, "deferred durable inbound message until Prompt capacity is available");
        return "deferred";
      }
      this.options.store.markInboundMessageAccepted(message.eventId);
      if (result.submissionId) this.options.deliveryTrace?.mark({
        stage: "submission_admitted",
        correlation: { eventId: message.eventId, messageId: message.messageId, submissionId: result.submissionId }
      });
      this.lastAcceptedAt = new Date().toISOString();
      this.options.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, ...result, outcome: "accepted" }, "completed durable inbound handling");
      return "accepted";
    } catch (error) {
      this.options.store.releaseInboundMessage(message.eventId, errorMessage(error));
      this.recordFailure(error);
      this.options.logger.error({ event: "lark-message-acceptance-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, outcome: "retry" }, "inbound message acceptance failed; retained for retry");
      return "failed";
    }
  }

  private recordFailure(error: unknown): void {
    this.lastFailureAt = new Date().toISOString();
    this.lastFailure = errorMessage(error).slice(0, 500);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
