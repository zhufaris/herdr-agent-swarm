import { safeLogError } from "./safe-error.js";
import { createShutdownContext, DEFAULT_SHUTDOWN_GRACE_MS, type ShutdownContext } from "./shutdown-context.js";
import type { LifecycleCleanupEntry } from "./lifecycle-ledger.js";

interface ShutdownLogger {
  info(value: object, message: string): void;
  warn?(value: object, message: string): void;
  error(value: object, message: string): void;
}

interface ShutdownDependencies {
  cleanupEntries: readonly LifecycleCleanupEntry[];
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
    const { cleanupEntries, lease, store, logger } = this.dependencies;
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
    for (const entry of cleanupEntries) {
      const stopped = await this.stopComponent(entry.name, () => entry.stop(context), context, logger, failures, timeouts);
      if (entry.kind === "writer") writers.push({ component: entry.name, ...stopped });
    }
    if (!context.signal.aborted && context.remainingMs() === 0) { expired = true; abort(new Error("bridge shutdown deadline exceeded")); }
    const writersSettled = Promise.all(writers.map(({ settled }) => settled));
    const allWritersSettled = await settlesWithin(writersSettled, this.dependencies.abortSettlementMs ?? 1_000);
    if (!allWritersSettled && !context.signal.aborted) { expired = true; abort(new Error("bridge shutdown deadline exceeded")); }
    const unsafeWriterNames = writers
      .filter((writer) => !writer.isSettled() || failures.includes(writer.component))
      .map(({ component }) => component);
    if (unsafeWriterNames.length > 0) {
      const failedWriters = unsafeWriterNames.filter((component) => failures.includes(component));
      const unsettledWriters = unsafeWriterNames.filter((component) => !writers.find((writer) => writer.component === component)?.isSettled());
      logger.error({ event: "bridge-shutdown-writers-unsafe", components: unsafeWriterNames, failedWriters, unsettledWriters, outcome: "ownership_retained" }, "write-capable shutdown components did not stop cleanly; retaining SQLite ownership");
      if (this.deadlineAbortTimer) clearTimeout(this.deadlineAbortTimer);
      return { outcome: "ownership_retained", unsettledWriters: unsafeWriterNames };
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

export function closeHealthServer(server: { close(callback: (error?: Error) => void): unknown }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
