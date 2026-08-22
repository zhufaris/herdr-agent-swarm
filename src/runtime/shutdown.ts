export interface ShutdownLogger {
  info(value: object, message: string): void;
  error(value: object, message: string): void;
}

interface ShutdownDependencies {
  coordinator: { stop(): Promise<void> };
  projector: { stop(): Promise<void> };
  publisher: { stop(): Promise<void> };
  healthServer: { close(callback: (error?: Error) => void): unknown };
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
    const { coordinator, projector, publisher, healthServer, store, logger } = this.dependencies;
    logger.info({ signal }, "shutting down");
    await stopSafely("coordinator", () => coordinator.stop(), logger);
    await stopSafely("projector", () => projector.stop(), logger);
    await stopSafely("publisher", () => publisher.stop(), logger);
    await stopSafely("healthServer", () => closeServer(healthServer), logger);
    await stopSafely("store", async () => { store.close(); }, logger);
  }
}

async function stopSafely(component: string, stop: () => Promise<void>, logger: ShutdownLogger): Promise<void> {
  try {
    await stop();
  } catch (error) {
    logger.error({ err: error, component }, "shutdown component failed");
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
