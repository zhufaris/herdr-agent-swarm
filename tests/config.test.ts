import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, validateProjectDirectories, withPluginDefaults } from "../src/config.js";

const defaultDirectory = mkdtempSync(join(tmpdir(), "herdr-default-projects-"));
const defaultRegistryPath = join(defaultDirectory, "projects.json");
writeFileSync(defaultRegistryPath, JSON.stringify({
  defaultProjectId: "default",
  projects: [{ id: "default", displayName: "Default project", description: "Default project", workspaceId: "w1", cwd: "/work/default" }]
}));
const requiredEnvironment = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_CHAT_ID: "chat", LARK_BOT_OPEN_ID: "bot",
  PROJECTS_CONFIG_PATH: defaultRegistryPath
};

describe("project registry configuration", () => {
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
      maxInstances: 8, instances: []
    }]);
    expect(config.herdr.workspaceId).toBe("wH");
  });

  it("loads explicit primary and worker instances for every supported agent kind", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const registryPath = join(directory, "projects.json");
    writeFileSync(registryPath, JSON.stringify({
      defaultProjectId: "bridge",
      projects: [{
        id: "bridge", displayName: "Bridge", description: "Bridge", workspaceId: "w1", cwd: "/work/bridge", maxInstances: 8,
        instances: [
          { name: "architect", role: "primary", agent: "traex", workspace: { kind: "main-checkout" } },
          { name: "coder", role: "worker", agent: "codex", workspace: { kind: "git-worktree", baseRef: "HEAD" } },
          { name: "reviewer", role: "worker", agent: "claude-code", workspace: { kind: "shared-read-only" } },
          { name: "explorer", role: "worker", agent: "pi", workspace: { kind: "shared-read-only" } }
        ]
      }]
    }));

    expect(loadConfig({ ...requiredEnvironment, PROJECTS_CONFIG_PATH: registryPath }).projects[0]).toMatchObject({
      maxInstances: 8,
      instances: [
        { name: "architect", role: "primary", agent: "traex" },
        { name: "coder", role: "worker", agent: "codex" },
        { name: "reviewer", role: "worker", agent: "claude-code" },
        { name: "explorer", role: "worker", agent: "pi" }
      ]
    });
  });

  it("rejects duplicate instance names and multiple primaries", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const registryPath = join(directory, "projects.json");
    const project = { id: "bridge", displayName: "Bridge", description: "Bridge", workspaceId: "w1", cwd: "/work/bridge" };

    writeFileSync(registryPath, JSON.stringify({
      defaultProjectId: "bridge", projects: [{ ...project, instances: [
        { name: "same", role: "worker", agent: "codex", workspace: { kind: "git-worktree", baseRef: "HEAD" } },
        { name: "same", role: "worker", agent: "pi", workspace: { kind: "shared-read-only" } }
      ] }]
    }));
    expect(() => loadConfig({ ...requiredEnvironment, PROJECTS_CONFIG_PATH: registryPath })).toThrow(/duplicate instance name/);

    writeFileSync(registryPath, JSON.stringify({
      defaultProjectId: "bridge", projects: [{ ...project, instances: [
        { name: "one", role: "primary", agent: "traex", workspace: { kind: "main-checkout" } },
        { name: "two", role: "primary", agent: "codex", workspace: { kind: "main-checkout" } }
      ] }]
    }));
    expect(() => loadConfig({ ...requiredEnvironment, PROJECTS_CONFIG_PATH: registryPath })).toThrow(/multiple primary/);
  });

  it("keeps legacy project registries compatible", () => {
    const project = loadConfig(requiredEnvironment).projects[0];
    expect(project.maxInstances).toBe(8);
    expect(project.instances).toEqual([]);
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

  it("uses only TraeX-supported permission modes", () => {
    expect(loadConfig({ ...requiredEnvironment }).traex.permissionMode).toBe("auto");
    expect(loadConfig({ ...requiredEnvironment, TRAEX_PERMISSION_MODE: "auto" }).traex.permissionMode).toBe("auto");
    expect(loadConfig({ ...requiredEnvironment, TRAEX_PERMISSION_MODE: "bypass_permissions" }).traex.permissionMode).toBe("bypass_permissions");
    expect(() => loadConfig({ ...requiredEnvironment, TRAEX_PERMISSION_MODE: "suggest" })).toThrow();
  });

  it("supports an explicit TraeX transcript sessions root", () => {
    expect(loadConfig({ ...requiredEnvironment, TRAEX_SESSIONS_ROOT: "/runtime/traex/sessions" }).traex.sessionsRoot).toBe("/runtime/traex/sessions");
  });

  it("configures every supported agent executable independently", () => {
    expect(loadConfig({ ...requiredEnvironment, CODEX_BIN: "/opt/codex", CLAUDE_CODE_BIN: "/opt/claude", PI_BIN: "/opt/pi" }).agents).toEqual({ codex: "/opt/codex", claudeCode: "/opt/claude", pi: "/opt/pi" });
  });

  it("configures Lark request timeout independently from command execution", () => {
    expect(loadConfig({ ...requiredEnvironment, COMMAND_TIMEOUT_MS: "45000" }).lark.requestTimeoutMs).toBe(30_000);
    expect(loadConfig({ ...requiredEnvironment, COMMAND_TIMEOUT_MS: "45000", LARK_REQUEST_TIMEOUT_MS: "12000" })).toMatchObject({
      commandTimeoutMs: 45_000, lark: { requestTimeoutMs: 12_000 }
    });
    expect(() => loadConfig({ ...requiredEnvironment, LARK_REQUEST_TIMEOUT_MS: "0" })).toThrow();
  });

  it("parses an optional Feishu operator allowlist", () => {
    expect(loadConfig({ ...requiredEnvironment }).lark.operatorOpenIds).toEqual([]);
    expect(loadConfig({ ...requiredEnvironment, LARK_OPERATOR_OPEN_IDS: "ou_one, ou_two,ou_one" }).lark.operatorOpenIds).toEqual(["ou_one", "ou_two"]);
  });

  it("validates Herdr circuit breaker threshold and cooldown independently", () => {
    expect(loadConfig({ ...requiredEnvironment }).herdrCircuitBreaker).toEqual({ failureThreshold: 3, openMs: 15_000 });
    expect(loadConfig({ ...requiredEnvironment, HERDR_CIRCUIT_FAILURE_THRESHOLD: "5", HERDR_CIRCUIT_OPEN_MS: "20000" }).herdrCircuitBreaker)
      .toEqual({ failureThreshold: 5, openMs: 20_000 });
    expect(() => loadConfig({ ...requiredEnvironment, HERDR_CIRCUIT_FAILURE_THRESHOLD: "0" })).toThrow();
    expect(() => loadConfig({ ...requiredEnvironment, HERDR_CIRCUIT_OPEN_MS: "99" })).toThrow();
  });

  it("bounds retention catch-up batches independently from batch size", () => {
    expect(loadConfig({ ...requiredEnvironment }).outboxRetention).toEqual({ days: 14, batchSize: 500, maxBatches: 20 });
    expect(loadConfig({ ...requiredEnvironment, OUTBOX_RETENTION_MAX_BATCHES: "3" }).outboxRetention.maxBatches).toBe(3);
    expect(() => loadConfig({ ...requiredEnvironment, OUTBOX_RETENTION_MAX_BATCHES: "0" })).toThrow();
  });

  it("configures a low-frequency SQLite integrity audit", () => {
    expect(loadConfig({ ...requiredEnvironment }).sqliteIntegrityAudit).toEqual({ intervalMs: 900_000, issueLimit: 20 });
    expect(loadConfig({ ...requiredEnvironment, SQLITE_INTEGRITY_AUDIT_INTERVAL_MS: "120000" }).sqliteIntegrityAudit.intervalMs).toBe(120_000);
    expect(() => loadConfig({ ...requiredEnvironment, SQLITE_INTEGRITY_AUDIT_INTERVAL_MS: "59999" })).toThrow();
  });

  it("uses plugin-native paths unless explicit paths override them", () => {
    expect(withPluginDefaults({ HERDR_PLUGIN_CONFIG_DIR: "/plugin/config", HERDR_PLUGIN_STATE_DIR: "/plugin/state" })).toMatchObject({
      PROJECTS_CONFIG_PATH: "/plugin/config/projects.json", BRIDGE_DATABASE_PATH: "/plugin/state/bridge.db"
    });
    expect(withPluginDefaults({
      HERDR_PLUGIN_CONFIG_DIR: "/plugin/config", HERDR_PLUGIN_STATE_DIR: "/plugin/state",
      PROJECTS_CONFIG_PATH: "/custom/projects.json", BRIDGE_DATABASE_PATH: "/custom/bridge.db"
    })).toMatchObject({ PROJECTS_CONFIG_PATH: "/custom/projects.json", BRIDGE_DATABASE_PATH: "/custom/bridge.db" });
  });

  it("rejects project paths that are missing or not directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const filePath = join(directory, "file.txt");
    writeFileSync(filePath, "not a directory");

    expect(() => validateProjectDirectories([{ id: "missing", displayName: "Missing", description: "Missing", workspaceId: "w1", cwd: join(directory, "missing") }])).toThrow(/not accessible/);
    expect(() => validateProjectDirectories([{ id: "file", displayName: "File", description: "File", workspaceId: "w1", cwd: filePath }])).toThrow(/not accessible/);
    expect(() => validateProjectDirectories([{ id: "valid", displayName: "Valid", description: "Valid", workspaceId: "w1", cwd: directory }])).not.toThrow();
  });
});
