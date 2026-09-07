import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { startHealthServer } from "../health/server.js";
import { ExecFileCommandRunner } from "../infra/command-runner.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import { detectAgentRuntimeAvailability } from "../runtime/agents/agent-availability.js";
import { InstanceLeaseController } from "../runtime/instance-lease.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import { BridgeRuntimeShutdown, type BridgeRuntimeShutdownOutcome } from "../runtime/shutdown.js";
import { createSqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import { createBridgeRuntime } from "./create-bridge-runtime.js";

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
  sqliteIntegrity: { start(): void; run(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  instanceRuntime: { reconcile(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  instanceTurns: { prepareRecovery(): void; reconcile(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  instanceWork: { stop(context?: ShutdownContext): Promise<void> };
  createHealthServer(): Promise<HealthServer>;
  channelPublisher: { start(): void; stop(context?: ShutdownContext): Promise<void> };
  outboxRetention: { start(): void; stop(): Promise<void> };
  projector: { start(): unknown; stop(context?: ShutdownContext): Promise<void> };
  cardContextRebuilder: { start(intervalMs: number): void; stop(context?: ShutdownContext): Promise<void> };
  queueFeedbackProjector: { start(bus: unknown): void; converge(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  bus: unknown;
  coordinator: { start(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  paneRetention: { scan(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  externalTurns: { start(): void; stop(): Promise<void> };
  herdrSocketSubscriber?: { startEvents(): void; stop(): Promise<void> };
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
  const [codex, claude, pi] = await Promise.all([
    detectAgentRuntimeAvailability({ runner: availabilityRunner, herdrExecutable: config.herdr.executable, agentExecutable: config.agents.codex, herdrKind: "codex" }),
    detectAgentRuntimeAvailability({ runner: availabilityRunner, herdrExecutable: config.herdr.executable, agentExecutable: config.agents.claudeCode, herdrKind: "claude" }),
    detectAgentRuntimeAvailability({ runner: availabilityRunner, herdrExecutable: config.herdr.executable, agentExecutable: config.agents.pi, herdrKind: "pi" })
  ]);
  const stores = createSqliteStoreBundle(config.databasePath);
  try {
    const lease = new InstanceLeaseController(stores.lease, config.instanceLease, logger);
    const runtime = createBridgeRuntime(config, stores, logger, { codex, claude, pi });
    const { herdr, herdrCircuitBreaker, herdrSocketSubscriber, instanceRuntime, instanceTurns, instanceWork, primaryToolGateway, sqliteIntegrity, coordinator, queueFeedbackProjector, cardContextRebuilder, projector, channelPublisher, outboxRetention, paneRetention, externalTurns, instanceWorker, lark, bus, sessionOperations, reconciler, promptRun } = runtime;
    return new ManagedBridgeRuntime({
      reconcileIntervalMs: config.reconcileIntervalMs,
      store: stores.lifecycle,
      lease,
      primaryToolGateway,
      sqliteIntegrity,
      instanceRuntime,
      instanceTurns,
      instanceWork,
      createHealthServer: () => startHealthServer({
        ...config.http, store: stores.health, herdr, lark, projects: config.projects, lease,
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
    });
  } catch (error) {
    stores.lifecycle.close();
    throw error;
  }
}

export class ManagedBridgeRuntime implements ManagedBridgeRuntimePort {
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<BridgeRuntimeShutdownOutcome> | null = null;
  private healthServer: HealthServer | null = null;
  private leaseAcquired = false;
  private writeFenceActive = false;
  private primaryToolGatewayStarted = false;
  private sqliteIntegrityStarted = false;
  private publisherStarted = false;
  private outboxRetentionStarted = false;
  private projectorStarted = false;
  private cardContextStarted = false;
  private queueFeedbackStarted = false;
  private coordinatorStarted = false;
  private paneRetentionStarted = false;
  private externalTurnsStarted = false;
  private instanceRuntimeStarted = false;
  private instanceTurnsStarted = false;
  private socketStarted = false;

  constructor(private readonly dependencies: ManagedBridgeRuntimeDependencies) {}

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
      d.lease.acquire();
      this.leaseAcquired = true;
      const writeFence = d.lease.writeFence();
      d.store.activateWriteFence(writeFence.ownerId, writeFence.fencingToken);
      this.writeFenceActive = true;
      d.lease.start(async () => {
        const result = await this.stop("lease-lost");
        await d.onFatalStop?.("lease-lost", result);
      });
      d.instanceTurns.prepareRecovery();
      this.primaryToolGatewayStarted = true;
      await d.primaryToolGateway.start();
      this.assertStarting();
      this.sqliteIntegrityStarted = true;
      d.sqliteIntegrity.start();
      await d.sqliteIntegrity.run();
      this.assertStarting();
      await d.instanceRuntime.reconcile();
      this.assertStarting();
      await d.instanceTurns.reconcile();
      this.assertStarting();
      this.healthServer = await d.createHealthServer();
      this.assertStarting();
      this.publisherStarted = true;
      d.channelPublisher.start();
      this.outboxRetentionStarted = true;
      d.outboxRetention.start();
      this.projectorStarted = true;
      d.projector.start();
      this.cardContextStarted = true;
      d.cardContextRebuilder.start(d.reconcileIntervalMs);
      this.queueFeedbackStarted = true;
      d.queueFeedbackProjector.start(d.bus);
      await d.queueFeedbackProjector.converge();
      this.assertStarting();
      this.coordinatorStarted = true;
      await d.coordinator.start();
      this.assertStarting();
      await d.paneRetention.scan();
      this.assertStarting();
      this.paneRetentionStarted = true;
      d.paneRetention.start(d.reconcileIntervalMs);
      this.externalTurnsStarted = true;
      d.externalTurns.start();
      this.instanceRuntimeStarted = true;
      d.instanceRuntime.start(d.reconcileIntervalMs);
      this.instanceTurnsStarted = true;
      d.instanceTurns.start(d.reconcileIntervalMs);
      if (d.herdrSocketSubscriber) {
        this.socketStarted = true;
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
    const instanceTurnsStarted = this.instanceTurnsStarted;
    const instanceWorkStarted = this.coordinatorStarted;
    const shutdown = new BridgeRuntimeShutdown({
      ...(this.primaryToolGatewayStarted ? { primaryToolGateway: d.primaryToolGateway } : {}),
      ...(this.socketStarted && d.herdrSocketSubscriber ? { herdrSocketSubscriber: d.herdrSocketSubscriber } : {}),
      ...(this.paneRetentionStarted ? { paneRetention: d.paneRetention } : {}),
      ...(this.externalTurnsStarted ? { externalTurns: d.externalTurns } : {}),
      ...(this.instanceRuntimeStarted ? { instanceRuntime: d.instanceRuntime } : {}),
      ...(instanceTurnsStarted || instanceWorkStarted ? { instanceWorker: { async stop(context?: ShutdownContext) { await Promise.all([...(instanceTurnsStarted ? [d.instanceTurns.stop()] : []), ...(instanceWorkStarted ? [d.instanceWork.stop(context)] : [])]); } } } : {}),
      ...(this.sqliteIntegrityStarted ? { integrityAuditor: d.sqliteIntegrity } : {}),
      ...(this.coordinatorStarted ? { coordinator: d.coordinator } : {}),
      ...(this.outboxRetentionStarted ? { outboxRetention: d.outboxRetention } : {}),
      ...(this.queueFeedbackStarted ? { queueFeedbackProjector: d.queueFeedbackProjector } : {}),
      ...(this.cardContextStarted ? { cardContextRebuilder: d.cardContextRebuilder } : {}),
      ...(this.projectorStarted ? { projector: d.projector } : {}),
      ...(this.publisherStarted ? { publisher: d.channelPublisher } : {}),
      ...(this.healthServer ? { healthServer: this.healthServer } : {}),
      lease: d.lease,
      store: d.store,
      logger: d.logger
    });
    return shutdown.shutdown(reason);
  }

  private assertStarting(): void {
    if (this.stopPromise) throw new Error("Bridge runtime startup interrupted by shutdown");
  }
}

export type { BridgeRuntimeShutdownOutcome } from "../runtime/shutdown.js";
