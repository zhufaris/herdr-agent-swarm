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
      assertNoActionableRingWork(metrics);
      if (metrics.activeRingDeliveries! > 0) {
        throw new Error(`restart blocked: ${metrics.activeRingDeliveries} active Ring deliveries; wait for delivery to drain or retry with --force`);
      }
    }
    const startupRestartable = metrics.startupRecoveryState === "completed" || options.force && metrics.startupRecoveryState === "degraded";
    if (metrics.startupRecoveryState !== null && !startupRestartable) {
      const guidance = options.force ? "inspect startup recovery before retrying" : "wait for recovery or retry with --force";
      throw new Error(`restart blocked: startup recovery is ${metrics.startupRecoveryState}, expected completed; ${guidance}`);
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
  instanceDispatchers: number | null;
  instanceObservers: number | null;
  activeInstanceTurns: number | null;
  uncertainInstanceTurns: number | null;
  ringReady: number | null;
  ringActiveClaims: number | null;
  ringRetryWait: number | null;
  activeRingDeliveries: number | null;
  startupRecoveryState: string | null;
  sqliteIntegrityState: string | null;
  sqliteQuickCheck: string | null;
}

function readRestartSafetyMetrics(record: Record<string, unknown>): RestartSafetyMetrics {
  const operational = asRecord(record.operational);
  const instanceWorker = asRecord(record.instanceWorker);
  const deliveryRings = asRecord(operational?.deliveryRings);
  const deliveryEngine = asRecord(record.deliveryEngine);
  const startupRecovery = asRecord(record.startupRecovery);
  const sqliteIntegrity = asRecord(record.sqliteIntegrity);
  return {
    instanceDispatchers: nonNegativeInteger(instanceWorker?.activeDispatchWorkers),
    instanceObservers: nonNegativeInteger(instanceWorker?.activeObservers),
    activeInstanceTurns: nonNegativeInteger(instanceWorker?.activeTurns),
    uncertainInstanceTurns: nonNegativeInteger(instanceWorker?.uncertainTurns),
    ringReady: nonNegativeInteger(deliveryRings?.ready),
    ringActiveClaims: nonNegativeInteger(deliveryRings?.activeClaims),
    ringRetryWait: nonNegativeInteger(deliveryRings?.retryWait),
    activeRingDeliveries: nonNegativeInteger(deliveryEngine?.activeDeliveries),
    startupRecoveryState: stringValue(startupRecovery?.state),
    sqliteIntegrityState: stringValue(sqliteIntegrity?.state),
    sqliteQuickCheck: stringValue(sqliteIntegrity?.quickCheck),
  };
}

function assertNoActionableRingWork(metrics: RestartSafetyMetrics): void {
  if (metrics.ringReady! <= 0 && metrics.ringActiveClaims! <= 0 && metrics.ringRetryWait! <= 0) return;
  throw new Error(
    `restart blocked: Ring work has ${metric(metrics.ringReady)} Ring-ready, ${metric(metrics.ringActiveClaims)} active claims, `
    + `${metric(metrics.ringRetryWait)} retry-wait; wait for actionable delivery work to drain or retry with --force`,
  );
}

function assertNoActiveAgentWork(metrics: RestartSafetyMetrics): void {
  if (metrics.instanceDispatchers! <= 0 && metrics.instanceObservers! <= 0
    && metrics.activeInstanceTurns! <= 0 && metrics.uncertainInstanceTurns! <= 0) return;
  throw new Error(
    `restart blocked: instance work has ${metric(metrics.instanceDispatchers)} dispatchers, ${metric(metrics.instanceObservers)} observers, `
    + `${metric(metrics.activeInstanceTurns)} active turns, ${metric(metrics.uncertainInstanceTurns)} uncertain turns; `
    + "wait for active work to drain or retry with --force",
  );
}

function hasIncompleteRequiredMetrics(metrics: RestartSafetyMetrics, force: boolean): boolean {
  const workload = [
    metrics.instanceDispatchers, metrics.instanceObservers, metrics.activeInstanceTurns, metrics.uncertainInstanceTurns,
    metrics.ringReady, metrics.ringActiveClaims, metrics.ringRetryWait, metrics.activeRingDeliveries,
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
