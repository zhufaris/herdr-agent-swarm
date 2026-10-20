import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { ControllerAgentManager } from "../src/runtime/controller-agent-manager.js";
import { CONTROLLER_DISALLOWED_TOOLS, controllerAgentArguments } from "../src/runtime/controller-agent-manager.js";

describe("controllerAgentArguments", () => {
  it("allows only the Controller MCP tools and explicitly denies ambient capabilities", () => {
    const args = controllerAgentArguments("node", ["controller-tools"]);
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]));
    expect(args.filter((value) => value === "--allowed-tool")).toHaveLength(3);
    expect(optionValues(args, "--allowed-tool")).toEqual([
      "mcp__herdr_swarm_controller__get_interpretation_context",
      "mcp__herdr_swarm_controller__inspect_swarm_target",
      "mcp__herdr_swarm_controller__submit_interpretation",
    ]);
    expect(optionValues(args, "--disallowed-tool")).toEqual(CONTROLLER_DISALLOWED_TOOLS);
    expect(CONTROLLER_DISALLOWED_TOOLS).toEqual(expect.arrayContaining([
      "exec", "functions.exec", "multi_tool_use.parallel", "exec_command",
      "apply_patch", "Read", "Write", "web_search",
      "browser_use", "request_user_input", "spawn_agent",
      "collaboration__spawn_agent", "update_plan",
    ]));
    expect(CONTROLLER_DISALLOWED_TOOLS).not.toContain(expect.stringContaining("herdr_swarm_controller"));
  });
});

describe("ControllerAgentManager lifecycle", () => {
  it("coalesces concurrent starts and waits for startup before stopping", async () => {
    let releasePane!: () => void;
    const pane = new Promise<void>((resolve) => { releasePane = resolve; });
    const store = {
      recoverControllerInterpretations: vi.fn(() => 0),
      getControllerRuntime: vi.fn(() => null),
      saveControllerRuntime: vi.fn((runtime) => runtime),
      listPanes: vi.fn(async () => []),
      createPane: vi.fn(async () => { await pane; return { paneId: "controller-pane", workspaceId: "w1", cwd: "/repo" }; }),
      startAgent: vi.fn(async () => undefined),
      getPane: vi.fn(async () => ({ paneId: "controller-pane", workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "working", agentKind: "traex", terminalId: "terminal", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session" }, foregroundExecutables: ["traex"] })),
      claimNextControllerInterpretation: vi.fn(() => null)
    };
    const manager = new ControllerAgentManager({
      store: store as never, herdr: store as never,
      project: { id: "p", displayName: "P", description: "P", workspaceId: "w1", cwd: "/repo" } as never,
      traexExecutable: "traex", mcpCommand: "node", mcpArgs: [], turnTimeoutMs: 100, logger: pino({ enabled: false })
    });

    const first = manager.start();
    const second = manager.start();
    const stopping = manager.stop();
    releasePane();
    await Promise.all([first, second, stopping]);
    expect(store.createPane).toHaveBeenCalledOnce();
    expect(store.startAgent).toHaveBeenCalledOnce();
  });
});

function optionValues(args: readonly string[], option: string): string[] {
  return args.flatMap((value, index) => value === option ? [args[index + 1]!] : []);
}
