import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HerdrSetupProbe, type HerdrCapabilityReader } from "../src/adapters/herdr-setup-probe.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { runLocalSetupChecks } from "../src/setup/setup-checks.js";
import type { SetupContext, SetupDraft } from "../src/setup/setup-types.js";

const context: SetupContext = { root: "/app", configDirectory: "/config", stateDirectory: "/state", serviceName: "herdr-agent-swarm.service", cwd: "/repo" };
const draft: SetupDraft = {
  environment: { HERDR_BIN: "herdr", TRAEX_BIN: "traex", BRIDGE_HTTP_HOST: "127.0.0.1", BRIDGE_HTTP_PORT: "8787" },
  registry: { defaultProjectId: "demo", projects: [{ id: "demo", displayName: "Demo", description: "Demo", workspaceId: "w1", spaceName: "Demo Space", cwd: "/repo", instances: [{ name: "primary", role: "primary", agent: "traex", workspace: { kind: "main-checkout" } }] }] }
};

function json(value: unknown) { return { stdout: JSON.stringify(value), stderr: "" }; }

describe("Herdr setup probe", () => {
  it("discovers the workspace and validates TraeX through the ready shim without requiring a native kind", async () => {
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = { async run(executable, args) {
      calls.push([executable, args]);
      if (args.join(" ") === "workspace list") return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "Demo Space", focused: true }] } });
      if (args.join(" ") === "workspace get w1") return json({ id: "get", result: { type: "workspace_info", workspace: { workspace_id: "w1", label: "Demo Space" } } });
      if (executable === "bash") return { stdout: "status: ready\nrelease: abc123\nherdr: 0.7.5\ntraex: 0.201.6(internal edition)\n", stderr: "" };
      throw new Error("unexpected command");
    } };
    const capabilityReader: HerdrCapabilityReader = { async read(executable, args) {
      calls.push([executable, args]);
      return { exitCode: 2, stdout: realAgentUsage, stderr: "" };
    } };
    const probe = new HerdrSetupProbe(runner, "herdr", 500, { PATH: process.env.PATH }, capabilityReader);

    expect(await probe.check(draft, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "herdr.available", status: "pass" }),
      expect.objectContaining({ id: "herdr.workspace.demo", status: "pass" }),
      expect.objectContaining({ id: "herdr.agent.traex", status: "pass" })
    ]));
    expect(calls).toEqual([
      ["herdr", ["workspace", "list"]], ["herdr", ["workspace", "get", "w1"]],
      ["bash", ["/app/scripts/install-herdr-traex-shim.sh", "status"]]
    ]);
    expect(calls.flatMap(([, args]) => args)).not.toContain("start");
    expect(calls.flatMap(([, args]) => args)).not.toContain("prompt");
  });

  it("fails TraeX when the shim is not ready", async () => {
    const runner: CommandRunner = { async run(executable, args) {
      if (args[1] === "list") return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "Demo Space" }] } });
      if (args[1] === "get") return json({ id: "get", result: { type: "workspace_info", workspace: { workspace_id: "w1", label: "Demo Space" } } });
      if (executable === "bash") return { stdout: "status: not installed\n", stderr: "" };
      throw new Error("unexpected command");
    } };
    const capabilityReader: HerdrCapabilityReader = { async read() { return { exitCode: 2, stdout: realAgentUsage, stderr: "" }; } };
    const checks = await new HerdrSetupProbe(runner, "herdr", 500, {}, capabilityReader).check(draft, context);
    expect(checks).toContainEqual(expect.objectContaining({ id: "herdr.agent.traex", status: "fail", remediation: expect.stringContaining("install-herdr-traex-shim.sh install") }));
  });

  it("accepts exit-2 agent usage and maps claude-code to the native claude kind", async () => {
    const changed = structuredClone(draft);
    changed.registry.projects[0]!.instances = [{ name: "primary", role: "primary", agent: "claude-code", workspace: { kind: "main-checkout" } }];
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[1] === "list") return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "Demo Space" }] } });
      return json({ id: "get", result: { type: "workspace_info", workspace: { workspace_id: "w1", label: "Demo Space" } } });
    } };
    const capabilityReader: HerdrCapabilityReader = { async read() { return { exitCode: 2, stdout: realAgentUsage, stderr: "" }; } };
    const checks = await new HerdrSetupProbe(runner, "herdr", 500, {}, capabilityReader).check(changed, context);
    expect(checks).toContainEqual(expect.objectContaining({ id: "herdr.agent.claude-code", status: "pass" }));
    expect(checks).not.toContainEqual(expect.objectContaining({ id: "herdr.agent-capabilities", status: "fail" }));
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
    const capabilityReader: HerdrCapabilityReader = { async read() { return { exitCode: 2, stdout: realAgentUsage, stderr: "" }; } };
    expect(await new HerdrSetupProbe(runner, "herdr", 500, {}, capabilityReader).check(changed, context)).toContainEqual(expect.objectContaining({ id: expectedId, status: "fail" }));
  });

  it("reports unsupported agent kinds and unavailable selected executables", async () => {
    const changed = structuredClone(draft);
    changed.registry.projects[0]!.instances = [
      { name: "primary", role: "primary", agent: "traex", workspace: { kind: "main-checkout" } },
      { name: "worker", role: "worker", agent: "codex", workspace: { kind: "git-worktree", baseRef: "HEAD" } }
    ];
    changed.environment.CODEX_BIN = "missing-codex";
    const runner: CommandRunner = { async run(_executable, args) {
      if (args[1] === "list") return json({ id: "list", result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "Demo Space" }] } });
      if (args[1] === "get") return json({ id: "get", result: { type: "workspace_info", workspace: { workspace_id: "w1", label: "Demo Space" } } });
      if (_executable === "bash") return { stdout: "status: ready\n", stderr: "" };
      return { stdout: "", stderr: "" };
    } };
    const capabilityReader: HerdrCapabilityReader = { async read() { return { exitCode: 2, stdout: realAgentUsage.replace("|codex", ""), stderr: "" }; } };
    const checks = await new HerdrSetupProbe(runner, "herdr", 500, { PATH: "" }, capabilityReader).check(changed, context);
    expect(checks).toContainEqual(expect.objectContaining({ id: "herdr.agent.traex", status: "pass" }));
    expect(checks).toContainEqual(expect.objectContaining({ id: "herdr.agent.codex", status: "fail" }));
  });
});

const realAgentUsage = `herdr agent commands:
  herdr agent list
  herdr agent get <target>
  herdr agent read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--ansi]
  herdr agent send-keys <target> <key> [key ...]
  herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]
  herdr agent rename <target> <name>|--clear
  herdr agent focus <target>
  herdr agent wait <target> [--until STATUS]... [--timeout MS]
  herdr agent attach <target> [--takeover]
  herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]
  herdr agent explain <target> [--json|--format text|json] [--verbose]
  herdr agent explain --file PATH --agent LABEL [--json|--format text|json] [--verbose]
  targets accept unique agent names and pane ids that currently host agents
  kinds: pi|claude|codex|gemini|cursor|devin|agy|cline|omp|mastracode|opencode|copilot|kimi|kiro|droid|amp|grok|hermes|kilo|qodercli|maki`;

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
    changed.registry.projects[0]!.instances!.push({ name: "worker", role: "worker", agent: "codex", workspace: { kind: "git-worktree", baseRef: "HEAD" } });
    changed.environment = { ...changed.environment, HERDR_BIN: "missing-herdr", TRAEX_BIN: "missing-traex", CODEX_BIN: "missing-codex", BRIDGE_HTTP_HOST: "0.0.0.0" };
    const checks = await runLocalSetupChecks(changed, context, {
      runner: { async run() { throw new Error("no user bus"); } }, nodeVersion: "22.11.9", pathValue: "", inspectPort: async () => "occupied-other", inspectDirectoryMode: async () => 0o755
    });
    for (const id of ["local.node", "local.systemd", "local.config-directory", "local.http-host", "local.http-port", "local.executable.herdr", "local.executable.traex", "local.executable.codex"]) {
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
