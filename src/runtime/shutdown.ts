import { safeLogError } from "./safe-error.js";
import { createShutdownContext, DEFAULT_SHUTDOWN_GRACE_MS, type ShutdownContext } from "./shutdown-context.js";

interface ShutdownLogger {
  info(value: object, message: string): void;
  warn?(value: object, message: string): void;
  error(value: object, message: string): void;
}

interface ShutdownDependencies {
  primaryToolGateway?: { stop(): Promise<void> };
  herdrSocketSubscriber?: { stop(): Promise<void> };
  paneRetention?: { stop(): Promise<void> };
  externalTurns?: { stop(): Promise<void> };
  instanceRuntime?: { stop(): Promise<void> };
  instanceWorker?: { stop(context?: ShutdownContext): Promise<void> };
  integrityAuditor?: { stop(context?: ShutdownContext): Promise<void> };
  coordinator?: { stop(context?: ShutdownContext): Promise<void> };
  outboxRetention?: { stop(): Promise<void> };
  queueFeedbackProjector?: { stop(context?: ShutdownContext): Promise<void> };
  cardContextRebuilder?: { stop(context?: ShutdownContext): Promise<void> };
  projector?: { stop(context?: ShutdownContext): Promise<void> };
  publisher?: { stop(context?: ShutdownContext): Promise<void> };
  healthServer?: { close(callback: (error?: Error) => void): unknown };
  lease: { release(): void };
  store: { deactivateWriteFence(): void; close(): void };
  logger: ShutdownLogger;
  shutdownGraceMs?: number;
  abortSettlementMs?: number;
}

export type BridgeRuntimeShutdownOutcome =
  | { outcome: "completed"; unsettledWriters: [] }
  | { outcome: "ownership_retained"; unsettledWriters: string[] };

interface TrackedWriter {
  component: string;
  settled: Promise<void>;
  isSettled(): boolean;
}

export class BridgeRuntimeShutdown {
  private shutdownPromise: Promise<BridgeRuntimeShutdownOutcome> | null = null;
  private deadlineAbortTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: ShutdownDependencies) {}

  shutdown(signal: string): Promise<BridgeRuntimeShutdownOutcome> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal: string): Promise<BridgeRuntimeShutdownOutcome> {
    const { herdrSocketSubscriber, primaryToolGateway, paneRetention, externalTurns, instanceRuntime, instanceWorker, integrityAuditor, coordinator, outboxRetention, queueFeedbackProjector, cardContextRebuilder, projector, publisher, healthServer, lease, store, logger } = this.dependencies;
    const startedAt = Date.now();
    const budgetMs = this.dependencies.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const { context, abort } = createShutdownContext(budgetMs);
    const failures: string[] = [];
    const timeouts: string[] = [];
    let expired = false;
    const writers: TrackedWriter[] = [];
    this.deadlineAbortTimer = setTimeout(() => {
      if (context.signal.aborted) return;
      expired = true;
      abort(new Error("bridge shutdown deadline exceeded"));
      logger.warn?.({ event: "bridge-shutdown-deadline-exceeded", signal, budgetMs, outcome: "aborted" }, "bridge shutdown deadline exceeded");
    }, budgetMs);
    this.deadlineAbortTimer.unref?.();
    logger.info({ event: "bridge-shutdown-started", signal, deadlineAt: context.deadlineAt, budgetMs }, "shutting down");
    if (primaryToolGateway) writers.push({ component: "primaryToolGateway", ...(await this.stopComponent("primaryToolGateway", () => primaryToolGateway.stop(), context, logger, failures, timeouts)) });
    if (herdrSocketSubscriber) await this.stopComponent("herdrSocketSubscriber", () => herdrSocketSubscriber.stop(), context, logger, failures, timeouts);
    if (paneRetention) writers.push({ component: "paneRetention", ...(await this.stopComponent("paneRetention", () => paneRetention.stop(), context, logger, failures, timeouts)) });
    if (externalTurns) writers.push({ component: "externalTurns", ...(await this.stopComponent("externalTurns", () => externalTurns.stop(), context, logger, failures, timeouts)) });
    if (instanceRuntime) writers.push({ component: "instanceRuntime", ...(await this.stopComponent("instanceRuntime", () => instanceRuntime.stop(), context, logger, failures, timeouts)) });
    if (instanceWorker) writers.push({ component: "instanceWorker", ...(await this.stopComponent("instanceWorker", () => instanceWorker.stop(context), context, logger, failures, timeouts)) });
    if (integrityAuditor) await this.stopComponent("integrityAuditor", () => integrityAuditor.stop(context), context, logger, failures, timeouts);
    if (coordinator) writers.push({ component: "coordinator", ...(await this.stopComponent("coordinator", () => coordinator.stop(context), context, logger, failures, timeouts)) });
    if (outboxRetention) writers.push({ component: "outboxRetention", ...(await this.stopComponent("outboxRetention", () => outboxRetention.stop(), context, logger, failures, timeouts)) });
    if (queueFeedbackProjector) writers.push({ component: "queueFeedbackProjector", ...(await this.stopComponent("queueFeedbackProjector", () => queueFeedbackProjector.stop(context), context, logger, failures, timeouts)) });
    if (cardContextRebuilder) writers.push({ component: "cardContextRebuilder", ...(await this.stopComponent("cardContextRebuilder", () => cardContextRebuilder.stop(context), context, logger, failures, timeouts)) });
    if (projector) writers.push({ component: "projector", ...(await this.stopComponent("projector", () => projector.stop(context), context, logger, failures, timeouts)) });
    if (publisher) writers.push({ component: "publisher", ...(await this.stopComponent("publisher", () => publisher.stop(context), context, logger, failures, timeouts)) });
    if (healthServer) await this.stopComponent("healthServer", () => closeServer(healthServer), context, logger, failures, timeouts);
    if (!context.signal.aborted && context.remainingMs() === 0) { expired = true; abort(new Error("bridge shutdown deadline exceeded")); }
    const writersSettled = Promise.all(writers.map(({ settled }) => settled));
    if (!await settlesWithin(writersSettled, this.dependencies.abortSettlementMs ?? 1_000)) {
      if (!context.signal.aborted) { expired = true; abort(new Error("bridge shutdown deadline exceeded")); }
      const writerNames = writers.filter((writer) => !writer.isSettled()).map(({ component }) => component);
      logger.error({ event: "bridge-shutdown-writers-unsettled", components: writerNames, outcome: "ownership_retained" }, "write-capable shutdown components did not settle; retaining SQLite ownership");
      if (this.deadlineAbortTimer) clearTimeout(this.deadlineAbortTimer);
      return { outcome: "ownership_retained", unsettledWriters: writerNames };
    }
    if (this.deadlineAbortTimer) clearTimeout(this.deadlineAbortTimer);
    await stopSafely("writeFence", async () => { store.deactivateWriteFence(); }, logger);
    await stopSafely("lease", async () => { lease.release(); }, logger);
    await stopSafely("store", async () => { store.close(); }, logger);
    logger.info({ event: "bridge-shutdown-completed", signal, durationMs: Date.now() - startedAt, expired, failures, timeouts, outcome: "completed" }, "bridge shutdown completed");
    return { outcome: "completed", unsettledWriters: [] };
  }

  private async stopComponent(component: string, stop: () => Promise<void>, context: ShutdownContext, logger: ShutdownLogger, failures: string[], timeouts: string[]): Promise<{ settled: Promise<void>; isSettled(): boolean }> {
    let hasSettled = false;
    const settled = stopSafely(component, stop, logger, failures);
    void settled.finally(() => { hasSettled = true; });
    if (await settlesWithin(settled, context.remainingMs())) return { settled, isSettled: () => hasSettled };
    timeouts.push(component);
    logger.error({ event: "bridge-shutdown-component-timed-out", component, remainingMs: context.remainingMs(), outcome: "timed_out" }, "shutdown component exceeded the shared deadline");
    return { settled, isSettled: () => hasSettled };
  }
}

async function stopSafely(component: string, stop: () => Promise<void>, logger: ShutdownLogger, failures: string[] = []): Promise<void> {
  try {
    await stop();
  } catch (error) {
    failures.push(component);
    logger.error({ event: "bridge-shutdown-component-failed", err: safeLogError(error), component, outcome: "failed" }, "shutdown component failed");
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    void promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

function closeServer(server: NonNullable<ShutdownDependencies["healthServer"]>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
