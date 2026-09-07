import type { BridgeEvent } from "../domain/events.js";
import { safeLogError } from "../runtime/safe-error.js";

type BridgeEventListener = (event: BridgeEvent) => void | Promise<void>;

export interface LifecycleEventPublisher {
  publish(event: BridgeEvent): Promise<void>;
}

export interface LifecycleEventSubscriber {
  onBridgeEvent(name: string, listener: BridgeEventListener): () => void;
}

export interface LifecycleEventDiagnosticSnapshot {
  listenerCount: number;
  publicationCount: number;
  subscriberFailures: number;
  failuresBySubscriber: Readonly<Record<string, number>>;
  lastFailureAt: string | null;
  lastFailedSubscriber: string | null;
}

export interface LifecycleEventDiagnostics {
  snapshot(): LifecycleEventDiagnosticSnapshot;
}

interface LifecycleEventLogger {
  error(value: object, message: string): void;
}

export class BridgeEventBus implements LifecycleEventPublisher, LifecycleEventSubscriber, LifecycleEventDiagnostics {
  private readonly listeners = new Map<string, BridgeEventListener>();
  private publicationCount = 0;
  private subscriberFailures = 0;
  private readonly failuresBySubscriber = new Map<string, number>();
  private lastFailureAt: string | null = null;
  private lastFailedSubscriber: string | null = null;

  constructor(private readonly logger?: LifecycleEventLogger) {}

  onBridgeEvent(name: string, listener: BridgeEventListener): () => void {
    if (this.listeners.has(name)) throw new Error(`Lifecycle event subscriber already registered: ${name}`);
    this.listeners.set(name, listener);
    return () => { if (this.listeners.get(name) === listener) this.listeners.delete(name); };
  }

  async publish(event: BridgeEvent): Promise<void> {
    this.publicationCount += 1;
    const listeners = [...this.listeners.entries()].map(([name, listener]) => ({ name, listener }));
    const results = await Promise.allSettled(listeners.map(({ listener }) => Promise.resolve().then(() => listener(event))));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const subscriber = listeners[index]!.name;
      this.subscriberFailures += 1;
      this.failuresBySubscriber.set(subscriber, (this.failuresBySubscriber.get(subscriber) ?? 0) + 1);
      this.lastFailureAt = new Date().toISOString();
      this.lastFailedSubscriber = subscriber;
      this.logger?.error({
        event: "lifecycle-subscriber-failed", err: safeLogError(result.reason), eventId: event.eventId,
        bindingId: event.bindingId, bridgeEventType: event.type, subscriber, outcome: "isolated"
      }, "lifecycle event subscriber failed; workflow outcome remains authoritative");
    });
  }

  snapshot(): LifecycleEventDiagnosticSnapshot {
    return {
      listenerCount: this.listeners.size,
      publicationCount: this.publicationCount,
      subscriberFailures: this.subscriberFailures,
      failuresBySubscriber: Object.fromEntries(this.failuresBySubscriber),
      lastFailureAt: this.lastFailureAt,
      lastFailedSubscriber: this.lastFailedSubscriber
    };
  }
}
