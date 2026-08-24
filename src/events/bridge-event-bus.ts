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
  subscriberFailures: number;
  lastFailureAt: string | null;
  lastFailedSubscriber: string | null;
}

export interface LifecycleEventDiagnostics {
  snapshot(): LifecycleEventDiagnosticSnapshot;
}

interface LifecycleEventLogger {
  error(value: object, message: string): void;
}

interface LifecycleEventRegistration { name: string; listener: BridgeEventListener; }

export class BridgeEventBus implements LifecycleEventPublisher, LifecycleEventSubscriber, LifecycleEventDiagnostics {
  private readonly listeners = new Set<LifecycleEventRegistration>();
  private diagnostics: LifecycleEventDiagnosticSnapshot = { subscriberFailures: 0, lastFailureAt: null, lastFailedSubscriber: null };

  constructor(private readonly logger?: LifecycleEventLogger) {}

  onBridgeEvent(name: string, listener: BridgeEventListener): () => void {
    const registration = { name, listener };
    this.listeners.add(registration);
    return () => this.listeners.delete(registration);
  }

  async publish(event: BridgeEvent): Promise<void> {
    const listeners = [...this.listeners];
    const results = await Promise.allSettled(listeners.map(({ listener }) => Promise.resolve().then(() => listener(event))));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const subscriber = listeners[index]!.name;
      this.diagnostics = { subscriberFailures: this.diagnostics.subscriberFailures + 1, lastFailureAt: new Date().toISOString(), lastFailedSubscriber: subscriber };
      this.logger?.error({
        event: "lifecycle-subscriber-failed", err: safeLogError(result.reason), eventId: event.eventId,
        bindingId: event.bindingId, bridgeEventType: event.type, subscriber, outcome: "isolated"
      }, "lifecycle event subscriber failed; workflow outcome remains authoritative");
    });
  }

  snapshot(): LifecycleEventDiagnosticSnapshot { return { ...this.diagnostics }; }
}
