import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, validateProjectDirectories } from "../src/config.js";

const requiredEnvironment = {
  LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_CHAT_ID: "chat", LARK_BOT_OPEN_ID: "bot",
  HERDR_WORKSPACE_ID: "legacy-workspace", HERDR_WORKSPACE_CWD: "/legacy/project"
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
    expect(config.projects).toEqual([{ id: "bridge", displayName: "Herdr Lark Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge" }]);
    expect(config.herdr.workspaceId).toBe("wH");
  });

  it("synthesizes one legacy project only when the registry is absent", () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), "herdr-projects-")), "missing.json");
    const config = loadConfig({ ...requiredEnvironment, PROJECTS_CONFIG_PATH: missingPath });

    expect(config.defaultProjectId).toBe("default");
    expect(config.projects).toEqual([{ id: "default", displayName: "Default project", description: "Legacy Herdr workspace", workspaceId: "legacy-workspace", cwd: "/legacy/project" }]);
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

  it("rejects project paths that are missing or not directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-projects-"));
    const filePath = join(directory, "file.txt");
    writeFileSync(filePath, "not a directory");

    expect(() => validateProjectDirectories([{ id: "missing", displayName: "Missing", description: "Missing", workspaceId: "w1", cwd: join(directory, "missing") }])).toThrow(/not accessible/);
    expect(() => validateProjectDirectories([{ id: "file", displayName: "File", description: "File", workspaceId: "w1", cwd: filePath }])).toThrow(/not accessible/);
    expect(() => validateProjectDirectories([{ id: "valid", displayName: "Valid", description: "Valid", workspaceId: "w1", cwd: directory }])).not.toThrow();
  });
});
