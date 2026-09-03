import type { Logger } from "pino";
import type { InboundMessageDispatchStore } from "../domain/ports/workflow.js";
import type { InboundDispatcherDiagnostics, IncomingLarkMessage } from "../domain/types.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import { CoalescingDrain } from "../runtime/coalescing-drain.js";
import { safeLogError } from "../runtime/safe-error.js";

const INBOUND_RETRY_INITIAL_MS = 250;
const INBOUND_RETRY_MAX_MS = 30_000;

export interface InboundMessageDispatcherPort {
  start(): void;
  stop(): Promise<void>;
  recoverProcessingMessages(): number;
  drain(): Promise<void>;
  handleMessage(message: IncomingLarkMessage): Promise<void>;
  receiveMessage(message: IncomingLarkMessage): Promise<void>;
  snapshot(): InboundDispatcherDiagnostics;
}

export interface InboundMessageDispatcherOptions {
  chatId: string; allowedOpenIds: readonly string[];
  store: InboundMessageDispatchStore;
  inboundWork: InboundWorkNotifier;
  logger: Logger;
}

export class InboundMessageDispatcher implements InboundMessageDispatcherPort {
  private readonly inboundDrain: CoalescingDrain;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private nextRetryAt: string | null = null;
  private lastAcceptedAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;
  private stopping = true;

  constructor(private readonly options: InboundMessageDispatcherOptions) {
    this.inboundDrain = new CoalescingDrain({
      drain: () => this.runDrainPass(),
      onError: (error) => {
        this.recordFailure(error);
        this.options.logger.error({ event: "inbound-message-drain-failed", err: safeLogError(error), outcome: "retry" }, "durable inbound drain failed; scheduling retry");
        this.scheduleRetry();
      }
    });
  }

  start(): void {
    this.stopping = false;
    this.retryAttempt = 0;
    this.inboundDrain.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    await this.inboundDrain.stop();
  }

  recoverProcessingMessages(): number { return this.options.store.recoverProcessingInboundMessages(); }

  async drain(): Promise<void> { await this.inboundDrain.request(); }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    if (!this.persist(message)) return;
    await this.inboundDrain.request();
  }

  async receiveMessage(message: IncomingLarkMessage): Promise<void> {
    if (!this.persist(message)) return;
    this.wake();
  }

  snapshot(): InboundDispatcherDiagnostics {
    const drain = this.inboundDrain.snapshot();
    return {
      state: this.stopping ? "stopping" : this.retryTimer ? "retry_wait" : drain.state,
      drainRequested: drain.requested, retryAttempt: this.retryAttempt, nextRetryAt: this.nextRetryAt,
      lastAcceptedAt: this.lastAcceptedAt, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure
    };
  }

  private persist(message: IncomingLarkMessage): boolean {
    const { chatId, logger, store } = this.options;
    if (message.chatId !== chatId) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "chat_not_allowed" }, "ignored Lark message"); return false; }
    if (!(this.options.allowedOpenIds ?? []).includes(message.actorOpenId)) { logger.warn({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, actorOpenId: message.actorOpenId, reason: "actor_not_allowed" }, "ignored unauthorized Lark message"); return false; }
    if (store.isBridgeMessage(message.messageId)) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "bridge_message" }, "ignored Lark message"); return false; }
    if (!store.recordInboundMessage(message)) { logger.debug({ event: "lark-message-duplicate", eventId: message.eventId, messageId: message.messageId, outcome: "ignored" }, "ignored duplicate Lark message"); return false; }
    return true;
  }

  private async runDrainPass(): Promise<void> {
    try {
      if (await this.drainOnce()) { this.retryAttempt = 0; this.clearRetry(); }
      else this.scheduleRetry();
    } catch (error) {
      this.recordFailure(error);
      this.options.logger.error({ event: "inbound-message-drain-failed", err: safeLogError(error), outcome: "retry" }, "durable inbound drain failed; scheduling retry");
      this.scheduleRetry();
    }
  }

  private wake(): void {
    if (this.stopping) return;
    this.clearRetry();
    this.inboundDrain.wake();
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer) return;
    const delayMs = Math.min(INBOUND_RETRY_INITIAL_MS * (2 ** this.retryAttempt), INBOUND_RETRY_MAX_MS);
    this.retryAttempt += 1;
    this.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      if (!this.stopping) this.inboundDrain.wake();
    }, delayMs);
    this.retryTimer.unref?.();
    this.options.logger.warn({ event: "inbound-message-retry-scheduled", attempt: this.retryAttempt, delayMs, outcome: "scheduled" }, "scheduled durable inbound retry");
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  private async drainOnce(): Promise<boolean> {
    for (let message = this.options.store.claimNextInboundMessage(); message; message = this.stopping ? null : this.options.store.claimNextInboundMessage()) {
      try {
        await this.options.inboundWork.notify({ eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: message });
        this.options.store.markInboundMessageAccepted(message.eventId);
        this.lastAcceptedAt = new Date().toISOString();
      } catch (error) {
        this.options.store.releaseInboundMessage(message.eventId, errorMessage(error));
        this.recordFailure(error);
        this.options.logger.error({ event: "lark-message-acceptance-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, outcome: "retry" }, "inbound message acceptance failed; retained for retry");
        return false;
      }
    }
    return true;
  }

  private recordFailure(error: unknown): void {
    this.lastFailureAt = new Date().toISOString();
    this.lastFailure = errorMessage(error).slice(0, 500);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
