import type { SqliteStoreBundle } from "../../src/store/sqlite-store-bundle.js";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStoreKernel } from "./sqlite-store-kernel.js";
import { createOutboxTestDriver } from "./outbox-test-driver.js";
import { readSchemaMetadata, validateCurrentSchema, type SchemaMigrationResult } from "../../src/store/sqlite/schema-manifest.js";

export interface TestStoreBundle extends SqliteStoreBundle {
  /** Test setup/inspection driver. Workflows should receive a named capability above. */
  readonly driver: SqliteStoreKernel;
}

export function createTestStoreBundle(path = ":memory:"): TestStoreBundle {
  const clonePath = path === ":memory:" ? currentSchemaClonePath() : null;
  const driver = new SqliteStoreKernel(clonePath ?? path);
  if (clonePath) attachCloneCleanup(driver, clonePath);
  const modules = driver.capabilityModules();
  Object.assign(driver,
    createOutboxTestDriver(modules.outboxAdmin),
    bindMethods(modules.outbox, ["enqueueOutboundReply", "prepareOutboundGatewayPlan", "getActiveAnswerPage", "getAnswerPage", "getLarkDeliveryCooldown", "getPrompt", "loadRunCard", "recoverEligibleDeadLetters", "recordBridgeMessage", "dismissSupersededAnswerStream", "loadWorkerTurnCard", "loadWorkerMainView", "listWorkerTurnCardPages"]),
    bindMethods(modules.outboxAdmin, ["listPendingOutboundReplies", "hasPendingOutboundReplyForWorkerTurn", "getOutboundReply", "markOutboundReplyFailed", "markOutboundReplyDeadLetter", "reservePaneThreadAlias"])
  );
  return {
    ...createCapabilities(driver, modules),
    driver
  };
}

/**
 * Ordinary tests start from a verified canonical database copied once per
 * Vitest worker. Compatibility tests deliberately construct their own raw
 * SqliteContext, so they continue to exercise the ordered migration route.
 */
export function createCurrentSchemaTestStoreBundle(): TestStoreBundle & { schemaMigration: SchemaMigrationResult } {
  const clonePath = currentSchemaClonePath();
  const driver = new SqliteStoreKernel(clonePath);
  attachCloneCleanup(driver, clonePath);
  const metadata = readSchemaMetadata(driver.database);
  const fingerprint = validateCurrentSchema(driver.database, metadata);
  return Object.assign(createBundle(driver), {
    schemaMigration: {
      route: "current-fast" as const,
      compatibilityStepCount: 0,
      epoch: metadata.epoch,
      fingerprint
    }
  });
}

function attachCloneCleanup(driver: SqliteStoreKernel, clonePath: string): void {
  const close = driver.close.bind(driver);
  let closed = false;
  driver.close = () => {
    if (closed) return;
    closed = true;
    try { close(); } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${clonePath}${suffix}`, { force: true });
    }
  };
}

function createBundle(driver: SqliteStoreKernel): TestStoreBundle {
  const modules = driver.capabilityModules();
  Object.assign(driver,
    createOutboxTestDriver(modules.outboxAdmin),
    bindMethods(modules.outbox, ["enqueueOutboundReply", "prepareOutboundGatewayPlan", "getActiveAnswerPage", "getAnswerPage", "getLarkDeliveryCooldown", "getPrompt", "loadRunCard", "recoverEligibleDeadLetters", "recordBridgeMessage", "dismissSupersededAnswerStream", "loadWorkerTurnCard", "loadWorkerMainView", "listWorkerTurnCardPages"]),
    bindMethods(modules.outboxAdmin, ["listPendingOutboundReplies", "hasPendingOutboundReplyForWorkerTurn", "getOutboundReply", "markOutboundReplyFailed", "markOutboundReplyDeadLetter", "reservePaneThreadAlias"])
  );
  return { ...createCapabilities(driver, modules), driver };
}

let baselinePath: string | undefined;
let cloneCounter = 0;
const fixtureWorkerDirectory = join(
  tmpdir(),
  "herdr-agent-swarm-vitest",
  `${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.pid}-${randomUUID()}`
);

function currentSchemaClonePath(): string {
  mkdirSync(fixtureWorkerDirectory, { recursive: true });
  baselinePath ??= join(fixtureWorkerDirectory, "canonical-baseline-v3.sqlite");
  if (!existsSync(baselinePath)) {
    const baseline = new SqliteStoreKernel(baselinePath);
    const metadata = readSchemaMetadata(baseline.database);
    validateCurrentSchema(baseline.database, metadata);
    // A raw database-file clone is safe only after its WAL is folded into the
    // baseline. The baseline is closed before any clone is copied.
    baseline.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    baseline.close();
  }
  const clonePath = join(fixtureWorkerDirectory, `fixture-${cloneCounter++}.sqlite`);
  copyFileSync(baselinePath, clonePath);
  return clonePath;
}

function createCapabilities(store: SqliteStoreKernel, modules = store.capabilityModules()): SqliteStoreBundle {
  return {
    lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, coreEvents: modules.coreEvents, turnSnapshots: modules.turnSnapshots, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: store,
    promptAcceptance: store, promptDispatch: store, promptRecovery: store, promptSession: store, outboundIntent: modules.outbox, outbox: modules.outbox,
    answerPages: store, primaryCardRedelivery: modules.primaryCardRedelivery, mainCards: store, projection: store,
    queueFeedback: store, cardContext: modules.cardContext, bindingProvisioning: store,
    runtimeReconciliation: store, retiredPaneCleanup: store, paneControl: store, paneTopology: modules.paneTopology,
    paneClose: store, inboundRouting: store, inboundDispatch: modules.inboundDispatch, operationsQuery: modules.operationsQuery,
    deliveryRecovery: store, cardInteraction: store, externalTurns: store,
    sessionOperations: modules.sessionOperations, modelSelection: store, sessionAdministration: store,
    paneRetention: store, commandIntents: modules.commandIntents, agentInputs: modules.agentInputs,
    startupRecovery: store, startupViews: store, retention: modules.retention, workerCardDisplay: modules.workerCardDisplay, workerSessionThreads: modules.workerSessionThreads, orchestratorClear: modules.orchestratorClear, orchestratorIdentity: modules.orchestratorIdentity, legacyInputCards: modules.legacyInputCards, cardDismissals: modules.cardDismissals, preparedDeliveries: modules.preparedDeliveries, preparedDeliveryProducers: modules.preparedDeliveryProducers
  };
}

function bindMethods<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, (target[key] as Function).bind(target)])) as Pick<T, K>;
}
