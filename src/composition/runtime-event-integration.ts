import type { Logger } from "pino";
import { BridgeEventBus, type LifecycleEventDiagnosticSnapshot } from "../events/bridge-event-bus.js";
import { InProcessInboundWorkNotifier } from "../events/inbound-work-notifier.js";
import { InProcessOutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { InProcessPromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { HerdrRuntimeHint } from "../runtime/herdr-event-hint.js";
import { RuntimeLink } from "./runtime-link.js";
import { WorkWakeupHub } from "./work-wakeup-hub.js";

type RuntimeWakeups = { outbound: undefined; primary: string; instance: string };
interface HerdrHintConsumer { handle(hint: HerdrRuntimeHint): Promise<void>; }

export interface RuntimeEventIntegrationSnapshot {
  reliability: {
    inbound: "durable-record-plus-hint";
    lifecycle: "transactional-state-plus-fanout";
    work: "best-effort-wakeup";
    herdr: "bounded-reconciliation-hint";
  };
  lifecycle: LifecycleEventDiagnosticSnapshot;
}

/** Composition-owned integration of explicitly different event reliability classes. */
export class RuntimeEventIntegration {
  readonly lifecycle: BridgeEventBus;
  readonly inboundWork = new InProcessInboundWorkNotifier();
  readonly outboundWork: InProcessOutboundWorkNotifier;
  readonly promptWork: InProcessPromptWorkScheduler;

  private readonly wakeups = new WorkWakeupHub<RuntimeWakeups>(["outbound", "primary", "instance"]);
  private readonly herdrHints = new RuntimeLink<HerdrHintConsumer>("Herdr event router");

  constructor(logger: Logger) {
    this.lifecycle = new BridgeEventBus(logger);
    this.outboundWork = new InProcessOutboundWorkNotifier(logger);
    this.promptWork = new InProcessPromptWorkScheduler(logger);
    this.wakeups.register("outbound", () => this.outboundWork.wake());
    this.wakeups.register("primary", (bindingId) => this.promptWork.wake({ kind: "prompt-ready", bindingId }), (bindingId) => bindingId);
  }

  wakeOutbound(): void { this.wakeups.wake("outbound", undefined); }
  wakePrimary(bindingId: string): void { this.wakeups.wake("primary", bindingId); }
  wakeInstance(instanceId: string): void { this.wakeups.wake("instance", instanceId); }

  registerInstanceWakeup(handler: (instanceId: string) => void): void {
    this.wakeups.register("instance", handler, (instanceId) => instanceId);
  }

  connectHerdrHints(consumer: HerdrHintConsumer): void { this.herdrHints.connect(consumer); }
  handleHerdrHint(hint: HerdrRuntimeHint): Promise<void> { return this.herdrHints.get().handle(hint); }
  seal(): void { this.wakeups.seal(); }

  snapshot(): RuntimeEventIntegrationSnapshot {
    return {
      reliability: {
        inbound: "durable-record-plus-hint",
        lifecycle: "transactional-state-plus-fanout",
        work: "best-effort-wakeup",
        herdr: "bounded-reconciliation-hint"
      },
      lifecycle: this.lifecycle.snapshot()
    };
  }
}
