import { safeLogError } from "./safe-error.js";

export interface ShutdownLogger {
  info(value: object, message: string): void;
  error(value: object, message: string): void;
}

interface ShutdownDependencies {
  coordinator: { stop(): Promise<void> };
  projector: { stop(): Promise<void> };
  publisher: { stop(): Promise<void> };
  healthServer: { close(callback: (error?: Error) => void): unknown };
  lease: { release(): void };
  store: { close(): void };
  logger: ShutdownLogger;
}

export class BridgeRuntimeShutdown {
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: ShutdownDependencies) {}

  shutdown(signal: string): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal: string): Promise<void> {
    const { coordinator, projector, publisher, healthServer, lease, store, logger } = this.dependencies;
    logger.info({ event: "bridge-shutdown-started", signal }, "shutting down");
    await stopSafely("coordinator", () => coordinator.stop(), logger);
    await stopSafely("projector", () => projector.stop(), logger);
    await stopSafely("publisher", () => publisher.stop(), logger);
    await stopSafely("healthServer", () => closeServer(healthServer), logger);
    await stopSafely("lease", async () => { lease.release(); }, logger);
    await stopSafely("store", async () => { store.close(); }, logger);
    logger.info({ event: "bridge-shutdown-completed", signal, outcome: "completed" }, "bridge shutdown completed");
  }
}

async function stopSafely(component: string, stop: () => Promise<void>, logger: ShutdownLogger): Promise<void> {
  try {
    await stop();
  } catch (error) {
    logger.error({ event: "bridge-shutdown-component-failed", err: safeLogError(error), component, outcome: "failed" }, "shutdown component failed");
  }
}

function closeServer(server: ShutdownDependencies["healthServer"]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
