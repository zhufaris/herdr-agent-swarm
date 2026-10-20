import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { LarkPort, OutboundCheckpointSubscriber, OutboundIntentPort } from "../../src/domain/ports.js";
import type { PromptWorkScheduler } from "../../src/events/prompt-work-scheduler.js";
import { connectPreparedDeliveryProducers, convergeAfterRingAcknowledgement } from "../../src/composition/create-outbound-runtime.js";
import { DeliveryCheckpointBus } from "../../src/events/delivery-checkpoint-bus.js";
import { OutboundIntentWriter } from "../../src/events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../../src/events/outbound-work-notifier.js";
import { RingDeliveryEngine } from "../../src/events/ring-delivery-engine.js";
import type { SqliteBindingStore } from "./sqlite-binding-store.js";
import { createFeishuCompatibilityDelivery } from "../../src/gateways/feishu/plugin.js";

export type TestOutbound = OutboundIntentPort & OutboundCheckpointSubscriber & {
  start(): () => void;
  stop(): Promise<void>;
  requestScan(force?: boolean): Promise<void>;
  drain(force?: boolean): Promise<void>;
  snapshot(): ReturnType<RingDeliveryEngine["snapshot"]>;
  connectPromptScheduler(scheduler: PromptWorkScheduler): void;
};

/** Ring-native combined facade retained for integration-test ergonomics. */
export function createTestPublisher(store: SqliteBindingStore, lark: LarkPort, logger: Logger): TestOutbound {
  ensureWriteFence(store);
  const work = new InProcessOutboundWorkNotifier(logger);
  const checkpoints = new DeliveryCheckpointBus();
  const delivery = createFeishuCompatibilityDelivery(lark);
  const modules = store.capabilityModules();
  let logicalNow = Date.now();
  const engine = new RingDeliveryEngine({
    store: store.preparedDeliveries,
    refill: store.preparedDeliveries,
    gateway: delivery,
    coldRecoveryEnabled: true,
    safetyScanIntervalMs: 60_000,
    now: () => Math.max(logicalNow, Date.now()),
    scheduleWake: () => null,
    cancelWake: () => {},
    scheduleMaintenance: () => null,
    cancelMaintenance: () => {},
    subscribeWork: (listener) => work.subscribe(listener),
    onAcknowledged: (prepared, ack) => convergeAfterRingAcknowledgement(prepared, ack, { outbox: modules.outbox, checkpoints })
  });
  const consumer = { enqueuePreparedDelivery: (prepared: Parameters<RingDeliveryEngine["enqueue"]>[0]) => { engine.enqueue(prepared); work.wake(); } };
  connectPreparedDeliveryProducers(
    modules.outbox,
    modules.preparedDeliveryProducers,
    delivery,
    consumer
  );
  const writer = new OutboundIntentWriter(store, work, consumer);
  let started = false;
  let disposed = false;
  const start = () => {
    if (disposed) return () => {};
    if (!started) { started = true; engine.start(); }
    return () => { void stop(); };
  };
  const stop = async () => {
    disposed = true;
    if (!started) return;
    started = false;
    await engine.stop();
  };
  const drain = async (force = false) => {
    if (disposed) return;
    logicalNow = Math.max(logicalNow, Date.now());
    if (force) logicalNow += 3_600_001;
    start();
    work.wake();
    await engine.whenRecoveryReady();
    await delay(10);
    let idleObservations = 0;
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (disposed) return;
      const snapshot = engine.snapshot();
      const actionable = store.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 1_000, at: new Date(logicalNow).toISOString() }).items.some(({ status }) => status === "ready");
      if (snapshot.activeDeliveries === 0 && snapshot.runnableRings === 0 && !actionable) {
        idleObservations += 1;
        if (idleObservations >= 2) return;
      } else idleObservations = 0;
      await delay(1);
    }
    const rows = store.database.prepare("SELECT id,kind,state,scope_key,gateway_plan_hash,claim_attempt_id FROM outbound_replies ORDER BY delivery_order").all();
    throw new Error(`test Ring delivery did not become idle: ${JSON.stringify({ snapshot: engine.snapshot(), rows })}`);
  };
  return Object.assign(checkpoints, {
    enqueueCard: writer.enqueueCard.bind(writer),
    enqueueCardUpdate: writer.enqueueCardUpdate.bind(writer),
    enqueueRunCardUpdate: writer.enqueueRunCardUpdate.bind(writer),
    enqueueStreamContent: writer.enqueueStreamContent.bind(writer),
    enqueueStreamCardCreate: writer.enqueueStreamCardCreate.bind(writer),
    enqueueStreamFinish: writer.enqueueStreamFinish.bind(writer),
    enqueueMessageDelete: writer.enqueueMessageDelete.bind(writer),
    start,
    stop,
    requestScan: drain,
    drain,
    snapshot: () => engine.snapshot(),
    connectPromptScheduler: (_scheduler: PromptWorkScheduler) => undefined
  });
}

function ensureWriteFence(store: SqliteBindingStore): void {
  const existing = store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name='bridge_write_fence'").get();
  if (existing) return;
  const current = store.database.prepare("SELECT owner_id, fencing_token, expires_at FROM instance_lease WHERE singleton_id=1").get() as { owner_id: string; fencing_token: number; expires_at: string } | undefined;
  if (current && current.expires_at > new Date().toISOString()) {
    store.activateWriteFence(current.owner_id, current.fencing_token);
    return;
  }
  const ownerId = `test-outbound-${randomUUID()}`;
  const lease = store.acquireInstanceLease(ownerId, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
  if (!lease) throw new Error("test delivery lease unavailable");
  store.activateWriteFence(lease.ownerId, lease.fencingToken);
}
