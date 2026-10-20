import type { PreparedDelivery, OutboundWorkClass } from "./delivery.js";
import type { DeliveryScope } from "./delivery-scope.js";
import type { DeliveryLatencySnapshot } from "./delivery-trace.js";

export type DeliveryEngineState = "starting" | "running" | "stopping" | "stopped" | "degraded";
export type DeliveryCacheSource = "commit" | "cold";

export interface DeliverySnapshot {
  latency?: DeliveryLatencySnapshot;
  state: DeliveryEngineState;
  ringCount: number;
  runnableRings: number;
  activeDeliveries: number;
  cachedItems: number;
  cachedBytes: number;
  processByteLimit: number;
  overflowedScopes: number;
  quarantinedScopes: number;
  oldestReadyAt: string | null;
  oldestLiveReadyAt: string | null;
  oldestHistoryReadyAt: string | null;
  nextRetryAt: string | null;
  lastRefillAt: string | null;
  safetyScanRuns: number;
  safetyScanDiscoveries: number;
  lastSafetyScanAt: string | null;
  lastSafetyScanDiscoveryAt: string | null;
  lastDeliveryAt: string | null;
  lastFailureAt: string | null;
  recoveryReady: boolean;
}

export interface DeliveryEngine {
  start(): void;
  whenRecoveryReady(): Promise<void>;
  enqueue(delivery: PreparedDelivery): void;
  stop(context?: DeliveryEngineStopContext): Promise<void>;
  snapshot(): DeliverySnapshot;
}

export interface DeliveryEngineStopContext {
  signal: AbortSignal;
  deadlineAt: number;
  remainingMs(): number;
}

export interface DeliveryEngineRefillResult {
  deliveries: readonly PreparedDelivery[];
  nextRetryAt: string | null;
  nextPageToken?: string | null;
  recoveryBlocked?: boolean;
}

/** Read-only durable discovery used by the shadow engine. It cannot claim or settle effects. */
export interface DeliveryEngineRefillPort {
  load(input: { scope: DeliveryScope | null; limit: number; now: string; pageToken?: string | null }): Promise<DeliveryEngineRefillResult>;
  isDurablyEmpty(scope: DeliveryScope, now: string): Promise<boolean>;
}

export type DeliveryEngineEvent =
  | { kind: "enqueue-accepted" | "enqueue-duplicate"; replyId: string; scopeKey: string; source: DeliveryCacheSource; workClass: OutboundWorkClass; deliveryOrder: number }
  | { kind: "enqueue-rejected"; replyId: string; scopeKey: string; reason: "stopped" | "overflow" | "oversized" | "stale"; source: DeliveryCacheSource }
  | { kind: "refill-requested"; scopeKey: string | null; reason: "startup" | "overflow" | "stale" | "safety" }
  | { kind: "refill-completed"; scopeKey: string | null; count: number }
  | { kind: "refill-failed"; scopeKey: string | null }
  | { kind: "shadow-grant"; replyId: string; scopeKey: string; workClass: OutboundWorkClass; deliveryOrder: number; source: DeliveryCacheSource; waitMs: number }
  | { kind: "ring-evicted"; scopeKey: string };

export interface DeliveryEngineObserver { record(event: DeliveryEngineEvent): void }

export interface DeliveryEngineLimits {
  paneItems: number;
  paneBytes: number;
  globalItems: number;
  globalBytes: number;
  processBytes: number;
}
