import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvironmentFile } from "../src/runtime/environment-file.js";
import { FileSetupConfigRepository, renderSetupEnvironment } from "../src/setup/setup-config.js";
import { renderSetupSummary } from "../src/setup/setup-summary.js";
import type { SetupCheckReport, SetupContext, SetupDraft } from "../src/setup/setup-types.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-setup-config-"));
  const cwd = join(root, "project");
  const configDirectory = join(root, "config");
  const stateDirectory = join(root, "state");
  const context: SetupContext = { root, cwd, configDirectory, stateDirectory, serviceName: "herdr-agent-swarm.service" };
  const draft: SetupDraft = {
    environment: {
      LARK_APP_ID: "cli_test", LARK_APP_SECRET: "top-secret", LARK_CHAT_ID: "oc_chat",
      LARK_BOT_OPEN_ID: "ou_bot", LARK_OPERATOR_OPEN_IDS: "ou_owner",
      PROJECTS_CONFIG_PATH: join(configDirectory, "projects.json"), BRIDGE_DATABASE_PATH: join(stateDirectory, "bridge.db"),
      BRIDGE_HTTP_HOST: "127.0.0.1", BRIDGE_HTTP_PORT: "8787", FUTURE_SUPPORTED_SETTING: "keep me",
      PATH: "/secret/process/path", HOME: "/secret/home", SWARM_ROOT: "/launcher/root",
      SWARM_CONFIG_DIR: "/launcher/config", SWARM_STATE_DIR: "/launcher/state",
      XDG_CONFIG_HOME: "/xdg/config", XDG_STATE_HOME: "/xdg/state", NODE_BIN: "/launcher/node",
      HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock"
    },
    registry: { defaultProjectId: "bridge", projects: [{
      id: "bridge", displayName: "Bridge", description: "Bridge service", workspaceId: "w1", cwd,
      maxInstances: 8, instances: [
        { name: "primary", role: "primary", agent: "traex", workspace: { kind: "main-checkout" } },
        { name: "worker", role: "worker", agent: "traex", workspace: { kind: "git-worktree", baseRef: "HEAD" } }
      ]
    }] }
  };
  return { root, cwd, configDirectory, context, draft };
}

describe("file setup configuration repository", () => {
  it("renders supported settings deterministically without process-only variables", () => {
    const { draft } = fixture();
    const rendered = renderSetupEnvironment(draft.environment);
    expect(rendered.indexOf("LARK_APP_ID")).toBeLessThan(rendered.indexOf("BRIDGE_HTTP_PORT"));
    expect(rendered).toContain('FUTURE_SUPPORTED_SETTING="keep me"');
    for (const key of [
      "PATH", "HOME", "SWARM_ROOT", "SWARM_CONFIG_DIR", "SWARM_STATE_DIR",
      "XDG_CONFIG_HOME", "XDG_STATE_HOME", "NODE_BIN"
    ]) expect(rendered).not.toMatch(new RegExp(`^${key}=`, "m"));
    expect(rendered).toContain('HERDR_SOCKET_PATH="/run/user/1000/herdr.sock"');
  });

  it("commits a validated environment and registry with private modes", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    const result = await new FileSetupConfigRepository().commit(draft, context);
    expect(statSync(context.configDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(result.environmentFile).mode & 0o777).toBe(0o600);
    expect(statSync(result.projectsFile).mode & 0o777).toBe(0o600);
    expect(readEnvironmentFile(result.environmentFile).LARK_APP_SECRET).toBe("top-secret");
    expect(JSON.parse(readFileSync(result.projectsFile, "utf8"))).toEqual(draft.registry);
    expect(readFileSync(result.projectsFile, "utf8")).toBe(`${JSON.stringify(draft.registry, null, 2)}\n`);
    expect(existsSync(join(context.configDirectory, ".setup-transaction.json"))).toBe(false);
  });

  it("backs up a valid existing pair with private file modes", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    const repository = new FileSetupConfigRepository({ now: () => new Date("2026-08-30T12:34:56.000Z") });
    await repository.commit(draft, context);
    const replacement = { ...draft, environment: { ...draft.environment, LARK_APP_ID: "cli_new" } };
    const result = await repository.commit(replacement, context);
    expect(result.backupDirectory).toBe(join(context.configDirectory, "backup-2026-08-30T12-34-56.000Z"));
    expect(readEnvironmentFile(join(result.backupDirectory!, ".env")).LARK_APP_ID).toBe("cli_test");
    expect(statSync(join(result.backupDirectory!, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(result.backupDirectory!, "projects.json")).mode & 0o777).toBe(0o600);
  });

  it("restores both old files if the second replacement fails", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    const initial = new FileSetupConfigRepository();
    const paths = await initial.commit(draft, context);
    const originalEnvironment = readFileSync(paths.environmentFile, "utf8");
    const originalProjects = readFileSync(paths.projectsFile, "utf8");
    let replacement = 0;
    const failingRepository = new FileSetupConfigRepository({
      replace: async (source, destination, replace) => {
        replacement += 1;
        if (replacement === 2) throw new Error("injected replacement failure");
        await replace(source, destination);
      }
    });
    await expect(failingRepository.commit({ ...draft, environment: { ...draft.environment, LARK_APP_ID: "cli_new" } }, context))
      .rejects.toThrow(/restored previous configuration/);
    expect(readFileSync(paths.environmentFile, "utf8")).toBe(originalEnvironment);
    expect(readFileSync(paths.projectsFile, "utf8")).toBe(originalProjects);
    expect(existsSync(join(context.configDirectory, ".setup-env.draft"))).toBe(false);
    expect(existsSync(join(context.configDirectory, ".setup-projects.draft"))).toBe(false);
    expect(existsSync(join(context.configDirectory, ".setup-transaction.json"))).toBe(false);
  });

  it("removes both targets after a failed first-run replacement", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    let replacement = 0;
    const repository = new FileSetupConfigRepository({
      replace: async (source, destination, replace) => {
        replacement += 1;
        if (replacement === 2) throw new Error("injected replacement failure");
        await replace(source, destination);
      }
    });
    await expect(repository.commit(draft, context)).rejects.toThrow(/removed incomplete configuration/);
    expect(existsSync(join(context.configDirectory, ".env"))).toBe(false);
    expect(existsSync(join(context.configDirectory, "projects.json"))).toBe(false);
  });

  it("reports incomplete and invalid existing configuration without overwriting it", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(cwd), mkdir(context.configDirectory, { mode: 0o700 })]));
    const environmentFile = join(context.configDirectory, ".env");
    writeFileSync(environmentFile, "broken", { mode: 0o600 });
    const repository = new FileSetupConfigRepository();
    const checks = await repository.validate(draft, context);
    expect(checks).toContainEqual(expect.objectContaining({ id: "config.incomplete-transaction", status: "fail" }));
    await expect(repository.commit(draft, context)).rejects.toThrow(/incomplete configuration transaction/);
    expect(readFileSync(environmentFile, "utf8")).toBe("broken");

    writeFileSync(join(context.configDirectory, "projects.json"), "not-json", { mode: 0o600 });
    const invalidChecks = await repository.validate(draft, context);
    expect(invalidChecks).toContainEqual(expect.objectContaining({ id: "config.existing", status: "fail" }));
    await expect(repository.commit(draft, context)).rejects.toThrow(/existing configuration is invalid/);
  });

  it("rejects a prior transaction marker with its private backup path", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(cwd), mkdir(context.configDirectory, { mode: 0o700 })]));
    const backupDirectory = join(context.configDirectory, "backup-crash");
    writeFileSync(join(context.configDirectory, ".setup-transaction.json"), JSON.stringify({ backupDirectory }), { mode: 0o600 });
    const checks = await new FileSetupConfigRepository().validate(draft, context);
    expect(checks).toContainEqual(expect.objectContaining({
      id: "config.incomplete-transaction", status: "fail", remediation: expect.stringContaining(backupDirectory)
    }));
  });

  it("loads a complete valid pair and validates drafts through production rules", async () => {
    const { cwd, context, draft } = fixture();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    const repository = new FileSetupConfigRepository();
    expect(await repository.load(context)).toBeNull();
    await repository.commit(draft, context);
    expect(await repository.load(context)).toEqual({
      environment: expect.objectContaining({ LARK_APP_SECRET: "top-secret" }), registry: draft.registry
    });
    expect(await repository.validate(draft, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "config.schema", status: "pass" }),
      expect.objectContaining({ id: "config.directories", status: "pass" }),
      expect.objectContaining({ id: "config.permissions", status: "pass" }),
      expect.objectContaining({ id: "config.port", status: "pass" })
    ]));
    const invalid = { ...draft, environment: { ...draft.environment, LARK_APP_SECRET: "", BRIDGE_HTTP_PORT: "99999" } };
    const checks = await repository.validate(invalid, context);
    expect(checks).toContainEqual(expect.objectContaining({ id: "config.schema", status: "fail" }));
    expect(JSON.stringify(checks)).not.toContain("top-secret");
  });
});

describe("setup summary", () => {
  it("never renders a secret in the review summary", () => {
    const { context, draft } = fixture();
    const report: SetupCheckReport = {
      checks: [{ id: "config.schema", status: "pass", summary: "Configuration schema is valid; top-secret was accepted" }],
      policy: { canSave: true, canStart: true, hasWarnings: false, hasSkipped: false }
    };
    const summary = renderSetupSummary(draft, report, context);
    expect(summary).not.toContain("top-secret");
    expect(summary).toContain("Lark secret: set");
    expect(summary).toContain("cli_test");
    expect(summary).toContain("127.0.0.1:8787");
    expect(summary).toContain("herdr-agent-swarm.service");
    expect(summary).toContain("primary (primary, traex, main-checkout)");
  });
});
