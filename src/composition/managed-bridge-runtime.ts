import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { startHealthServer } from "../health/server.js";
import { ExecFileCommandRunner } from "../infra/command-runner.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import { detectAgentRuntimeAvailabilities } from "../runtime/agents/agent-availability.js";
import { InstanceLeaseController } from "../runtime/instance-lease.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import { RuntimeLifecycleLedger, type LifecycleCleanupEntry } from "../runtime/lifecycle-ledger.js";
import { BridgeRuntimeShutdown, closeHealthServer, type BridgeRuntimeShutdownOutcome } from "../runtime/shutdown.js";
import { openSqliteLeaseBootstrap } from "../store/sqlite-lease-bootstrap.js";
import { createBridgeRuntime } from "./create-bridge-runtime.js";
import type { NaturalLanguageCommandRuntime } from "../runtime/natural-language-command-runtime.js";

export type RuntimeStopReason = "SIGINT" | "SIGTERM" | "lease-lost" | "startup-failure";

interface HealthServer { close(callback: (error?: Error) => void): unknown; }
interface LifecycleLogger {
  info(value: object, message: string): void;
  warn?(value: object, message: string): void;
  error(value: object, message: string): void;
}

export interface ManagedBridgeRuntimeDependencies {
  reconcileIntervalMs: number;
  store: { activateWriteFence(ownerId: string, fencingToken: number): void; deactivateWriteFence(): void; close(): void };
  lease: { acquire(): void; writeFence(): { ownerId: string; fencingToken: number }; start(onLost: () => void | Promise<void>): void; release(): void };
  primaryToolGateway: { start(): Promise<void>; stop(): Promise<void> };
  naturalLanguageCommands: NaturalLanguageCommandRuntime;
  sqliteIntegrity: { start(): void; run(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  instanceRuntime: { reconcile(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  instanceTurns: { prepareRecovery(): void; reconcile(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  herdrSnapshotCache: { withStartupSnapshotReuse<T>(operation: () => Promise<T>): Promise<T> };
  instanceWork: { stop(context?: ShutdownContext): Promise<void> };
  createHealthServer(): Promise<HealthServer>;
  channelPublisher: { start(): void; stop(context?: ShutdownContext): Promise<void> };
  outboxRetention: { start(): void; stop(): Promise<void> };
  projector: { start(): unknown; stop(context?: ShutdownContext): Promise<void> };
  cardContextRebuilder: { start(intervalMs: number): void; stop(context?: ShutdownContext): Promise<void> };
  queueFeedbackProjector: { start(bus: unknown): void; converge(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  bus: unknown;
  coordinator: { prepareDelivery(): Promise<void>; recoverRuntime(): Promise<void>; start(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  paneRetention: { scan(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  externalTurns: { start(): void; stop(): Promise<void> };
  herdrSocketSubscriber?: { startEvents(): void; stopIngress(): void; drainEvents(): Promise<void> };
  logger: LifecycleLogger;
  onFatalStop?(reason: "lease-lost", result: BridgeRuntimeShutdownOutcome): void | Promise<void>;
}

export interface ManagedBridgeRuntimePort {
  start(): Promise<void>;
  stop(reason: RuntimeStopReason): Promise<BridgeRuntimeShutdownOutcome>;
}

export async function createManagedBridgeRuntime(options: {
  config: BridgeConfig;
  buildIdentity: BuildIdentity;
  logger: Logger;
  onFatalStop?(reason: "lease-lost", result: BridgeRuntimeShutdownOutcome): void | Promise<void>;
}): Promise<ManagedBridgeRuntimePort> {
  const { config, buildIdentity, logger, onFatalStop } = options;
  const availabilityRunner = new ExecFileCommandRunner(config.commandTimeoutMs);
  const availabilityPromise = detectAgentRuntimeAvailabilities({
    runner: availabilityRunner, herdrExecutable: config.herdr.executable,
    agents: { codex: config.agents.codex, claude: config.agents.claudeCode, pi: config.agents.pi }
  }).then(
    (availability) => ({ availability } as const),
    (error: unknown) => ({ error } as const)
  );
  const bootstrap = openSqliteLeaseBootstrap(config.databasePath);
  const lease = new InstanceLeaseController(bootstrap.lease, config.instanceLease, logger);
  let stores: ReturnType<typeof bootstrap.complete> | null = null;
  let leaseAcquired = false;
  try {
    lease.acquire();
    leaseAcquired = true;
    const completedStores = bootstrap.complete(lease.writeFence());
    stores = completedStores;
    if (!lease.renewNow()) throw new Error("Bridge database lease expired during schema migration");
    const availabilityResult = await availabilityPromise;
    if ("error" in availabilityResult) throw availabilityResult.error;
    if (!lease.renewNow()) throw new Error("Bridge database lease expired during Agent capability detection");
    const { codex, claude, pi } = availabilityResult.availability;
    const runtime = createBridgeRuntime(config, completedStores, logger, { codex, claude, pi });
    const { herdr, herdrCircuitBreaker, herdrSocketSubscriber, instanceRuntime, instanceTurns, instanceWork, primaryToolGateway, naturalLanguageCommands, sqliteIntegrity, coordinator, queueFeedbackProjector, cardContextRebuilder, projector, channelPublisher, outboxRetention, paneRetention, externalTurns, instanceWorker, bus, sessionOperations, reconciler, promptRun } = runtime;
    return new ManagedBridgeRuntime({
      reconcileIntervalMs: config.reconcileIntervalMs,
      store: completedStores.lifecycle,
      lease,
      primaryToolGateway, naturalLanguageCommands,
      sqliteIntegrity,
      instanceRuntime,
      instanceTurns,
      herdrSnapshotCache: herdr,
      instanceWork,
      createHealthServer: () => startHealthServer({
        ...config.http, store: completedStores.health, herdr, gateway: runtime.gateway, projects: config.projects, lease,
        workspaceCache: herdr, herdrCircuitBreaker, startupRecovery: coordinator,
        inboundDispatcher: { snapshot: () => coordinator.inboundSnapshot() },
        sessionOperationDispatcher: sessionOperations, bindingRuntime: reconciler, instanceRuntime,
        instanceWorker, sqliteIntegrity, lifecycleEvents: bus, cardConvergence: projector,
        outboxDispatcher: channelPublisher, promptWorker: promptRun,
        ...(herdrSocketSubscriber ? { herdrSocket: herdrSocketSubscriber } : {}), buildIdentity
      }),
      channelPublisher, outboxRetention, projector, cardContextRebuilder, queueFeedbackProjector, bus,
      coordinator, paneRetention, externalTurns,
      ...(herdrSocketSubscriber ? { herdrSocketSubscriber } : {}),
      ...(onFatalStop ? { onFatalStop } : {}), logger
    }, { leaseAlreadyAcquired: true });
  } catch (error) {
    if (leaseAcquired) lease.release();
    if (stores) stores.lifecycle.close();
    else bootstrap.close();
    throw error;
  }
}

export class ManagedBridgeRuntime implements ManagedBridgeRuntimePort {
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<BridgeRuntimeShutdownOutcome> | null = null;
  private readonly lifecycle = new RuntimeLifecycleLedger();
  private writeFenceActive = false;

  private leaseAcquired: boolean;

  constructor(
    private readonly dependencies: ManagedBridgeRuntimeDependencies,
    options: { leaseAlreadyAcquired?: boolean } = {}
  ) {
    this.leaseAcquired = options.leaseAlreadyAcquired ?? false;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) return Promise.reject(new Error("Cannot start a stopped bridge runtime"));
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  stop(reason: RuntimeStopReason): Promise<BridgeRuntimeShutdownOutcome> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  private async performStart(): Promise<void> {
    const d = this.dependencies;
    try {
      if (!this.leaseAcquired) {
        d.lease.acquire();
        this.leaseAcquired = true;
      }
      const writeFence = d.lease.writeFence();
      d.store.activateWriteFence(writeFence.ownerId, writeFence.fencingToken);
      this.writeFenceActive = true;
      d.lease.start(async () => {
        const result = await this.stop("lease-lost");
        await d.onFatalStop?.("lease-lost", result);
      });
      this.assertStarting();
      d.instanceTurns.prepareRecovery();
      let ingressStarts: Promise<PromiseSettledResult<void>[]> | null = null;
      this.registerCleanup("primaryToolGateway", "ingress", "writer", async () => { await ingressStarts; await d.primaryToolGateway.stop(); });
      this.registerCleanup("naturalLanguageCommands", "ingress", "writer", async () => { await ingressStarts; await d.naturalLanguageCommands.stop(); });
      ingressStarts = Promise.allSettled([
        Promise.resolve().then(() => d.primaryToolGateway.start()),
        Promise.resolve().then(() => d.naturalLanguageCommands.start())
      ]);
      const ingressResults = await ingressStarts;
      const ingressFailure = ingressResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (ingressFailure) throw ingressFailure.reason;
      this.assertStarting();
      this.registerCleanup("integrityAuditor", "workers", "non-writer", (context) => d.sqliteIntegrity.stop(context));
      d.sqliteIntegrity.start();
      await d.sqliteIntegrity.run();
      this.assertStarting();
      this.registerCleanup("coordinator", "workers", "writer", (context) => d.coordinator.stop(context));
      this.registerCleanup("instanceWork", "workers", "writer", (context) => d.instanceWork.stop(context));
      await d.coordinator.prepareDelivery();
      this.assertStarting();
      await d.herdrSnapshotCache.withStartupSnapshotReuse(async () => {
        await d.instanceRuntime.reconcile();
        this.assertStarting();
        await d.instanceTurns.reconcile();
        this.assertStarting();
        await d.coordinator.recoverRuntime();
      });
      this.assertStarting();
      const healthServer = await d.createHealthServer();
      this.registerCleanup("healthServer", "health", "non-writer", () => closeHealthServer(healthServer));
      this.assertStarting();
      this.registerCleanup("publisher", "projections", "writer", (context) => d.channelPublisher.stop(context));
      d.channelPublisher.start();
      this.registerCleanup("outboxRetention", "projections", "writer", () => d.outboxRetention.stop());
      d.outboxRetention.start();
      this.registerCleanup("projector", "projections", "writer", (context) => d.projector.stop(context));
      d.projector.start();
      this.registerCleanup("cardContextRebuilder", "projections", "writer", (context) => d.cardContextRebuilder.stop(context));
      d.cardContextRebuilder.start(d.reconcileIntervalMs);
      this.registerCleanup("queueFeedbackProjector", "projections", "writer", (context) => d.queueFeedbackProjector.stop(context));
      d.queueFeedbackProjector.start(d.bus);
      await d.queueFeedbackProjector.converge();
      this.assertStarting();
      await d.coordinator.start();
      this.assertStarting();
      await d.paneRetention.scan();
      this.assertStarting();
      this.registerCleanup("paneRetention", "observers", "writer", () => d.paneRetention.stop());
      d.paneRetention.start(d.reconcileIntervalMs);
      this.registerCleanup("externalTurns", "observers", "writer", () => d.externalTurns.stop());
      d.externalTurns.start();
      this.registerCleanup("instanceRuntime", "workers", "writer", () => d.instanceRuntime.stop());
      d.instanceRuntime.start(d.reconcileIntervalMs);
      this.registerCleanup("instanceTurns", "workers", "writer", () => d.instanceTurns.stop());
      d.instanceTurns.start(d.reconcileIntervalMs);
      if (d.herdrSocketSubscriber) {
        // Ingress-stage cleanup runs in reverse registration order: close admission before awaiting its writer drain.
        this.registerCleanup("herdrSocketEventDrain", "ingress", "writer", () => d.herdrSocketSubscriber!.drainEvents());
        this.registerCleanup("herdrSocketIngress", "ingress", "non-writer", async () => d.herdrSocketSubscriber!.stopIngress());
        d.herdrSocketSubscriber.startEvents();
      }
    } catch (error) {
      await this.stop("startup-failure");
      throw error;
    }
  }

  private performStop(reason: RuntimeStopReason): Promise<BridgeRuntimeShutdownOutcome> {
    const d = this.dependencies;
    if (!this.leaseAcquired) { d.store.close(); return Promise.resolve({ outcome: "completed", unsettledWriters: [] }); }
    if (!this.writeFenceActive) { d.lease.release(); d.store.close(); return Promise.resolve({ outcome: "completed", unsettledWriters: [] }); }
    const shutdown = new BridgeRuntimeShutdown({
      cleanupEntries: this.lifecycle.shutdownPlan(),
      lease: d.lease,
      store: d.store,
      logger: d.logger
    });
    return shutdown.shutdown(reason);
  }

  private assertStarting(): void {
    if (this.stopPromise) throw new Error("Bridge runtime startup interrupted by shutdown");
  }

  private registerCleanup(name: string, stage: LifecycleCleanupEntry["stage"], kind: LifecycleCleanupEntry["kind"], stop: LifecycleCleanupEntry["stop"]): void {
    this.lifecycle.register({ name, stage, kind, stop });
  }
}

export type { BridgeRuntimeShutdownOutcome } from "../runtime/shutdown.js";
