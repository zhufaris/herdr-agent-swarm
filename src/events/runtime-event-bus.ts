import { randomUUID } from "node:crypto";
import type { BridgeEvent, InboundMessageReceivedEvent } from "../domain/events.js";
import type { PromptWorkHint } from "../domain/types.js";
import type { HerdrRuntimeHint } from "../runtime/herdr-event-hint.js";
import { safeLogError } from "../runtime/safe-error.js";

export type RuntimeWorkHint =
  | { kind: "outbox-ready" }
  | { kind: "card-context-ready" }
  | { kind: "primary-ready"; bindingId: string; promptHint?: PromptWorkHint }
  | { kind: "worker-ready"; instanceId: string }
  | { kind: "turn-control-ready"; ownerKind: "binding" | "instance"; ownerId: string };

interface RuntimeEventPayloads {
  lifecycle: BridgeEvent;
  inbound: InboundMessageReceivedEvent;
  work: RuntimeWorkHint;
  herdr: { hint: HerdrRuntimeHint; signal: AbortSignal };
}

export type RuntimeEventChannel = keyof RuntimeEventPayloads;
export interface RuntimeEventEnvelope<Channel extends RuntimeEventChannel = RuntimeEventChannel> {
  eventId: string;
  channel: Channel;
  key: string;
  occurredAt: string;
  payload: RuntimeEventPayloads[Channel];
}

type RuntimeEventListener<Channel extends RuntimeEventChannel> = (event: RuntimeEventEnvelope<Channel>) => void | Promise<void>;
interface ChannelDiagnostics { published: number; delivered: number; coalesced: number; subscriberFailures: number; pending: number; listenerCount: number; lastFailureAt: string | null; lastFailedSubscriber: string | null; failuresBySubscriber: Readonly<Record<string, number>>; }
export interface RuntimeEventBusSnapshot { channels: Record<RuntimeEventChannel, ChannelDiagnostics>; }
interface RuntimeEventLogger { error(value: object, message: string): void; }

const channels: readonly RuntimeEventChannel[] = ["lifecycle", "inbound", "work", "herdr"];

/** One typed process-local event engine. Channel policy preserves reliability semantics; durable state remains external. */
export class RuntimeEventBus {
  private readonly listeners = new Map<RuntimeEventChannel, Map<string, RuntimeEventListener<never>>>(channels.map((channel) => [channel, new Map()]));
  private readonly diagnostics = new Map<RuntimeEventChannel, MutableChannelDiagnostics>(channels.map((channel) => [channel, emptyDiagnostics()]));
  private readonly pendingWork = new Map<string, RuntimeEventEnvelope<"work">>();
  private workFlushScheduled = false;
  private readonly awaitedPublications = new Set<Promise<void>>();
  private sealed = false;
  private stopped = false;

  constructor(private readonly logger?: RuntimeEventLogger) {}

  subscribe<Channel extends RuntimeEventChannel>(channel: Channel, name: string, listener: RuntimeEventListener<Channel>): () => void {
    if (this.stopped) throw new Error("Runtime event bus is stopped");
    const listeners = this.listeners.get(channel)!;
    if (listeners.has(name)) throw new Error(`Runtime event subscriber already registered: ${channel}:${name}`);
    listeners.set(name, listener as RuntimeEventListener<never>);
    return () => { if (listeners.get(name) === listener) listeners.delete(name); };
  }

  publishLifecycle(event: BridgeEvent): Promise<void> {
    return this.trackAwaited(this.fanOut(this.envelope("lifecycle", event.eventId, `${event.bindingId}:${event.type}`, event.occurredAt, event), true));
  }

  publishInbound(event: InboundMessageReceivedEvent): Promise<void> {
    return this.trackAwaited(this.fanOut(this.envelope("inbound", event.eventId, event.eventId, event.occurredAt, event), false));
  }

  publishWork(payload: RuntimeWorkHint): void {
    if (this.stopped) return;
    const key = workKey(payload);
    const diagnostic = this.diagnostics.get("work")!;
    diagnostic.published += 1;
    if (this.pendingWork.has(key)) diagnostic.coalesced += 1;
    this.pendingWork.set(key, this.envelope("work", randomUUID(), key, new Date().toISOString(), payload));
    diagnostic.pending = this.pendingWork.size;
    if (this.sealed) this.scheduleWorkFlush();
  }

  publishHerdr(hint: HerdrRuntimeHint, signal: AbortSignal): Promise<void> {
    return this.trackAwaited(this.fanOut(this.envelope("herdr", randomUUID(), herdrKey(hint), new Date().toISOString(), { hint, signal }), false));
  }

  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.scheduleWorkFlush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingWork.clear();
    this.diagnostics.get("work")!.pending = 0;
    await Promise.allSettled([...this.awaitedPublications]);
  }

  snapshot(): RuntimeEventBusSnapshot {
    return { channels: Object.fromEntries(channels.map((channel) => {
      const value = this.diagnostics.get(channel)!;
      return [channel, { ...value, listenerCount: this.listeners.get(channel)!.size, failuresBySubscriber: Object.fromEntries(value.failuresBySubscriber) }];
    })) as RuntimeEventBusSnapshot["channels"] };
  }

  private envelope<Channel extends RuntimeEventChannel>(channel: Channel, eventId: string, key: string, occurredAt: string, payload: RuntimeEventPayloads[Channel]): RuntimeEventEnvelope<Channel> {
    return { eventId, channel, key, occurredAt, payload };
  }

  private trackAwaited(publication: Promise<void>): Promise<void> {
    this.awaitedPublications.add(publication);
    void publication.then(
      () => this.awaitedPublications.delete(publication),
      () => this.awaitedPublications.delete(publication)
    );
    return publication;
  }

  private async fanOut<Channel extends RuntimeEventChannel>(event: RuntimeEventEnvelope<Channel>, isolateFailures: boolean, counted = false): Promise<void> {
    if (this.stopped) return;
    const diagnostic = this.diagnostics.get(event.channel)!;
    if (!counted) diagnostic.published += 1;
    const listeners = [...this.listeners.get(event.channel)!.entries()] as Array<[string, RuntimeEventListener<Channel>]>;
    const results = await Promise.allSettled(listeners.map(([, listener]) => Promise.resolve().then(() => listener(event))));
    const failures: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") { diagnostic.delivered += 1; return; }
      const subscriber = listeners[index]![0];
      failures.push(result.reason);
      diagnostic.subscriberFailures += 1;
      diagnostic.failuresBySubscriber.set(subscriber, (diagnostic.failuresBySubscriber.get(subscriber) ?? 0) + 1);
      diagnostic.lastFailureAt = new Date().toISOString();
      diagnostic.lastFailedSubscriber = subscriber;
      this.logger?.error({ event: "runtime-event-subscriber-failed", eventId: event.eventId, channel: event.channel, eventKey: event.key, subscriber, outcome: isolateFailures ? "isolated" : "failed", err: safeLogError(result.reason) }, "runtime event subscriber failed");
    });
    if (!isolateFailures && failures.length > 0) throw failures[0];
  }

  private scheduleWorkFlush(): void {
    if (this.workFlushScheduled || this.pendingWork.size === 0 || this.stopped) return;
    this.workFlushScheduled = true;
    queueMicrotask(() => { void this.flushWork(); });
  }

  private async flushWork(): Promise<void> {
    this.workFlushScheduled = false;
    if (!this.sealed || this.stopped) return;
    const events = [...this.pendingWork.values()];
    this.pendingWork.clear();
    this.diagnostics.get("work")!.pending = 0;
    for (const event of events) this.fanOutBestEffort(event);
    if (this.pendingWork.size > 0) this.scheduleWorkFlush();
  }

  private fanOutBestEffort(event: RuntimeEventEnvelope<"work">): void {
    const listeners = [...this.listeners.get("work")!.entries()] as Array<[string, RuntimeEventListener<"work">]>;
    for (const [subscriber, listener] of listeners) {
      try {
        const result = listener(event);
        this.diagnostics.get("work")!.delivered += 1;
        void Promise.resolve(result).catch((error) => this.recordFailure(event, subscriber, error, "isolated"));
      } catch (error) { this.recordFailure(event, subscriber, error, "isolated"); }
    }
  }

  private recordFailure(event: RuntimeEventEnvelope, subscriber: string, error: unknown, outcome: "isolated" | "failed"): void {
    const diagnostic = this.diagnostics.get(event.channel)!;
    diagnostic.subscriberFailures += 1;
    diagnostic.failuresBySubscriber.set(subscriber, (diagnostic.failuresBySubscriber.get(subscriber) ?? 0) + 1);
    diagnostic.lastFailureAt = new Date().toISOString();
    diagnostic.lastFailedSubscriber = subscriber;
    this.logger?.error({ event: "runtime-event-subscriber-failed", eventId: event.eventId, channel: event.channel, eventKey: event.key, subscriber, outcome, err: safeLogError(error) }, "runtime event subscriber failed");
  }
}

interface MutableChannelDiagnostics extends Omit<ChannelDiagnostics, "listenerCount" | "failuresBySubscriber"> { failuresBySubscriber: Map<string, number>; }
function emptyDiagnostics(): MutableChannelDiagnostics { return { published: 0, delivered: 0, coalesced: 0, subscriberFailures: 0, pending: 0, lastFailureAt: null, lastFailedSubscriber: null, failuresBySubscriber: new Map() }; }
function workKey(hint: RuntimeWorkHint): string {
  if (hint.kind === "primary-ready") return `${hint.kind}:${hint.bindingId}:${hint.promptHint?.kind === "detached-observer-ready" ? hint.promptHint.promptId : "binding"}`;
  if (hint.kind === "worker-ready") return `${hint.kind}:${hint.instanceId}`;
  if (hint.kind === "turn-control-ready") return `${hint.kind}:${hint.ownerKind}:${hint.ownerId}`;
  return hint.kind;
}
function herdrKey(hint: HerdrRuntimeHint): string { return `${hint.kind}:${hint.scope}:${hint.workspaceIds.join(",")}:${hint.paneIds.join(",")}`; }
