import { describe, expect, it } from "vitest";
import { DeterministicNaturalLanguageCommandInterpreter } from "../src/domain/natural-language-command.js";

const interpreter = new DeterministicNaturalLanguageCommandInterpreter([
  { id: "datasage", displayName: "DataSage", spaceName: "datasage-space", description: "Data", workspaceId: "w1", cwd: "/repo" }
]);

describe("DeterministicNaturalLanguageCommandInterpreter", () => {
  describe.each([
    ["unsupported controls", [["create new project", "unsupported"], ["创建一个新项目", "unsupported"]]],
    ["exact queries", [["当前状态怎么样", "command"], ["列出所有 pane", "command"], ["查看项目", "command"], ["查看 workers", "command"]]],
    ["ambiguity", [["停一下", "clarification"], ["创建 worker", "clarification"]]],
    ["project and Primary", [["选择项目 DataSage", "command"], ["创建新任务：修复登录", "command"], ["切换项目 missing", "clarification"]]],
    ["Worker", [["创建 reviewer worker 并启动", "command"], ["发送给 worker reviewer: run tests", "command"], ["steer reviewer: focus tests", "command"], ["停止 worker reviewer", "command"]]],
    ["current-session mutations", [["停止当前任务", "command"], ["切换模型 GPT-5.4", "command"], ["关闭当前 pane", "command"], ["确认关闭 ABC123", "command"]]],
    ["task classification", [["帮我实现登录页", "task"], ["fix the flaky test", "task"], ["看看 reviewer 然后决定怎么办", "unresolved"]]]
  ] as const)("%s rules", (_group, cases) => {
    it.each(cases)("preserves %s as %s", (text, outcome) => {
      expect(interpreter.interpret(text)).toMatchObject({ outcome });
    });
  });

  it.each([
    ["当前状态怎么样", { family: "swarm", command: { kind: "status" } }],
    ["选择项目 DataSage", { family: "instance", command: { kind: "project", projectId: "datasage" } }],
    ["创建新任务：修复登录", { family: "swarm", command: { kind: "new", title: "修复登录", agentKind: "traex" } }],
    ["创建 reviewer worker 并启动", { family: "swarm", command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true } }],
    ["发送给 worker reviewer: run tests", { family: "instance", command: { kind: "to", name: "reviewer", text: "run tests" } }],
    ["停止当前任务", { family: "swarm", command: { kind: "stop" } }],
    ["切换模型 GPT-5.4", { family: "swarm", command: { kind: "model", name: "GPT-5.4" } }]
  ])("preserves the exact typed result for %s", (text, expected) => {
    expect(interpreter.interpret(text)).toEqual({ outcome: "command", source: "deterministic", ...expected });
  });
});
