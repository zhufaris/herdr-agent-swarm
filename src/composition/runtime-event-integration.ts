import type { Logger } from "pino";
import type { LifecycleEventDiagnosticSnapshot, LifecycleEventPublisher, LifecycleEventSubscriber } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { RuntimeEventBus, type RuntimeEventBusSnapshot, type RuntimeWorkHint } from "../events/runtime-event-bus.js";
import type { HerdrRuntimeHint } from "../runtime/herdr-event-hint.js";

type InstanceWakeup = (instanceId: string) => void;
export type HerdrHintConsumer = (hint: HerdrRuntimeHint, signal: AbortSignal) => Promise<void>;

export interface RuntimeEventIntegrationSnapshot {
  reliability: { inbound: "durable-record-plus-hint"; lifecycle: "transactional-state-plus-fanout"; work: "best-effort-wakeup"; herdr: "bounded-reconciliation-hint"; };
  lifecycle: LifecycleEventDiagnosticSnapshot;
  channels: RuntimeEventBusSnapshot["channels"];
}

/** Composition facade exposing narrow ports backed by one typed RuntimeEventBus. */
export class RuntimeEventIntegration {
  private readonly bus: RuntimeEventBus;
  private subscriberSequence = 0;
  private instanceWakeup: InstanceWakeup | null = null;
  private herdrConsumer: HerdrHintConsumer | null = null;

  readonly lifecycle: LifecycleEventPublisher & LifecycleEventSubscriber & { snapshot(): LifecycleEventDiagnosticSnapshot };
  readonly inboundWork: InboundWorkNotifier;
  readonly outboundWork: OutboundWorkNotifier;
  readonly promptWork: PromptWorkScheduler;
  readonly herdrHintConsumer: HerdrHintConsumer;

  constructor(logger: Logger) {
    this.bus = new RuntimeEventBus(logger);
    this.lifecycle = {
      publish: (event) => this.bus.publishLifecycle(event),
      onBridgeEvent: (name, listener) => this.bus.subscribe("lifecycle", name, ({ payload }) => listener(payload)),
      snapshot: () => lifecycleSnapshot(this.bus.snapshot())
    };
    this.inboundWork = {
      subscribe: (listener) => this.bus.subscribe("inbound", this.nextName("inbound"), ({ payload }) => listener(payload)),
      notify: (event) => this.bus.publishInbound(event)
    };
    this.outboundWork = {
      subscribe: (listener) => this.bus.subscribe("work", this.nextName("outbound"), ({ payload }) => payload.kind === "outbox-ready" || payload.kind === "card-context-ready" ? listener() : undefined),
      wake: () => this.bus.publishWork({ kind: "outbox-ready" })
    };
    this.promptWork = {
      subscribe: (listener) => this.bus.subscribe("work", this.nextName("primary"), ({ payload }) => payload.kind === "primary-ready" ? listener(payload.promptHint ?? { kind: "prompt-ready", bindingId: payload.bindingId }) : undefined),
      wake: (hint) => this.bus.publishWork({ kind: "primary-ready", bindingId: hint.bindingId, promptHint: hint })
    };
    this.herdrHintConsumer = (hint, signal) => { this.requireHerdrConsumer(); return this.bus.publishHerdr(hint, signal); };
    this.bus.subscribe("work", "instance-work", ({ payload }) => { if (payload.kind === "worker-ready") this.requireInstanceWakeup()(payload.instanceId); });
    this.bus.subscribe("herdr", "herdr-reconciliation", ({ payload }) => this.requireHerdrConsumer()(payload.hint, payload.signal));
  }

  wakeOutbound(): void { this.bus.publishWork({ kind: "outbox-ready" }); }
  wakeCardContext(): void { this.bus.publishWork({ kind: "card-context-ready" }); }
  wakePrimary(bindingId: string): void { this.bus.publishWork({ kind: "primary-ready", bindingId }); }
  wakeInstance(instanceId: string): void { this.bus.publishWork({ kind: "worker-ready", instanceId }); }
  wakeTurnControl(ownerKind: "binding" | "instance", ownerId: string): void { this.bus.publishWork({ kind: "turn-control-ready", ownerKind, ownerId }); }
  wakeSwarmCommand(intentId: string): void { this.bus.publishWork({ kind: "swarm-command-ready", intentId }); }
  onWork(name: string, listener: (hint: RuntimeWorkHint) => void | Promise<void>): () => void { return this.bus.subscribe("work", name, ({ payload }) => listener(payload)); }

  registerInstanceWakeup(handler: InstanceWakeup): void {
    if (this.instanceWakeup) throw new Error("Wake-up channel already registered: instance");
    this.instanceWakeup = handler;
  }
  connectHerdrHints(consumer: HerdrHintConsumer): void {
    if (this.herdrConsumer) throw new Error("Runtime link already connected: Herdr event router");
    this.herdrConsumer = consumer;
  }
  seal(): void {
    const missing = [...(!this.instanceWakeup ? ["instance"] : []), ...(!this.herdrConsumer ? ["herdr"] : [])];
    if (missing.length > 0) throw new Error(`Missing wake-up channel registration: ${missing.join(", ")}`);
    this.bus.seal();
  }
  stop(): Promise<void> { return this.bus.stop(); }

  snapshot(): RuntimeEventIntegrationSnapshot {
    const snapshot = this.bus.snapshot();
    return {
      reliability: { inbound: "durable-record-plus-hint", lifecycle: "transactional-state-plus-fanout", work: "best-effort-wakeup", herdr: "bounded-reconciliation-hint" },
      lifecycle: lifecycleSnapshot(snapshot), channels: snapshot.channels
    };
  }

  private nextName(prefix: string): string { this.subscriberSequence += 1; return `${prefix}-${this.subscriberSequence}`; }
  private requireInstanceWakeup(): InstanceWakeup { if (!this.instanceWakeup) throw new Error("Wake-up channel is not registered: instance"); return this.instanceWakeup; }
  private requireHerdrConsumer(): HerdrHintConsumer { if (!this.herdrConsumer) throw new Error("Runtime link is not connected: Herdr event router"); return this.herdrConsumer; }
}

function lifecycleSnapshot(snapshot: RuntimeEventBusSnapshot): LifecycleEventDiagnosticSnapshot {
  const channel = snapshot.channels.lifecycle;
  return { listenerCount: channel.listenerCount, publicationCount: channel.published, subscriberFailures: channel.subscriberFailures, failuresBySubscriber: channel.failuresBySubscriber, lastFailureAt: channel.lastFailureAt, lastFailedSubscriber: channel.lastFailedSubscriber };
}
