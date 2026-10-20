import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { startHealthServer, type HealthServer } from "../health/server.js";
import { ExecFileCommandRunner } from "../infra/command-runner.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import { detectAgentRuntimeAvailabilities } from "../runtime/agents/agent-availability.js";
import { InstanceLeaseController } from "../runtime/instance-lease.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import { RuntimeLifecycleLedger, type LifecycleCleanupEntry } from "../runtime/lifecycle-ledger.js";
import { BridgeRuntimeShutdown, type BridgeRuntimeShutdownOutcome } from "../runtime/shutdown.js";
import { openSqliteLeaseBootstrap } from "../store/sqlite-lease-bootstrap.js";
import { classifySqliteFailure } from "../store/sqlite-store-bundle.js";
import { createBridgeRuntime } from "./create-bridge-runtime.js";
import type { NaturalLanguageCommandRuntime } from "../runtime/natural-language-command-runtime.js";
import { createFeishuGatewayPrimaryPresentation, feishuGatewayWorkerPresentation } from "../gateways/feishu/presentation.js";
import type { AgentInputCapabilityStatus } from "../runtime/agent-input-capability.js";
import type { StaleDeliveryClaimBatchResult, StaleDeliveryClaimCursor } from "../store/sqlite-store-bundle.js";

export type RuntimeStopReason = "SIGINT" | "SIGTERM" | "lease-lost" | "startup-failure";

interface LifecycleLogger {
  info(value: object, message: string): void;
  warn?(value: object, message: string): void;
  error(value: object, message: string): void;
}

export interface ManagedBridgeRuntimeDependencies {
  reconcileIntervalMs: number;
  store: {
    activateWriteFence(ownerId: string, fencingToken: number): void;
    recoverPriorOwnerClaimsBatch?(ownerId: string, fencingToken: number, after: StaleDeliveryClaimCursor | null, limit?: number, occurredAt?: string): StaleDeliveryClaimBatchResult;
    deactivateWriteFence(): void;
    close(): void;
  };
  lease: { acquire(): void; writeFence(): { ownerId: string; fencingToken: number }; start(onLost: () => void | Promise<void>): void; renewNow?(): Promise<boolean>; release(): void };
  primaryToolGateway: { start(): Promise<void>; stop(): Promise<void> };
  completionChoiceEligibilityGateway: { start(): Promise<void>; stop(): Promise<void> };
  naturalLanguageCommands: NaturalLanguageCommandRuntime;
  sqliteIntegrity: { start(): void; run(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  agentInput?: { detect(): Promise<AgentInputCapabilityStatus>; migrate(): Promise<unknown> | unknown; recover(): Promise<unknown>; stop?(): Promise<void> };
  instanceRuntime: { reconcile(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  instanceTurns: { prepareRecovery(): void; reconcile(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  herdrSnapshotCache: { withStartupSnapshotReuse<T>(operation: () => Promise<T>): Promise<T> };
  instanceWork: { stop(context?: ShutdownContext): Promise<void> };
  turnControlDispatcher: { recover(): Promise<unknown>; stop(context?: ShutdownContext): Promise<void> };
  runtimeEvents: { stop(): Promise<void> };
  createHealthServer(): Promise<HealthServer>;
  ringDeliveryEngine: { start(): void; whenRecoveryReady(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  outboxRetention: { start(): void; stop(): Promise<void> };
  projector: { start(): unknown; stop(context?: ShutdownContext): Promise<void> };
  recoverySupervisor?: { start(intervalMs: number): void; repairDeliveryBeforePublisher(): Promise<void>; scan(): Promise<void>; stop(): Promise<void> };
  cardContextRebuilder: { start(intervalMs: number): void; stop(context?: ShutdownContext): Promise<void> };
  coordinator: { prepareDelivery(): Promise<void>; recoverRuntime(): Promise<void>; start(): Promise<void>; stop(context?: ShutdownContext): Promise<void> };
  paneRetention: { scan(): Promise<void>; start(intervalMs: number): void; stop(): Promise<void> };
  externalTurns: { start(): void; stop(): Promise<void> };
  coreSessionIngestion?: { reconcile(): Promise<void>; start(): void; stop(): Promise<void> };
  herdrSessionEventSubscriber?: { start(): void; stop(): Promise<void> };
  herdrSocketSubscriber?: { startEvents(): void; stopIngress(): void; drainEvents(context?: ShutdownContext): Promise<void> };
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
  const primaryPresentation = createFeishuGatewayPrimaryPresentation(config.runtimeTuning.cards);
  const bootstrap = openSqliteLeaseBootstrap(config.databasePath, {
    busyTimeoutMs: config.sqlite.busyTimeoutMs,
    slowTransactionThresholdMs: config.sqlite.slowTransactionThresholdMs,
    onTransactionDiagnostic(diagnostic) {
      logger.warn({ event: "sqlite-transaction-diagnostic", ...diagnostic }, "SQLite transaction completed with an operational diagnostic");
    }
  });
  const lease = new InstanceLeaseController(bootstrap.lease, {
    ...config.instanceLease,
    sqliteBusyTimeoutMs: config.sqlite.busyTimeoutMs,
    sqliteBusyRetryBudgetMs: config.sqlite.busyRetryBudgetMs,
    classifySqliteFailure
  }, logger);
  let stores: ReturnType<typeof bootstrap.complete> | null = null;
  let leaseAcquired = false;
  try {
    lease.acquire();
    leaseAcquired = true;
    const completedStores = bootstrap.complete(lease.writeFence());
    stores = completedStores;
    if (!await lease.renewNow()) throw new Error("Bridge database lease expired during schema migration");
    const availabilityResult = await availabilityPromise;
    if ("error" in availabilityResult) throw availabilityResult.error;
    if (!await lease.renewNow()) throw new Error("Bridge database lease expired during Agent capability detection");
    const { codex, claude, pi } = availabilityResult.availability;
    const runtime = createBridgeRuntime(config, completedStores, logger, { codex, claude, pi }, buildIdentity);
    return new ManagedBridgeRuntime({
      reconcileIntervalMs: config.reconcileIntervalMs,
      store: completedStores.lifecycle,
      lease,
      ...runtime.lifecycle,
      createHealthServer: () => startHealthServer({
        ...config.http, store: completedStores.health, gateway: runtime.operations.gateway,
        projects: config.projects, lease, buildIdentity, ...runtime.health
      }),
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
      if (d.store.recoverPriorOwnerClaimsBatch) {
        let cursor: StaleDeliveryClaimCursor | null = null;
        let hasMore = true;
        while (hasMore) {
          this.assertStarting();
          if (d.lease.renewNow && !await d.lease.renewNow()) throw new Error("Bridge database lease expired during stale delivery claim recovery");
          const page = d.store.recoverPriorOwnerClaimsBatch(writeFence.ownerId, writeFence.fencingToken, cursor);
          cursor = page.next;
          hasMore = page.hasMore;
          if (hasMore) await yieldToEventLoop();
        }
      }
      this.assertStarting();
      d.instanceTurns.prepareRecovery();
      this.lifecycle.startRuntime({ name: "integrityAuditor", stage: "workers", kind: "non-writer" }, d.sqliteIntegrity);
      void d.sqliteIntegrity.run();
      this.assertStarting();
      if (d.agentInput) {
        if (d.agentInput.stop) this.registerCleanup("agentInputRecovery", "workers", "writer", () => d.agentInput!.stop!());
        const capability = await d.agentInput.detect();
        this.assertStarting();
        if (capability.supported) {
          await d.agentInput.migrate();
          this.assertStarting();
          await d.agentInput.recover();
        }
        this.assertStarting();
      }
      this.registerCleanup("coordinator", "workers", "writer", (context) => d.coordinator.stop(context));
      this.registerCleanup("instanceWork", "workers", "writer", (context) => d.instanceWork.stop(context));
      this.registerCleanup("runtimeEvents", "workers", "non-writer", () => d.runtimeEvents.stop());
      this.registerCleanup("turnControlDispatcher", "workers", "writer", (context) => d.turnControlDispatcher.stop(context));
      await d.coordinator.prepareDelivery();
      this.assertStarting();
      await d.herdrSnapshotCache.withStartupSnapshotReuse(async () => {
        await d.instanceRuntime.reconcile();
        this.assertStarting();
        await d.instanceTurns.reconcile();
        this.assertStarting();
        await d.turnControlDispatcher.recover();
        this.assertStarting();
        await d.coordinator.recoverRuntime();
      });
      this.assertStarting();
      let ingressStarts: Promise<PromiseSettledResult<void>[]> | null = null;
      this.registerCleanup("primaryToolGateway", "ingress", "writer", async () => { await ingressStarts; await d.primaryToolGateway.stop(); });
      this.registerCleanup("completionChoiceEligibilityGateway", "ingress", "writer", async () => { await ingressStarts; await d.completionChoiceEligibilityGateway.stop(); });
      this.registerCleanup("naturalLanguageCommands", "ingress", "writer", async () => { await ingressStarts; await d.naturalLanguageCommands.stop(); });
      ingressStarts = Promise.allSettled([
        Promise.resolve().then(() => d.primaryToolGateway.start()),
        Promise.resolve().then(() => d.completionChoiceEligibilityGateway.start()),
        Promise.resolve().then(() => d.naturalLanguageCommands.start())
      ]);
      const ingressResults = await ingressStarts;
      const ingressFailure = ingressResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (ingressFailure) throw ingressFailure.reason;
      this.assertStarting();
      await this.lifecycle.startResource({
        name: "healthServer", stage: "health", kind: "non-writer",
        start: () => d.createHealthServer(), stop: (server, context) => server.stop(context)
      });
      this.assertStarting();
      if (d.recoverySupervisor) {
        await d.recoverySupervisor.repairDeliveryBeforePublisher();
        this.assertStarting();
      }
      this.registerCleanup("ringDeliveryEngine", "projections", "writer", (context) => d.ringDeliveryEngine.stop(context));
      d.ringDeliveryEngine.start();
      await d.ringDeliveryEngine.whenRecoveryReady();
      this.assertStarting();
      this.lifecycle.startRuntime({ name: "outboxRetention", stage: "projections", kind: "writer" }, d.outboxRetention);
      this.lifecycle.startRuntime({ name: "projector", stage: "projections", kind: "writer" }, d.projector);
      this.lifecycle.startRuntime({ name: "cardContextRebuilder", stage: "projections", kind: "writer" }, d.cardContextRebuilder, d.reconcileIntervalMs);
      await d.coordinator.start();
      this.assertStarting();
      if (d.recoverySupervisor) {
        this.lifecycle.startRuntime({ name: "recoverySupervisor", stage: "observers", kind: "writer" }, d.recoverySupervisor, d.reconcileIntervalMs);
        await d.recoverySupervisor.scan();
        this.assertStarting();
      }
      await d.paneRetention.scan();
      this.assertStarting();
      this.lifecycle.startRuntime({ name: "paneRetention", stage: "observers", kind: "writer" }, d.paneRetention, d.reconcileIntervalMs);
      this.lifecycle.startRuntime({ name: "externalTurns", stage: "observers", kind: "writer" }, d.externalTurns);
      if (d.coreSessionIngestion) {
        if (d.herdrSessionEventSubscriber) {
          this.lifecycle.startRuntime({ name: "herdrSessionEventSubscriber", stage: "ingress", kind: "non-writer" }, d.herdrSessionEventSubscriber);
        }
        await d.coreSessionIngestion.reconcile();
        this.assertStarting();
        this.lifecycle.startRuntime({ name: "coreSessionIngestion", stage: "observers", kind: "writer" }, d.coreSessionIngestion);
      }
      this.lifecycle.startRuntime({ name: "instanceRuntime", stage: "workers", kind: "writer" }, d.instanceRuntime, d.reconcileIntervalMs);
      this.lifecycle.startRuntime({ name: "instanceTurns", stage: "workers", kind: "writer" }, d.instanceTurns, d.reconcileIntervalMs);
      if (d.herdrSocketSubscriber) {
        // Ingress-stage cleanup runs in reverse registration order: close admission before awaiting its writer drain.
        this.registerCleanup("herdrSocketEventDrain", "ingress", "writer", (context) => d.herdrSocketSubscriber!.drainEvents(context));
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export type { BridgeRuntimeShutdownOutcome } from "../runtime/shutdown.js";
