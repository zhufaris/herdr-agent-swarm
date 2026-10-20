import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSqliteMaintenanceCommand, runSqliteMaintenanceCycle, type SqliteMaintenanceDependencies } from "../src/cli/sqlite-maintenance-cycle.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("SQLite maintenance cycle", () => {
  it("exposes a canonical operator command with bounded arguments", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const result = await runSqliteMaintenanceCommand(["--deadline-ms", "60000"], {
      ...process.env,
      SWARM_STATE_DIR: fixture.stateDirectory,
      BRIDGE_DATABASE_PATH: fixture.databasePath
    }, createDependencies(calls));

    expect(result.outcome).toBe("completed");
    expect(calls).toContain("stop-service");
    await expect(runSqliteMaintenanceCommand(["--deadline-ms", "900001"], {
      ...process.env,
      SWARM_STATE_DIR: fixture.stateDirectory,
      BRIDGE_DATABASE_PATH: fixture.databasePath
    }, createDependencies([]))).rejects.toThrow(/deadline/i);
    await expect(runSqliteMaintenanceCommand(["--unknown"], process.env, createDependencies([]))).rejects.toThrow(/usage/i);
  });

  it("refuses permissive or symlinked database paths before stopping admission", async () => {
    const permissive = createFixture();
    chmodSync(permissive.databasePath, 0o640);
    const permissiveCalls: string[] = [];
    await expect(runSqliteMaintenanceCycle({
      databasePath: permissive.databasePath, stateDirectory: permissive.stateDirectory,
      serviceName: "herdr-agent-swarm.service"
    }, createDependencies(permissiveCalls))).rejects.toThrow(/0600/);
    expect(statSync(permissive.databasePath).mode & 0o777).toBe(0o640);
    expect(permissiveCalls).toEqual([]);

    const linked = createFixture();
    const target = `${linked.databasePath}.real`;
    copyFileSync(linked.databasePath, target);
    const linkPath = `${linked.databasePath}.link`;
    symlinkSync(target, linkPath);
    const linkedCalls: string[] = [];
    await expect(runSqliteMaintenanceCycle({
      databasePath: linkPath, stateDirectory: linked.stateDirectory,
      serviceName: "herdr-agent-swarm.service"
    }, createDependencies(linkedCalls))).rejects.toThrow(/symlink|regular file/i);
    expect(linkedCalls).toEqual([]);
  });

  it("uses real SQLite backup, vacuum, and integrity validation adapters", async () => {
    const valid = createCurrentDatabaseFixture();
    const result = await runSqliteMaintenanceCycle({
      databasePath: valid.databasePath,
      stateDirectory: valid.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, operationalOverrides("real-adapters-valid"));

    expect(result.outcome).toBe("completed");
    expect(result.validations).toEqual([
      expect.objectContaining({ path: result.backup.path, quickCheck: "ok", foreignKeyIssues: 0, semanticIssues: 0, schemaValid: true }),
      expect.objectContaining({ path: result.candidate.path, quickCheck: "ok", foreignKeyIssues: 0, semanticIssues: 0, schemaValid: true })
    ]);

    const corrupt = createCurrentDatabaseFixture();
    await expect(runSqliteMaintenanceCycle({
      databasePath: corrupt.databasePath,
      stateDirectory: corrupt.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, {
      ...operationalOverrides("real-adapters-corrupt"),
      vacuumInto: async (_source, destination) => { writeFileSync(destination, "not a SQLite database", { mode: 0o600 }); }
    })).rejects.toThrow(/rolled back.*candidate database validation failed/);
    expect(existsSync(`${corrupt.databasePath}.maintenance-real-adapters-corrupt.original`)).toBe(false);
  });

  it("proves service lease release and fences the default retention drain", async () => {
    const fixture = createCurrentDatabaseFixture();
    const result = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath,
      stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, lifecycleOverrides("real-retention"));

    const active = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect((active.prepare("SELECT COUNT(*) AS count FROM retention_compaction_cursors").get() as { count: number }).count).toBe(4);
    expect((active.prepare("SELECT COUNT(*) AS count FROM instance_lease").get() as { count: number }).count).toBe(0);
    active.close();
    expect(result.retention).toEqual({ compacted: 0, refusals: {} });

    const leased = createCurrentDatabaseFixture();
    const lease = new DatabaseSync(leased.databasePath);
    lease.prepare(`INSERT INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,expires_at_ms,updated_at)
      VALUES(1,'live-service',7,?,?,?)`).run("2099-01-01T00:00:00.000Z", Date.parse("2099-01-01T00:00:00.000Z"), "2026-10-09T12:00:00.000Z");
    lease.close();
    await expect(runSqliteMaintenanceCycle({
      databasePath: leased.databasePath,
      stateDirectory: leased.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, lifecycleOverrides("live-lease"))).rejects.toThrow(/rolled back.*lease/i);
    expect(existsSync(`${leased.databasePath}.maintenance-live-lease.backup`)).toBe(false);
  });

  it("does not restart retention cycles that were already completely drained", async () => {
    const fixture = createCurrentDatabaseFixture();
    await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath,
      stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, lifecycleOverrides("completed-retention-first"));

    const beforeDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true });
    const before = beforeDatabase.prepare(`SELECT source_kind,cycle_started_at,updated_at
      FROM retention_compaction_cursors ORDER BY source_kind`).all();
    beforeDatabase.close();
    let later = Date.now() + 24 * 60 * 60_000;

    await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath,
      stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, { ...lifecycleOverrides("completed-retention-second"), now: () => later++ });

    const afterDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true });
    const after = afterDatabase.prepare(`SELECT source_kind,cycle_started_at,updated_at
      FROM retention_compaction_cursors ORDER BY source_kind`).all();
    afterDatabase.close();
    expect(after).toEqual(before);
  });

  it("activates only a validated candidate and preserves backup and original", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const dependencies = createDependencies(calls);

    const result = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath,
      stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service",
      deadlineMs: 60_000
    }, dependencies);

    expect(result.outcome).toBe("completed");
    expect(result.completedPhase).toBe("smoke_passed");
    expect(result.activated).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(readFileSync(fixture.databasePath, "utf8")).toBe("vacuumed source");
    expect(readFileSync(result.backup.path, "utf8")).toBe("source");
    expect(readFileSync(result.original.path, "utf8")).toBe("source");
    expect(statSync(fixture.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(result.backup.path).mode & 0o777).toBe(0o600);
    expect(statSync(result.original.path).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([
      "stop-admission", "stop-service", "prove-lease-release", "backup", "validate:backup",
      "drain-retention", "vacuum", "validate:candidate", "start-service", "smoke"
    ]);
    expect(existsSync(join(fixture.stateDirectory, "sqlite-maintenance", `${result.cycleId}.json`))).toBe(true);
  });

  it("preserves the active database and backup when candidate validation fails", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.validateDatabase = (path, role) => {
      calls.push(`validate:${role}`);
      return { path, quickCheck: role === "candidate" ? "failed" : "ok", foreignKeyIssues: 0, semanticIssues: 0, schemaValid: true };
    };

    await expect(runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, dependencies)).rejects.toThrow(/rolled back.*candidate database validation failed/);

    expect(readFileSync(fixture.databasePath, "utf8")).toBe("source");
    expect(existsSync(`${fixture.databasePath}.maintenance-cycle-1.backup`)).toBe(true);
    expect(existsSync(`${fixture.databasePath}.maintenance-cycle-1.original`)).toBe(false);
    expect(calls.at(-1)).toBe("start-service");
  });

  it("stops at the deadline after a long phase and preserves the active database", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    let now = Date.parse("2026-10-09T12:00:00.000Z");
    const dependencies = createDependencies(calls);
    dependencies.now = () => now;
    dependencies.backupDatabase = async (source, destination) => {
      calls.push("backup");
      copyFileSync(source, destination);
      now += 20;
    };

    await expect(runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 10
    }, dependencies)).rejects.toThrow(/rolled back.*deadline exhausted/);

    expect(readFileSync(fixture.databasePath, "utf8")).toBe("source");
    expect(calls).not.toContain("validate:backup");
    expect(calls.at(-1)).toBe("start-service");
  });

  it("restores the byte-identical original when post-activation smoke fails", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.smoke = async () => { calls.push("smoke"); return { health: "ok", readiness: "not_ready", status: "degraded" }; };

    await expect(runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, dependencies)).rejects.toThrow(/rolled back.*smoke check failed/);

    expect(readFileSync(fixture.databasePath, "utf8")).toBe("source");
    expect(readFileSync(`${fixture.databasePath}.maintenance-cycle-1.backup`, "utf8")).toBe("source");
    expect(readFileSync(`${fixture.databasePath}.maintenance-cycle-1.failed`, "utf8")).toBe("vacuumed source");
    expect(calls.filter((call) => call === "stop-service")).toHaveLength(2);
    expect(calls.filter((call) => call === "start-service")).toHaveLength(2);
  });

  it("stops a service that became active before startup observation failed", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    let startAttempts = 0;
    dependencies.startService = async () => {
      calls.push("start-service");
      startAttempts += 1;
      if (startAttempts === 1) throw new Error("startup observation timed out after systemd accepted start");
    };

    await expect(runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, dependencies)).rejects.toThrow(/rolled back.*startup observation timed out/);

    expect(readFileSync(fixture.databasePath, "utf8")).toBe("source");
    expect(readFileSync(`${fixture.databasePath}.maintenance-cycle-1.failed`, "utf8")).toBe("vacuumed source");
    expect(calls.filter((call) => call === "stop-service")).toHaveLength(2);
    expect(calls.filter((call) => call === "start-service")).toHaveLength(2);
  });

  it("moves SQLite sidecars with the original and restores them on rollback", async () => {
    const successful = createFixture();
    const successDependencies = createDependencies([]);
    successDependencies.vacuumInto = async (_source, destination) => {
      writeFileSync(destination, "vacuumed source", { mode: 0o600 });
      writeFileSync(`${successful.databasePath}-wal`, "original wal", { mode: 0o600 });
      writeFileSync(`${successful.databasePath}-shm`, "original shm", { mode: 0o600 });
    };
    const success = await runSqliteMaintenanceCycle({
      databasePath: successful.databasePath, stateDirectory: successful.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, successDependencies);

    expect(existsSync(`${successful.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${successful.databasePath}-shm`)).toBe(false);
    expect(readFileSync(`${success.original.path}-wal`, "utf8")).toBe("original wal");
    expect(readFileSync(`${success.original.path}-shm`, "utf8")).toBe("original shm");

    const rolledBack = createFixture();
    const rollbackDependencies = createDependencies([]);
    rollbackDependencies.vacuumInto = async (_source, destination) => {
      writeFileSync(destination, "vacuumed source", { mode: 0o600 });
      writeFileSync(`${rolledBack.databasePath}-wal`, "rollback wal", { mode: 0o600 });
      writeFileSync(`${rolledBack.databasePath}-shm`, "rollback shm", { mode: 0o600 });
    };
    rollbackDependencies.smoke = async () => ({ health: "ok", readiness: "not_ready", status: "degraded" });
    await expect(runSqliteMaintenanceCycle({
      databasePath: rolledBack.databasePath, stateDirectory: rolledBack.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, rollbackDependencies)).rejects.toThrow(/rolled back.*smoke check failed/);

    expect(readFileSync(`${rolledBack.databasePath}-wal`, "utf8")).toBe("rollback wal");
    expect(readFileSync(`${rolledBack.databasePath}-shm`, "utf8")).toBe("rollback shm");
    expect(existsSync(`${rolledBack.databasePath}.maintenance-cycle-1.original-wal`)).toBe(false);
    expect(existsSync(`${rolledBack.databasePath}.maintenance-cycle-1.original-shm`)).toBe(false);
  });

  it("reconciles an activated filesystem when the journal stopped at candidate validation", async () => {
    const fixture = createFixture();
    const firstCalls: string[] = [];
    const first = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, createDependencies(firstCalls));
    const journalPath = join(fixture.stateDirectory, "sqlite-maintenance", `${first.cycleId}.json`);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    journal.outcome = "running";
    journal.completedPhase = "candidate_validated";
    journal.activated = false;
    journal.smoke = null;
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const resumeCalls: string[] = [];

    const resumed = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000, resumeCycleId: first.cycleId
    }, createDependencies(resumeCalls));

    expect(resumed.outcome).toBe("completed");
    expect(resumeCalls).toEqual(["start-service", "smoke"]);
    expect(readFileSync(fixture.databasePath, "utf8")).toBe("vacuumed source");
  });

  it("restores the active path when activation stopped between the two renames", async () => {
    const fixture = createFixture();
    const completed = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, createDependencies([]));
    const journalPath = join(fixture.stateDirectory, "sqlite-maintenance", `${completed.cycleId}.json`);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    journal.outcome = "running";
    journal.completedPhase = "candidate_validated";
    journal.activated = false;
    journal.smoke = null;
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const candidatePath = `${fixture.databasePath}.maintenance-${completed.cycleId}.candidate`;
    renameSync(fixture.databasePath, candidatePath);
    const calls: string[] = [];

    const resumed = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000, resumeCycleId: completed.cycleId
    }, createDependencies(calls));

    expect(resumed.outcome).toBe("completed");
    expect(readFileSync(fixture.databasePath, "utf8")).toBe("vacuumed source");
    expect(calls).toEqual(["start-service", "smoke"]);
  });

  it("rejects a phase-inconsistent resume journal before lifecycle calls", async () => {
    const fixture = createFixture();
    const completed = await runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000
    }, createDependencies([]));
    const journalPath = join(fixture.stateDirectory, "sqlite-maintenance", `${completed.cycleId}.json`);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    journal.outcome = "running";
    journal.completedPhase = "candidate_validated";
    journal.activated = true;
    journal.backup = { ...(journal.backup as object), path: "/tmp/not-this-cycle.backup" };
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const calls: string[] = [];

    await expect(runSqliteMaintenanceCycle({
      databasePath: fixture.databasePath, stateDirectory: fixture.stateDirectory,
      serviceName: "herdr-agent-swarm.service", deadlineMs: 60_000, resumeCycleId: completed.cycleId
    }, createDependencies(calls))).rejects.toThrow(/journal.*invalid/i);
    expect(calls).toEqual([]);
  });
});

function createFixture(): { databasePath: string; stateDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-maintenance-"));
  const stateDirectory = join(root, "state");
  const databasePath = join(root, "bridge.db");
  writeFileSync(databasePath, "source", { mode: 0o600 });
  return { databasePath, stateDirectory };
}

function createCurrentDatabaseFixture(): { databasePath: string; stateDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-maintenance-real-"));
  const stateDirectory = join(root, "state");
  const databasePath = join(root, "bridge.db");
  const store = createTestStoreBundle(databasePath);
  store.driver.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.driver.close();
  chmodSync(databasePath, 0o600);
  return { databasePath, stateDirectory };
}

function operationalOverrides(cycleId: string): Partial<SqliteMaintenanceDependencies> {
  return {
    ...lifecycleOverrides(cycleId),
    proveLeaseReleased: () => {},
    drainRetention: async () => ({ compacted: 0, refusals: {} }),
  };
}

function lifecycleOverrides(cycleId: string): Partial<SqliteMaintenanceDependencies> {
  return {
    now: (() => { let value = Date.now(); return () => value++; })(),
    createCycleId: () => cycleId,
    stopAdmission: async () => {},
    stopService: async () => {},
    startService: async () => {},
    smoke: async () => ({ health: "ok", readiness: "ready", status: "ok" })
  };
}

function createDependencies(calls: string[]): SqliteMaintenanceDependencies {
  return {
    now: (() => { let value = Date.parse("2026-10-09T12:00:00.000Z"); return () => value++; })(),
    createCycleId: () => "cycle-1",
    stopAdmission: async () => { calls.push("stop-admission"); },
    stopService: async () => { calls.push("stop-service"); },
    proveLeaseReleased: () => { calls.push("prove-lease-release"); },
    backupDatabase: async (source, destination) => { calls.push("backup"); copyFileSync(source, destination); },
    drainRetention: async () => { calls.push("drain-retention"); return { compacted: 0, refusals: { retention_window_open: 1 } }; },
    vacuumInto: async (_source, destination) => { calls.push("vacuum"); writeFileSync(destination, "vacuumed source", { mode: 0o600 }); },
    validateDatabase: (path, role) => { calls.push(`validate:${role}`); return { path, quickCheck: "ok", foreignKeyIssues: 0, semanticIssues: 0, schemaValid: true }; },
    startService: async () => { calls.push("start-service"); },
    smoke: async () => { calls.push("smoke"); return { health: "ok", readiness: "ready", status: "ok" }; }
  };
}
