import { describe, expect, it } from "vitest";
import { DeterministicNaturalLanguageCommandInterpreter } from "../src/domain/natural-language-command.js";

const interpreter = new DeterministicNaturalLanguageCommandInterpreter([
  { id: "datasage", displayName: "DataSage", spaceName: "datasage-space", description: "Data", workspaceId: "w1", cwd: "/repo" }
]);

describe("DeterministicNaturalLanguageCommandInterpreter", () => {
  it.each([
    ["当前状态怎么样", { family: "swarm", command: { kind: "status" } }],
    ["列出所有 pane", { family: "swarm", command: { kind: "panes" } }],
    ["查看项目", { family: "swarm", command: { kind: "projects" } }],
    ["查看 workers", { family: "instance", command: { kind: "instances" } }],
    ["选择项目 DataSage", { family: "instance", command: { kind: "project", projectId: "datasage" } }],
    ["创建新任务：修复登录", { family: "swarm", command: { kind: "new", title: "修复登录", agentKind: "traex" } }],
    ["创建 reviewer worker 并启动", { family: "swarm", command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true } }],
    ["发送给 worker reviewer: run tests", { family: "instance", command: { kind: "to", name: "reviewer", text: "run tests" } }],
    ["steer reviewer: focus tests", { family: "instance", command: { kind: "steer_instance", name: "reviewer", text: "focus tests" } }],
    ["停止 worker reviewer", { family: "instance", command: { kind: "stop_instance", name: "reviewer" } }],
    ["停止当前任务", { family: "swarm", command: { kind: "stop" } }],
    ["切换模型 GPT-5.4", { family: "swarm", command: { kind: "model", name: "GPT-5.4" } }],
    ["关闭当前 pane", { family: "swarm", command: { kind: "pane_close_request" } }],
    ["确认关闭 ABC123", { family: "swarm", command: { kind: "pane_close_confirm", code: "ABC123" } }]
  ])("interprets %s", (text, expected) => {
    expect(interpreter.interpret(text)).toMatchObject({ outcome: "command", source: "deterministic", ...expected });
  });

  it("rejects dynamic project creation instead of turning it into a task", () => {
    expect(interpreter.interpret("create new project")).toMatchObject({ outcome: "unsupported" });
    expect(interpreter.interpret("创建一个新项目")).toMatchObject({ outcome: "unsupported" });
  });

  it("keeps explicit engineering work as an ordinary task", () => {
    expect(interpreter.interpret("帮我实现登录页")).toEqual({ outcome: "task", source: "deterministic" });
    expect(interpreter.interpret("fix the flaky test")).toEqual({ outcome: "task", source: "deterministic" });
    expect(interpreter.interpret("看看 reviewer 然后决定怎么办")).toEqual({ outcome: "unresolved" });
  });

  it("clarifies incomplete or command-shaped input without task fallback", () => {
    expect(interpreter.interpret("停一下")).toMatchObject({ outcome: "clarification" });
    expect(interpreter.interpret("创建 worker")).toMatchObject({ outcome: "clarification" });
    expect(interpreter.interpret("切换项目 missing")).toMatchObject({ outcome: "clarification" });
  });
});
