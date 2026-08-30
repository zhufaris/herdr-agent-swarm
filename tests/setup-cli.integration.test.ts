import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorCli } from "../src/cli/doctor.js";
import { resolveSetupContext, runSetupCli } from "../src/cli/setup.js";
import { SetupCancelledError } from "../src/setup/setup-prompts.js";
import type { SetupCheck, SetupContext, SetupDraft } from "../src/setup/setup-types.js";

const context: SetupContext = { root: "/repo", configDirectory: "/config", stateDirectory: "/state", serviceName: "swarm.service", cwd: "/project" };

describe("setup CLI", () => {
  it("resolves only standalone runtime paths", () => {
    expect(resolveSetupContext({ SWARM_ROOT: "/repo", SWARM_CONFIG_DIR: "/config", SWARM_STATE_DIR: "/state", BRIDGE_SYSTEMD_SERVICE_NAME: "swarm.service" }, "/project")).toEqual(context);
    expect(resolveSetupContext({
      HERDR_PLUGIN_ROOT: "/plugin", HERDR_PLUGIN_CONFIG_DIR: "/plugin-config", HERDR_PLUGIN_STATE_DIR: "/plugin-state",
      XDG_CONFIG_HOME: "/xdg-config", XDG_STATE_HOME: "/xdg-state"
    }, "/project")).toEqual({
      root: "/project", configDirectory: "/xdg-config/herdr-agent-swarm", stateDirectory: "/xdg-state/herdr-agent-swarm",
      serviceName: "herdr-agent-swarm.service", cwd: "/project"
    });
  });

  it.each(["saved", "installed", "started"] as const)("returns zero for a %s outcome", async (status) => {
    expect(await runSetupCli([], {}, { runWorkflow: async () => ({ status, commit: { environmentFile: "e", projectsFile: "p" } }), context })).toBe(0);
  });

  it("passes --skip-network and maps cancellation and failures", async () => {
    let skipNetwork = false;
    expect(await runSetupCli(["--skip-network"], {}, { context, runWorkflow: async (dependencies) => { skipNetwork = dependencies.skipNetwork === true; return { status: "cancelled" }; } })).toBe(130);
    expect(skipNetwork).toBe(true);
    expect(await runSetupCli([], {}, { context, runWorkflow: async () => { throw new SetupCancelledError(); } })).toBe(130);
    expect(await runSetupCli([], {}, { context, runWorkflow: async () => { throw new Error("broken"); }, writeError: () => undefined })).toBe(1);
  });

  it("returns usage status for unsupported flags", async () => {
    expect(await runSetupCli(["--force"], {}, { context, writeError: () => undefined })).toBe(2);
  });

  it("redacts configured secrets from failures", async () => {
    const errors: string[] = [];
    await runSetupCli([], { LARK_APP_SECRET: "top-secret" }, { context, runWorkflow: async () => { throw new Error("failed for top-secret"); }, writeError: (message) => errors.push(message) });
    expect(errors.join("\n")).not.toContain("top-secret");
    expect(errors.join("\n")).toContain("[redacted]");
  });
});

describe("doctor CLI", () => {
  it("returns zero for warnings and never mutates configuration or lifecycle", async () => {
    let commits = 0;
    let lifecycleMutations = 0;
    const dependencies = doctorDependencies([{ id: "lark.bot", status: "warning", summary: "verify manually" }], () => { commits += 1; }, () => { lifecycleMutations += 1; });
    expect(await runDoctorCli([], {}, { context, dependencies, write: () => undefined, writeError: () => undefined })).toBe(0);
    expect(commits).toBe(0);
    expect(lifecycleMutations).toBe(0);
  });

  it("returns one for failed checks and two for invalid flags", async () => {
    expect(await runDoctorCli([], {}, { context, dependencies: doctorDependencies([{ id: "config.schema", status: "fail", summary: "invalid" }]), write: () => undefined, writeError: () => undefined })).toBe(1);
    expect(await runDoctorCli(["--json"], {}, { context, writeError: () => undefined })).toBe(2);
  });

  it("returns zero for explicitly skipped checks because doctor fails only on failures", async () => {
    expect(await runDoctorCli([], {}, { context, dependencies: doctorDependencies([{ id: "lark.auth", status: "skipped", summary: "skipped" }]), write: () => undefined, writeError: () => undefined })).toBe(0);
  });

  it("loads explicit environment and projects paths without changing them", async () => {
    const root = mkdtempSync(join(tmpdir(), "setup-doctor-"));
    const environmentFile = join(root, "custom.env");
    const projectsFile = join(root, "custom-projects.json");
    writeFileSync(environmentFile, "LARK_APP_SECRET=secret\n", { mode: 0o640 });
    writeFileSync(projectsFile, JSON.stringify({ defaultProjectId: "p", projects: [] }), { mode: 0o640 });
    const before = [readFileSync(environmentFile, "utf8"), readFileSync(projectsFile, "utf8"), statSync(environmentFile).mode, statSync(projectsFile).mode];
    let loaded = false;
    const dependencies = doctorDependencies([], undefined, undefined, async () => { loaded = true; return draft; });
    expect(await runDoctorCli(["--env", environmentFile, "--projects", projectsFile], {}, { context, dependencies, write: () => undefined, writeError: () => undefined })).toBe(0);
    expect(loaded).toBe(true);
    expect([readFileSync(environmentFile, "utf8"), readFileSync(projectsFile, "utf8"), statSync(environmentFile).mode, statSync(projectsFile).mode]).toEqual(before);
  });
});

const draft: SetupDraft = { environment: { LARK_APP_SECRET: "secret" }, registry: { defaultProjectId: "p", projects: [] } };

function doctorDependencies(checks: SetupCheck[], onCommit = () => undefined, onLifecycle = () => undefined, load = async () => draft) {
  return {
    config: { load, validate: async () => checks, commit: async () => { onCommit(); return { environmentFile: "e", projectsFile: "p" }; } },
    herdr: { listWorkspaces: async () => [], check: async () => [] },
    lark: { check: async () => [] },
    runLocalChecks: async () => [],
    lifecycle: { inspect: async () => ({ installed: false, active: false, summary: "none" }), install: async () => onLifecycle(), start: async () => onLifecycle(), restart: async () => onLifecycle() }
  };
}
