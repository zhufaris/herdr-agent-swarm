import { AGENT_SWARM_SERVICE_ID } from "../../runtime/build-identity.js";

export interface RestartSafetyEvaluationOptions {
  force: boolean;
}

export class RestartSafetyEvaluator {
  evaluate(status: unknown, options: RestartSafetyEvaluationOptions): void {
    const record = asRecord(status);
    const identity = asRecord(record?.identity);
    if (identity?.serviceId !== AGENT_SWARM_SERVICE_ID) {
      const observed = typeof identity?.serviceId === "string" ? identity.serviceId : "missing";
      throw new Error(`restart blocked: active service identity is ${observed}, expected ${AGENT_SWARM_SERVICE_ID}; verify the endpoint or retry with --force`);
    }

    const metrics = readRestartSafetyMetrics(record ?? {});
    if (!options.force) {
      assertNoActiveAgentWork(metrics);
      assertNoActionableOutboxWork(metrics);
      if (metrics.activeDeliveries! > 0) {
        throw new Error(`restart blocked: ${metrics.activeDeliveries} active deliveries; wait for delivery to drain or retry with --force`);
      }
    }
    if (metrics.startupRecoveryState !== null && metrics.startupRecoveryState !== "completed") {
      throw new Error(`restart blocked: startup recovery is ${metrics.startupRecoveryState}, expected completed; wait for recovery or retry with --force`);
    }
    if ((!options.force && metrics.sqliteIntegrityState !== null && metrics.sqliteIntegrityState !== "healthy")
      || (metrics.sqliteQuickCheck !== null && metrics.sqliteQuickCheck !== "ok")) {
      throw new Error(`restart blocked: SQLite integrity is ${metrics.sqliteIntegrityState ?? "missing"} with quickCheck ${metrics.sqliteQuickCheck ?? "missing"}; repair integrity or retry with --force`);
    }
    if (hasIncompleteRequiredMetrics(metrics, options.force)) {
      throw new Error("restart blocked: active service status has incomplete restart safety metrics; verify the running unit or retry with --force");
    }
  }
}

interface RestartSafetyMetrics {
  running: number | null;
  queued: number | null;
  activeWorkers: number | null;
  instanceDispatchers: number | null;
  instanceObservers: number | null;
  activeInstanceTurns: number | null;
  uncertainInstanceTurns: number | null;
  readyOutbox: number | null;
  inFlightOutbox: number | null;
  retryWaitOutbox: number | null;
  cooldownWaitOutbox: number | null;
  waitingBehindLaneOutbox: number | null;
  activeDeliveries: number | null;
  startupRecoveryState: string | null;
  sqliteIntegrityState: string | null;
  sqliteQuickCheck: string | null;
}

function readRestartSafetyMetrics(record: Record<string, unknown>): RestartSafetyMetrics {
  const operational = asRecord(record.operational);
  const prompts = asRecord(operational?.prompts);
  const promptWorker = asRecord(record.promptWorker);
  const instanceWorker = asRecord(record.instanceWorker);
  const outboxWork = asRecord(operational?.outboxWork);
  const outboxDispatcher = asRecord(record.outboxDispatcher);
  const startupRecovery = asRecord(record.startupRecovery);
  const sqliteIntegrity = asRecord(record.sqliteIntegrity);
  return {
    running: nonNegativeInteger(prompts?.running),
    queued: nonNegativeInteger(prompts?.queued),
    activeWorkers: nonNegativeInteger(promptWorker?.activeTurnWorkers),
    instanceDispatchers: nonNegativeInteger(instanceWorker?.activeDispatchWorkers),
    instanceObservers: nonNegativeInteger(instanceWorker?.activeObservers),
    activeInstanceTurns: nonNegativeInteger(instanceWorker?.activeTurns),
    uncertainInstanceTurns: nonNegativeInteger(instanceWorker?.uncertainTurns),
    readyOutbox: nonNegativeInteger(outboxWork?.ready),
    inFlightOutbox: nonNegativeInteger(outboxWork?.inFlight),
    retryWaitOutbox: nonNegativeInteger(outboxWork?.retryWait),
    cooldownWaitOutbox: nonNegativeInteger(outboxWork?.cooldownWait),
    waitingBehindLaneOutbox: nonNegativeInteger(outboxWork?.waitingBehindLane),
    activeDeliveries: nonNegativeInteger(outboxDispatcher?.activeDeliveries),
    startupRecoveryState: stringValue(startupRecovery?.state),
    sqliteIntegrityState: stringValue(sqliteIntegrity?.state),
    sqliteQuickCheck: stringValue(sqliteIntegrity?.quickCheck),
  };
}

function assertNoActiveAgentWork(metrics: RestartSafetyMetrics): void {
  if (metrics.running! <= 0 && metrics.queued! <= 0 && metrics.activeWorkers! <= 0
    && metrics.instanceDispatchers! <= 0 && metrics.instanceObservers! <= 0
    && metrics.activeInstanceTurns! <= 0 && metrics.uncertainInstanceTurns! <= 0) return;
  throw new Error(
    `restart blocked: ${metric(metrics.running)} running prompts, ${metric(metrics.queued)} queued prompts, ${metric(metrics.activeWorkers)} active turn workers; `
    + `instance work has ${metric(metrics.instanceDispatchers)} dispatchers, ${metric(metrics.instanceObservers)} observers, `
    + `${metric(metrics.activeInstanceTurns)} active turns, ${metric(metrics.uncertainInstanceTurns)} uncertain turns; `
    + "wait for active work to drain or retry with --force",
  );
}

function assertNoActionableOutboxWork(metrics: RestartSafetyMetrics): void {
  if (metrics.readyOutbox! <= 0 && metrics.inFlightOutbox! <= 0
    && metrics.retryWaitOutbox! <= 0 && metrics.cooldownWaitOutbox! <= 0) return;
  throw new Error(
    `restart blocked: outbox work has ${metric(metrics.readyOutbox)} ready, ${metric(metrics.inFlightOutbox)} in-flight, `
    + `${metric(metrics.retryWaitOutbox)} retry-wait, ${metric(metrics.cooldownWaitOutbox)} cooldown-wait, `
    + `${metric(metrics.waitingBehindLaneOutbox)} waiting behind lanes; wait for actionable delivery work to drain or retry with --force`,
  );
}

function hasIncompleteRequiredMetrics(metrics: RestartSafetyMetrics, force: boolean): boolean {
  const workload = [
    metrics.running, metrics.queued, metrics.activeWorkers, metrics.instanceDispatchers,
    metrics.instanceObservers, metrics.activeInstanceTurns, metrics.uncertainInstanceTurns,
    metrics.readyOutbox, metrics.inFlightOutbox, metrics.retryWaitOutbox,
    metrics.cooldownWaitOutbox, metrics.waitingBehindLaneOutbox, metrics.activeDeliveries,
  ];
  return !force && workload.some((value) => value === null)
    || metrics.startupRecoveryState === null
    || metrics.sqliteIntegrityState === null
    || metrics.sqliteQuickCheck === null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function metric(value: number | null): number | "unknown" {
  return value ?? "unknown";
}
