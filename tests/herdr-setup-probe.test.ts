import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HerdrSetupProbe } from "../src/adapters/herdr-setup-probe.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { runLocalSetupChecks } from "../src/setup/setup-checks.js";
import type { SetupContext, SetupDraft } from "../src/setup/setup-types.js";

const context: SetupContext = { root: "/app", configDirectory: "/config", stateDirectory: "/state", serviceName: "herdr-agent-swarm.service", cwd: "/repo" };
const draft: SetupDraft = {
  environment: { HERDR_BIN: "herdr", TRAEX_BIN: "traex", BRIDGE_HTTP_HOST: "127.0.0.1", BRIDGE_HTTP_PORT: "8787" },
  registry: { defaultProjectId: "demo", projects: [{ id: "demo", displayName: "Demo", description: "Demo", workspaceId: "w1", spaceName: "Demo Space", cwd: "/repo" }] }
};

function json(value: unknown) { return { stdout: JSON.stringify(value), stderr: "" }; }

describe("Herdr setup probe", () => {
  it("discovers the workspace and validates native Herdr TraeX capabilities", async () => {
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = { async run(executable, args) {
      calls.push([executable, args]);
      if (args.join(" ") === "workspace list") return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "Demo Space", focused: true }] } });
      if (args.join(" ") === "workspace get w1") return json({ id: "get", result: { type: "workspace_info", workspace: { workspace_id: "w1", label: "Demo Space" } } });
      if (args.join(" ") === "--version") return { stdout: "herdr 0.9.0\n", stderr: "" };
      if (args.join(" ") === "agent start --help") return { stdout: "[possible values: pi, codex, traex]\n", stderr: "" };
      if (args.join(" ") === "integration status") return { stdout: "codex: current (v8) (/hooks/codex)\ntraex: current (v1) (/hooks/traex)\n", stderr: "" };
      throw new Error("unexpected command");
    } };
    const probe = new HerdrSetupProbe(runner, "herdr", 500, { PATH: process.env.PATH });

    expect(await probe.check(draft, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "herdr.available", status: "pass" }),
      expect.objectContaining({ id: "herdr.workspace.demo", status: "pass" }),
      expect.objectContaining({ id: "herdr.version", status: "pass" }),
      expect.objectContaining({ id: "herdr.agent.traex", status: "pass" }),
      expect.objectContaining({ id: "herdr.integration.traex", status: "pass" })
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      ["herdr", ["workspace", "list"]], ["herdr", ["workspace", "get", "w1"]], ["herdr", ["--version"]],
      ["herdr", ["agent", "start", "--help"]], ["herdr", ["integration", "status"]]
    ]));
    expect(calls.flatMap(([, args]) => args)).not.toContain("prompt");
    expect(calls.filter(([, args]) => args.includes("start"))).toEqual([["herdr", ["agent", "start", "--help"]]]);
  });

  it.each([
    ["old version", "--version", "herdr 0.8.2\n", "herdr.version"],
    ["malformed version", "--version", "version unknown\n", "herdr.version"],
    ["missing native kind", "agent start --help", "[possible values: pi, codex]\n", "herdr.agent.traex"],
    ["stale integration", "integration status", "traex: outdated (v0) (/hooks/traex)\n", "herdr.integration.traex"],
    ["missing integration", "integration status", "codex: current (v8) (/hooks/codex)\n", "herdr.integration.traex"]
  ])("fails the %s capability independently", async (_name, failingCommand, output, expectedId) => {
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[1] === "list") return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "Demo Space" }] } });
      if (args[1] === "get") return json({ id: "get", result: { type: "workspace_info", workspace: { workspace_id: "w1", label: "Demo Space" } } });
      const command = args.join(" ");
      if (command === failingCommand) return { stdout: output, stderr: "" };
      if (command === "--version") return { stdout: "herdr 0.9.0\n", stderr: "" };
      if (command === "agent start --help") return { stdout: "[possible values: pi, codex, traex]\n", stderr: "" };
      if (command === "integration status") return { stdout: "traex: current (v1) (/hooks/traex)\n", stderr: "" };
      throw new Error(`unexpected command ${command}`);
    } };
    const checks = await new HerdrSetupProbe(runner, "herdr", 500, {}).check(draft, context);
    expect(checks).toContainEqual(expect.objectContaining({ id: expectedId, status: "fail", remediation: expect.any(String) }));
  });

  it("marks only a live HERDR_WORKSPACE_ID as current", async () => {
    const runner: CommandRunner = { async run() { return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "One" }, { workspace_id: "w2", label: "Two" }] } }); } };
    expect(await new HerdrSetupProbe(runner, "herdr", 500, { HERDR_WORKSPACE_ID: "w2" }).listWorkspaces()).toEqual([
      { id: "w1", name: "One", current: false }, { id: "w2", name: "Two", current: true }
    ]);
    expect((await new HerdrSetupProbe(runner, "herdr", 500, { HERDR_WORKSPACE_ID: "missing" }).listWorkspaces()).every((workspace) => !workspace.current)).toBe(true);
  });

  it("returns bounded failures for malformed output and unavailable Herdr", async () => {
    const malformed: CommandRunner = { async run() { return { stdout: "not-json", stderr: "private detail" }; } };
    await expect(new HerdrSetupProbe(malformed, "herdr", 500).listWorkspaces()).rejects.toThrow(/valid workspace data/);
    const unavailable: CommandRunner = { async run() { throw new Error("spawn ENOENT with host detail"); } };
    expect(await new HerdrSetupProbe(unavailable, "herdr", 500).check(draft, context)).toEqual([expect.objectContaining({ id: "herdr.available", status: "fail" })]);
  });

  it.each([
    ["missing workspace", [{ workspace_id: "w2", label: "Other" }], "Demo Space", "herdr.workspace.demo"],
    ["space mismatch", [{ workspace_id: "w1", label: "Other" }], "Demo Space", "herdr.workspace.demo"]
  ])("reports %s", async (_name, workspaces, spaceName, expectedId) => {
    const changed = structuredClone(draft);
    changed.registry.projects[0]!.spaceName = spaceName;
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[1] === "list") return json({ id: "list", result: { type: "workspace_list", workspaces } });
      if (args[1] === "get") return json({ id: "get", result: { type: "workspace_info", workspace: workspaces[0] } });
      return { stdout: "", stderr: "" };
    } };
    expect(await new HerdrSetupProbe(runner, "herdr", 500, {}).check(changed, context)).toContainEqual(expect.objectContaining({ id: expectedId, status: "fail" }));
  });

});

describe("local setup checks", () => {
  it("reports supported runtime, systemd, private directory, executables, loopback, and free port", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarm-setup-check-"));
    await chmod(directory, 0o700);
    const executable = join(directory, "tool");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o700);
    const localDraft = structuredClone(draft);
    localDraft.environment = { ...localDraft.environment, HERDR_BIN: executable, TRAEX_BIN: executable };
    try {
      const checks = await runLocalSetupChecks(localDraft, { ...context, configDirectory: directory }, {
        runner: { async run() { return { stdout: "", stderr: "" }; } }, nodeVersion: "22.12.0", pathValue: "", inspectPort: async () => "free"
      });
      expect(checks.map(({ id, status }) => [id, status])).toEqual([
        ["local.node", "pass"], ["local.systemd", "pass"], ["local.config-directory", "pass"],
        ["local.http-host", "pass"], ["local.http-port", "pass"], ["local.executable.herdr", "pass"], ["local.executable.traex", "pass"]
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails unsupported Node, non-loopback hosts, missing executables, and an unrelated port owner", async () => {
    const changed = structuredClone(draft);
    changed.environment = { ...changed.environment, HERDR_BIN: "missing-herdr", TRAEX_BIN: "missing-traex", BRIDGE_HTTP_HOST: "0.0.0.0" };
    const checks = await runLocalSetupChecks(changed, context, {
      runner: { async run() { throw new Error("no user bus"); } }, nodeVersion: "22.11.9", pathValue: "", inspectPort: async () => "occupied-other", inspectDirectoryMode: async () => 0o755
    });
    for (const id of ["local.node", "local.systemd", "local.config-directory", "local.http-host", "local.http-port", "local.executable.herdr", "local.executable.traex"]) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: "fail", remediation: expect.any(String) }));
    }
  });

  it("accepts a port owned by the matching managed service", async () => {
    const checks = await runLocalSetupChecks(draft, context, {
      runner: { async run() { return { stdout: "", stderr: "" }; } }, inspectPort: async () => "occupied-managed", inspectDirectoryMode: async () => 0o700, resolveExecutable: () => "/bin/tool"
    });
    expect(checks).toContainEqual(expect.objectContaining({ id: "local.http-port", status: "pass" }));
  });
});
