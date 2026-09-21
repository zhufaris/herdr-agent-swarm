import { describe, expect, it } from "vitest";
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

function optionValues(args: readonly string[], option: string): string[] {
  return args.flatMap((value, index) => value === option ? [args[index + 1]!] : []);
}
