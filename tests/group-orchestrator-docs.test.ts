import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("group Orchestrator documentation", () => {
  it("keeps the public configuration example compatibility-safe", () => {
    const registry = JSON.parse(read("config/projects.example.json")) as { projects: Array<{ orchestrator?: unknown }> };
    expect(registry.projects[0]?.orchestrator).toEqual({ enabled: false, cwd: "/absolute/path/to/orchestrator/root" });
  });

  it("documents fixed-thread use and the stable-identity clear boundary", () => {
    const usage = read("docs/feishu-group-usage.md");
    expect(usage).toContain("/swarm clear");
    expect(usage).toContain("Pane ID、token、名称、位置、Binding、Thread 和 Workers");
    expect(usage).toContain("partial");
    expect(usage).toContain("固定 Orchestrator Thread");
  });

  it("publishes a gated rollout handoff without claiming live mutation", () => {
    const readme = read("README.md");
    const handoff = read("docs/agents/group-orchestrator-rollout.md");
    const plan = read("docs/spec-coder/plans/2026-10-02-group-orchestrator.md");
    expect(readme).toContain("docs/agents/group-orchestrator-rollout.md");
    expect(handoff).toContain("${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm/projects.json");
    const privateConfig = "/home/example/.config/herdr-agent-swarm/projects.json";
    const orchestratorCwd = "/workspace";
    expect(plan).toContain(privateConfig);
    expect(plan).toContain(`orchestrator.cwd=${orchestratorCwd}`);
    expect(handoff).toContain("e71415fc");
    expect(handoff).toContain("tab create --help");
    expect(handoff).toContain("pane identity-reconcile --help");
    expect(handoff).toContain("native token `orch`");
    expect(handoff).toContain("label `herdr`");
    const capability = handoff.indexOf("session-rotate --help");
    const install = handoff.indexOf("./install.sh");
    const registry = handoff.indexOf("config:validate");
    const approval = handoff.indexOf("Obtain explicit");
    const restart = handoff.lastIndexOf("swarm:restart");
    expect(capability).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(capability);
    expect(registry).toBeGreaterThan(install);
    expect(approval).toBeGreaterThan(registry);
    expect(restart).toBeGreaterThan(approval);
    expect(handoff).toContain("显式批准");
    expect(handoff).toContain("本文件未修改 live 配置、未安装、未重启");
  });

  it("records the durable architecture and capability-detection contract", () => {
    const architecture = read("docs/architecture.md");
    expect(architecture).toContain("OrchestratorClearOperation");
    expect(architecture).toContain("sessionEpoch");
    expect(architecture).toContain("message.delete");
    expect(architecture).toContain("agent session-rotate --help");
    expect(architecture).toContain("pane.identity_reconcile.v1");
    expect(architecture).toContain("native Core Pane token must equal `orch`");
  });
});
