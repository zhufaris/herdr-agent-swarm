import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeEnvironmentFile } from "../src/runtime/environment-file.js";
import { loadConfig, validateEnvironmentAndRegistry, validateProjectDirectories, validateProjectRegistry } from "../src/config.js";

const defaultDirectory = mkdtempSync(join(tmpdir(), "herdr-default-projects-"));
const defaultRegistryPath = join(defaultDirectory, "projects.json");
writeFileSync(defaultRegistryPath, JSON.stringify({
  defaultProjectId: "default",
  projects: [{ id: "default", displayName: "Default project", description: "Default project", workspaceId: "w1", cwd: "/work/default" }]
}));
const requiredEnvironment = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_CHAT_ID: "chat", LARK_BOT_OPEN_ID: "bot",
  LARK_ALLOWED_OPEN_IDS: "ou_user,ou_admin", LARK_ADMIN_OPEN_IDS: "ou_admin",
  PROJECTS_CONFIG_PATH: defaultRegistryPath
};

describe("project registry configuration", () => {
  it("serializes environment values in stable order", () => {
    expect(serializeEnvironmentFile({ Z_FUTURE: "kept", LARK_APP_ID: "app id", A_FUTURE: "quoted\"value" }, ["LARK_APP_ID"]))
      .toBe('LARK_APP_ID="app id"\nA_FUTURE="quoted\\\"value"\nZ_FUTURE="kept"\n');
  });

  it("validates a registry object without reading a file", () => {
    expect(validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge" }]
    })).toEqual({
      defaultProjectId: "bridge",
      projects: [{
        id: "bridge", displayName: "Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge",
        maxInstances: 8
      }]
    });
  });

  it("validates an optional fixed Orchestrator route on a project", () => {
    expect(validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{
        id: "bridge", displayName: "Bridge", description: "Bridge service",
        workspaceId: "wH", cwd: "/work/bridge",
        orchestrator: { enabled: true, cwd: "/tmp" }
      }]
    })).toEqual({
      defaultProjectId: "bridge",
      projects: [{
        id: "bridge", displayName: "Bridge", description: "Bridge service",
        workspaceId: "wH", cwd: "/work/bridge", maxInstances: 8,
        orchestrator: { enabled: true, cwd: "/tmp" }
      }]
    });
    expect(() => validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{
        id: "bridge", displayName: "Bridge", description: "Bridge service",
        workspaceId: "wH", cwd: "/work/bridge",
        orchestrator: { enabled: true, cwd: "relative/path" }
      }]
    })).toThrow(/cwd must be an absolute path/);
    expect(validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge", orchestrator: { enabled: false, cwd: "/unused" } }]
    }).projects[0]?.orchestrator).toEqual({ enabled: false, cwd: "/unused" });
    expect(() => validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge", orchestrator: { enabled: true, cwd: "/work", typo: true } }]
    })).toThrow(/typo/);
  });

  it("validates an environment with an explicit registry object", () => {
    const registry = validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge" }]
    });

    const config = validateEnvironmentAndRegistry({
      ...requiredEnvironment, PROJECTS_CONFIG_PATH: "/not/read/by-object-validation.json"
    }, registry);

    expect(config.defaultProjectId).toBe("bridge");
    expect(config.herdr).toMatchObject({ workspaceId: "wH", workspaceCwd: "/work/bridge" });
    expect(config.projectsConfigPath).toBe("/not/read/by-object-validation.json");
  });

  it("loads the repository registry as the authoritative project allowlist", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const registryPath = join(directory, "projects.json");
    writeFileSync(registryPath, JSON.stringify({
      defaultProjectId: "bridge",
      projects: [{ id: "bridge", displayName: "Herdr Lark Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge" }]
    }));

    const config = loadConfig({ ...requiredEnvironment, PROJECTS_CONFIG_PATH: registryPath });

    expect(config.defaultProjectId).toBe("bridge");
    expect(config.projects).toEqual([{
      id: "bridge", displayName: "Herdr Lark Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge",
      maxInstances: 8
    }]);
    expect(config.herdr.workspaceId).toBe("wH");
  });

  it("rejects the removed instance-template configuration surface", () => {
    expect(() => validateProjectRegistry({
      defaultProjectId: "bridge",
      projects: [{ id: "bridge", displayName: "Bridge", description: "Bridge", workspaceId: "w1", cwd: "/work/bridge", instances: [] }]
    })).toThrow(/instances/);
  });

  it("defaults the Worker limit for minimal project registries", () => {
    const project = loadConfig(requiredEnvironment).projects[0];
    expect(project.maxInstances).toBe(8);
    expect(project).not.toHaveProperty("instances");
  });

  it("requires the project registry even when legacy workspace variables are present", () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), "herdr-projects-")), "missing.json");
    expect(() => loadConfig({
      ...requiredEnvironment, PROJECTS_CONFIG_PATH: missingPath,
      HERDR_WORKSPACE_ID: "legacy-workspace", HERDR_WORKSPACE_CWD: "/legacy/project"
    })).toThrow(`Project registry not found at ${missingPath}`);
  });

  it("rejects a present but invalid registry instead of falling back", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const registryPath = join(directory, "projects.json");
    writeFileSync(registryPath, JSON.stringify({ defaultProjectId: "missing", projects: [] }));

    expect(() => loadConfig({ ...requiredEnvironment, PROJECTS_CONFIG_PATH: registryPath })).toThrow();
  });

  it("requires the lease heartbeat to be less than half the TTL", () => {
    expect(() => loadConfig({ ...requiredEnvironment, INSTANCE_LEASE_TTL_MS: "10000", INSTANCE_LEASE_HEARTBEAT_MS: "5000" })).toThrow(/less than half/);
    expect(loadConfig({ ...requiredEnvironment }).instanceLease).toEqual({ ttlMs: 15_000, heartbeatMs: 5_000 });
  });

  it("keeps SQLite lock and retry waits inside the lease heartbeat safety budget", () => {
    expect(loadConfig(requiredEnvironment).sqlite).toEqual({
      busyTimeoutMs: 250,
      busyRetryBudgetMs: 1_000,
      slowTransactionThresholdMs: 100
    });
    expect(loadConfig({
      ...requiredEnvironment,
      SQLITE_BUSY_TIMEOUT_MS: "200",
      SQLITE_BUSY_RETRY_BUDGET_MS: "250",
      SQLITE_SLOW_TRANSACTION_MS: "50"
    }).sqlite).toEqual({ busyTimeoutMs: 200, busyRetryBudgetMs: 250, slowTransactionThresholdMs: 50 });
    expect(() => loadConfig({
      ...requiredEnvironment,
      INSTANCE_LEASE_TTL_MS: "3000",
      INSTANCE_LEASE_HEARTBEAT_MS: "1000",
      SQLITE_BUSY_TIMEOUT_MS: "500",
      SQLITE_BUSY_RETRY_BUDGET_MS: "500"
    })).toThrow(/SQLite.*lease heartbeat safety budget/i);
  });

  it("uses only TraeX-supported permission modes", () => {
    expect(loadConfig({ ...requiredEnvironment }).traex.permissionMode).toBe("auto");
    expect(loadConfig({ ...requiredEnvironment, TRAEX_PERMISSION_MODE: "auto" }).traex.permissionMode).toBe("auto");
    expect(loadConfig({ ...requiredEnvironment, TRAEX_PERMISSION_MODE: "bypass_permissions" }).traex.permissionMode).toBe("bypass_permissions");
    expect(() => loadConfig({ ...requiredEnvironment, TRAEX_PERMISSION_MODE: "suggest" })).toThrow();
  });

  it("supports an explicit TraeX transcript sessions root", () => {
    expect(loadConfig({ ...requiredEnvironment, TRAEX_SESSIONS_ROOT: "/runtime/traex/sessions" }).traex.sessionsRoot).toBe("/runtime/traex/sessions");
  });

  it("keeps Herdr reply observation opt-in until shadow validation completes", () => {
    expect(loadConfig(requiredEnvironment).herdr.replyObservation).toBe("events");
    expect(loadConfig({ ...requiredEnvironment, HERDR_REPLY_OBSERVATION: "shadow" }).herdr.replyObservation).toBe("shadow");
    expect(loadConfig({ ...requiredEnvironment, HERDR_REPLY_OBSERVATION: "jsonl" }).herdr.replyObservation).toBe("jsonl");
  });

  it("configures every supported agent executable independently", () => {
    expect(loadConfig({ ...requiredEnvironment, CODEX_BIN: "/opt/codex", CLAUDE_CODE_BIN: "/opt/claude", PI_BIN: "/opt/pi" }).agents).toEqual({ codex: "/opt/codex", claudeCode: "/opt/claude", pi: "/opt/pi" });
  });

  it("bounds the periodic full reconciliation interval", () => {
    expect(loadConfig(requiredEnvironment).reconcileIntervalMs).toBe(30_000);
    expect(loadConfig({ ...requiredEnvironment, RECONCILE_INTERVAL_MS: "5000" }).reconcileIntervalMs).toBe(5_000);
    expect(loadConfig({ ...requiredEnvironment, RECONCILE_INTERVAL_MS: "3600000" }).reconcileIntervalMs).toBe(3_600_000);
    expect(() => loadConfig({ ...requiredEnvironment, RECONCILE_INTERVAL_MS: "4999" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, RECONCILE_INTERVAL_MS: "3600001" })).toThrow();
  });

  it("configures Lark request timeout independently from command execution", () => {
    expect(loadConfig({ ...requiredEnvironment, COMMAND_TIMEOUT_MS: "45000" }).lark.requestTimeoutMs).toBe(30_000);
    expect(loadConfig({ ...requiredEnvironment, COMMAND_TIMEOUT_MS: "45000", LARK_REQUEST_TIMEOUT_MS: "12000" })).toMatchObject({
      commandTimeoutMs: 45_000, lark: { requestTimeoutMs: 12_000 }
    });
    expect(() => loadConfig({ ...requiredEnvironment, LARK_REQUEST_TIMEOUT_MS: "0" })).toThrow();
  });

  it("restricts the health server to loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(loadConfig({ ...requiredEnvironment, BRIDGE_HTTP_HOST: host }).http.host).toBe(host);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "bridge.internal"]) {
      expect(() => loadConfig({ ...requiredEnvironment, BRIDGE_HTTP_HOST: host })).toThrow(/BRIDGE_HTTP_HOST/);
    }
  });

  it("requires explicit Feishu access and administrator allowlists", () => {
    expect(loadConfig(requiredEnvironment).lark).toMatchObject({ allowedOpenIds: ["ou_user", "ou_admin"], adminOpenIds: ["ou_admin"] });
    expect(loadConfig({ ...requiredEnvironment, LARK_ALLOWED_OPEN_IDS: "ou_one, ou_two,ou_one", LARK_ADMIN_OPEN_IDS: "ou_two" }).lark)
      .toMatchObject({ allowedOpenIds: ["ou_one", "ou_two"], adminOpenIds: ["ou_two"] });
    expect(() => loadConfig({ ...requiredEnvironment, LARK_ALLOWED_OPEN_IDS: "" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, LARK_ADMIN_OPEN_IDS: "" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, LARK_ADMIN_OPEN_IDS: "ou_other" })).toThrow(/subset/);
    expect(() => loadConfig({ ...requiredEnvironment, LARK_ALLOWED_OPEN_IDS: "not-an-open-id" })).toThrow(/Open IDs/);
  });

  it("validates Herdr circuit breaker threshold and cooldown independently", () => {
    expect(loadConfig({ ...requiredEnvironment }).herdrCircuitBreaker).toEqual({ failureThreshold: 3, openMs: 15_000 });
    expect(loadConfig({ ...requiredEnvironment, HERDR_CIRCUIT_FAILURE_THRESHOLD: "5", HERDR_CIRCUIT_OPEN_MS: "20000" }).herdrCircuitBreaker)
      .toEqual({ failureThreshold: 5, openMs: 20_000 });
    expect(() => loadConfig({ ...requiredEnvironment, HERDR_CIRCUIT_FAILURE_THRESHOLD: "0" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, HERDR_CIRCUIT_OPEN_MS: "99" })).toThrow();
  });

  it("bounds retention catch-up batches independently from batch size", () => {
    expect(loadConfig({ ...requiredEnvironment }).outboxRetention).toEqual({
      days: 14, payloadDays: 30, batchSize: 500, maxBatches: 20, timeBudgetMs: 250,
      payloadCompactionEnabled: false, coreEventMode: "off", coreEventRetentionHours: 24
    });
    expect(loadConfig({ ...requiredEnvironment, OUTBOX_RETENTION_MAX_BATCHES: "3" }).outboxRetention.maxBatches).toBe(3);
    expect(() => loadConfig({ ...requiredEnvironment, OUTBOX_RETENTION_MAX_BATCHES: "0" })).toThrow();
    expect(loadConfig({ ...requiredEnvironment, RETENTION_COMPACTION_TIME_BUDGET_MS: "1000" }).outboxRetention.timeBudgetMs).toBe(1_000);
    expect(() => loadConfig({ ...requiredEnvironment, RETENTION_COMPACTION_TIME_BUDGET_MS: "9" })).toThrow();
    expect(loadConfig({ ...requiredEnvironment, RETENTION_PAYLOAD_COMPACTION_ENABLED: "true" }).outboxRetention.payloadCompactionEnabled).toBe(true);
    expect(() => loadConfig({ ...requiredEnvironment, RETENTION_PAYLOAD_COMPACTION_ENABLED: "yes" })).toThrow();
    expect(loadConfig({
      ...requiredEnvironment, CORE_EVENT_RETENTION_MODE: "audit", CORE_EVENT_RETENTION_HOURS: "48"
    }).outboxRetention).toMatchObject({ coreEventMode: "audit", coreEventRetentionHours: 48 });
    expect(loadConfig({ ...requiredEnvironment, CORE_EVENT_RETENTION_MODE: "compact" }).outboxRetention.coreEventMode).toBe("compact");
    expect(() => loadConfig({ ...requiredEnvironment, CORE_EVENT_RETENTION_MODE: "enabled" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, CORE_EVENT_RETENTION_HOURS: "0" })).toThrow();
  });

  it("configures a low-frequency SQLite integrity audit", () => {
    expect(loadConfig({ ...requiredEnvironment }).sqliteIntegrityAudit).toEqual({ intervalMs: 900_000, issueLimit: 20 });
    expect(loadConfig({ ...requiredEnvironment, SQLITE_INTEGRITY_AUDIT_INTERVAL_MS: "120000" }).sqliteIntegrityAudit.intervalMs).toBe(120_000);
    expect(() => loadConfig({ ...requiredEnvironment, SQLITE_INTEGRITY_AUDIT_INTERVAL_MS: "59999" })).toThrow();
  });

  it("configures bounded detached Prompt auto-skip with zero as an explicit disable", () => {
    expect(loadConfig(requiredEnvironment).detachedPromptAutoSkipMs).toBe(1_800_000);
    expect(loadConfig({ ...requiredEnvironment, DETACHED_PROMPT_AUTO_SKIP_MS: "0" }).detachedPromptAutoSkipMs).toBe(0);
    expect(loadConfig({ ...requiredEnvironment, DETACHED_PROMPT_AUTO_SKIP_MS: "60000" }).detachedPromptAutoSkipMs).toBe(60_000);
    expect(() => loadConfig({ ...requiredEnvironment, DETACHED_PROMPT_AUTO_SKIP_MS: "59999" })).toThrow();
  });

  it("configures bounded runtime cache, safety scan, and debounce intervals", () => {
    expect(loadConfig(requiredEnvironment).runtimeTuning).toEqual({
      polling: { transcriptIdentityMs: 50, attachedTranscriptMs: 250, workerTurnMs: 250, externalTurnMs: 2_000 },
      cache: { herdrSnapshotTtlMs: 2_000 },
      cards: { updateDebounceMs: 250, payloadLimitChars: 12_000, answerStreamLimitChars: 28_000, answerPageLimitChars: 21_000, reasoningDisplay: "visible" },
      paneClosure: { confirmationTtlMs: 60_000 },
      recovery: { externalTurnNotFoundMaxAttempts: 3 },
      outboxSafetyScanIntervalMs: 30_000
    });
    expect(loadConfig({ ...requiredEnvironment, OUTBOX_SAFETY_SCAN_INTERVAL_MS: "1000" }).runtimeTuning.outboxSafetyScanIntervalMs).toBe(1_000);
    expect(() => loadConfig({ ...requiredEnvironment, OUTBOX_SAFETY_SCAN_INTERVAL_MS: "999" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, OUTBOX_SAFETY_SCAN_INTERVAL_MS: "300001" })).toThrow();
  });

  it("loads partial runtime tuning from strict YAML", () => {
    const path = join(mkdtempSync(join(tmpdir(), "herdr-runtime-")), "runtime.yaml");
    writeFileSync(path, "runtime:\n  polling:\n    workerTurnMs: 40\n  cards:\n    updateDebounceMs: 0\n    answerPageLimitChars: 8000\n");
    expect(loadConfig({ ...requiredEnvironment, RUNTIME_CONFIG_PATH: path }).runtimeTuning).toEqual({
      polling: { transcriptIdentityMs: 50, attachedTranscriptMs: 250, workerTurnMs: 40, externalTurnMs: 2_000 },
      cache: { herdrSnapshotTtlMs: 2_000 },
      cards: { updateDebounceMs: 0, payloadLimitChars: 12_000, answerStreamLimitChars: 28_000, answerPageLimitChars: 8_000, reasoningDisplay: "visible" },
      paneClosure: { confirmationTtlMs: 60_000 },
      recovery: { externalTurnNotFoundMaxAttempts: 3 },
      outboxSafetyScanIntervalMs: 30_000
    });
  });

  it("rejects malformed, unknown, and inconsistent runtime YAML", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-runtime-invalid-"));
    const path = join(directory, "runtime.yaml");
    writeFileSync(path, "runtime: [");
    expect(() => loadConfig({ ...requiredEnvironment, RUNTIME_CONFIG_PATH: path })).toThrow(/runtime configuration/i);
    writeFileSync(path, "runtime:\n  polling:\n    typoMs: 25\n");
    expect(() => loadConfig({ ...requiredEnvironment, RUNTIME_CONFIG_PATH: path })).toThrow(/typoMs/);
    writeFileSync(path, "runtime:\n  cards:\n    answerStreamLimitChars: 8000\n    answerPageLimitChars: 9000\n");
    expect(() => loadConfig({ ...requiredEnvironment, RUNTIME_CONFIG_PATH: path })).toThrow(/answerPageLimitChars/);
    writeFileSync(path, "runtime:\n  cards:\n    reasoningDisplay: full\n");
    expect(() => loadConfig({ ...requiredEnvironment, RUNTIME_CONFIG_PATH: path })).toThrow(/reasoningDisplay/);
  });

  it("accepts explicit Pane-visible reasoning display", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-runtime-visible-reasoning-"));
    const path = join(directory, "runtime.yaml");
    writeFileSync(path, "runtime:\n  cards:\n    reasoningDisplay: visible\n");
    expect(loadConfig({ ...requiredEnvironment, RUNTIME_CONFIG_PATH: path }).runtimeTuning.cards.reasoningDisplay).toBe("visible");
  });

  it("rejects retired runtime environment overrides with migration guidance", () => {
    expect(() => loadConfig({ ...requiredEnvironment, HERDR_SNAPSHOT_CACHE_TTL_MS: "1000" })).toThrow(/runtime.yaml.*runtime.cache.herdrSnapshotTtlMs/);
    expect(() => loadConfig({ ...requiredEnvironment, CARD_UPDATE_DEBOUNCE_MS: "1000" })).toThrow(/runtime.yaml.*runtime.cards.updateDebounceMs/);
  });

  it("rejects project paths that are missing or not directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const filePath = join(directory, "file.txt");
    writeFileSync(filePath, "not a directory");

    expect(() => validateProjectDirectories([{ id: "missing", displayName: "Missing", description: "Missing", workspaceId: "w1", cwd: join(directory, "missing") }])).toThrow(/not accessible/);
    expect(() => validateProjectDirectories([{ id: "file", displayName: "File", description: "File", workspaceId: "w1", cwd: filePath }])).toThrow(/not accessible/);
    expect(() => validateProjectDirectories([{ id: "valid", displayName: "Valid", description: "Valid", workspaceId: "w1", cwd: directory }])).not.toThrow();
    expect(() => validateProjectDirectories([{ id: "orchestrator", displayName: "Orchestrator", description: "Orchestrator", workspaceId: "w1", cwd: directory, orchestrator: { enabled: true, cwd: join(directory, "missing") } }])).toThrow(/Orchestrator directory is not accessible/);
    expect(() => validateProjectDirectories([{ id: "disabled", displayName: "Disabled", description: "Disabled", workspaceId: "w1", cwd: directory, orchestrator: { enabled: false, cwd: join(directory, "missing") } }])).not.toThrow();
  });
});
