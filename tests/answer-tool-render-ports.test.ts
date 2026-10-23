import { describe, expect, it } from "vitest";
import type { AnswerTimelineToolCategory } from "../src/domain/answer-timeline.js";
import { ANSWER_TOOL_RENDER_PORTS, projectAnswerToolRenderGroup, projectAnswerToolRenderModel } from "../src/cards/answer-tool-render-ports.js";

const categories: Array<[AnswerTimelineToolCategory, string, string]> = [
  ["read", "📖", "Read"],
  ["search", "🔍", "Search"],
  ["edit", "✏️", "Edit"],
  ["command", "⚙️", "Command"],
  ["test", "🧪", "Test"],
  ["skill", "🧩", "Skill"],
  ["tool", "🔧", "Tool"],
  ["step", "🛠️", "Step"]
];

describe("Answer Tool render ports", () => {
  it.each(categories)("gives %s an independent semantic render port", (category, icon, label) => {
    const port = ANSWER_TOOL_RENDER_PORTS[category];
    expect(port).toMatchObject({ category, icon, label });
    expect(port.project({ kind: "tool", id: `tool:${category}`, sequence: 1, category, label: "target", command: "run", result: "output", state: "succeeded" }))
      .toMatchObject({ category, icon, label, target: "target" });
  });

  it("registers a distinct port object for every Tool category", () => {
    expect(new Set(Object.values(ANSWER_TOOL_RENDER_PORTS)).size).toBe(categories.length);
  });

  it("lets the Skill port hide Command and Result content", () => {
    expect(projectAnswerToolRenderModel({
      kind: "tool", id: "tool:skill", sequence: 1, category: "skill", label: "herdr",
      command: "read SKILL.md", result: "private instructions", state: "succeeded"
    })).toEqual({ category: "skill", icon: "🧩", label: "Skill", target: "herdr", summary: "Loaded skill herdr", state: "succeeded" });
  });

  it("prefers semantic action, target, and result summary while retaining legacy fallbacks", () => {
    expect(projectAnswerToolRenderModel({
      kind: "tool", id: "tool:semantic", sequence: 1, category: "command", label: "legacy label",
      action: "Build", target: "npm run build", resultSummary: { outcome: "timeout", text: "deadline exceeded" }, state: "failed"
    })).toMatchObject({ label: "Build", target: "npm run build", semantic: true, outcome: "timeout", resultSummaryText: "deadline exceeded" });
    expect(projectAnswerToolRenderModel({
      kind: "tool", id: "tool:legacy", sequence: 2, category: "command", label: "legacy label", command: "npm test", state: "succeeded"
    })).toMatchObject({ label: "Command", target: "legacy label", summary: "Ran npm test" });
  });

  it("keeps private Skill result summaries out of the render model", () => {
    expect(projectAnswerToolRenderModel({
      kind: "tool", id: "tool:skill-summary", sequence: 1, category: "skill", label: "herdr",
      resultSummary: { outcome: "failure", text: "private skill instructions" }, state: "failed"
    })).not.toMatchObject({ result: expect.anything(), outcome: expect.anything() });
  });

  it("lets the Step port hide internal update_plan activity", () => {
    expect(projectAnswerToolRenderModel({
      kind: "tool", id: "tool:plan", sequence: 1, category: "step", label: "update_plan", result: "{}", state: "succeeded"
    })).toBeNull();
  });

  it("summarizes one nested Search and Read group with Herdr wording", () => {
    const parent = { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "running" } as const;
    const children = [
      { kind: "tool", id: "tool:search", parentToolId: parent.id, sequence: 2, category: "search", label: '"releaseUndispatchedPromptClaim" in sqlite', state: "running" },
      { kind: "tool", id: "tool:read-1", parentToolId: parent.id, sequence: 3, category: "read", label: "src/store/sqlite/prompt-recovery-store.ts (1-240)", state: "running" },
      { kind: "tool", id: "tool:read-2", parentToolId: parent.id, sequence: 4, category: "read", label: "src/coordinator/prompt-turn-executor.ts (1-220)", state: "running" }
    ] as const;

    expect(projectAnswerToolRenderGroup(parent, children)).toMatchObject({
      summary: 'Searching for "releaseUndispatchedPromptClaim" in sqlite, reading 2 files…',
      state: "running",
      members: [
        { category: "search", target: '"releaseUndispatchedPromptClaim" in sqlite' },
        { category: "read", target: "src/store/sqlite/prompt-recovery-store.ts (1-240)" },
        { category: "read", target: "src/coordinator/prompt-turn-executor.ts (1-220)" }
      ]
    });
  });

  it("summarizes a completed nested Read group and keeps each file detail", () => {
    const parent = { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" } as const;
    const children = [
      { kind: "tool", id: "tool:read-1", parentToolId: parent.id, sequence: 2, category: "read", label: "src/one.ts (1-80)", state: "succeeded" },
      { kind: "tool", id: "tool:read-2", parentToolId: parent.id, sequence: 3, category: "read", label: "src/two.ts (20-40)", state: "succeeded" }
    ] as const;

    expect(projectAnswerToolRenderGroup(parent, children)).toMatchObject({
      summary: "Read 2 files",
      members: [{ target: "src/one.ts (1-80)" }, { target: "src/two.ts (20-40)" }]
    });
  });

  it("summarizes a nested Edit while preserving its change counts", () => {
    const parent = { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" } as const;
    const children = [
      { kind: "tool", id: "tool:edit", parentToolId: parent.id, sequence: 2, category: "edit", label: "src/runtime/herdr-events-reader.ts (+9 -52)", state: "succeeded" }
    ] as const;

    expect(projectAnswerToolRenderGroup(parent, children)).toMatchObject({
      summary: "Edited src/runtime/herdr-events-reader.ts (+9 -52)",
      members: [{ category: "edit", target: "src/runtime/herdr-events-reader.ts (+9 -52)" }]
    });
  });

  it("summarizes Skill use without exposing the loaded instructions", () => {
    const parent = { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" } as const;
    const children = [
      { kind: "tool", id: "tool:skill", parentToolId: parent.id, sequence: 2, category: "skill", label: "tdd", result: "private skill instructions", state: "succeeded" }
    ] as const;

    expect(projectAnswerToolRenderGroup(parent, children)).toEqual({
      summary: "Loaded skill tdd",
      state: "succeeded",
      members: [{ category: "skill", icon: "🧩", label: "Skill", target: "tdd", summary: "Loaded skill tdd", state: "succeeded", nested: true }]
    });
  });

  it("summarizes a completed nested Command with the Herdr Ran verb", () => {
    const parent = { kind: "tool", id: "tool:exec", sequence: 1, category: "tool", label: "exec", state: "succeeded" } as const;
    const children = [
      { kind: "tool", id: "tool:command", parentToolId: parent.id, sequence: 2, category: "command", label: "npm run typecheck", command: "npm run typecheck", state: "succeeded" }
    ] as const;

    expect(projectAnswerToolRenderGroup(parent, children)).toMatchObject({
      summary: "Ran npm run typecheck",
      members: [{ category: "command", command: "npm run typecheck" }]
    });
  });

  it.each([
    ["read", "src/main.ts", undefined, "running", "Reading src/main.ts…"],
    ["search", '"claimPrompt" in sqlite', undefined, "succeeded", 'Searched for "claimPrompt" in sqlite'],
    ["edit", "src/main.ts (+9 -52)", undefined, "succeeded", "Edited src/main.ts (+9 -52)"],
    ["command", "Run · npm", "npm test", "succeeded", "Ran npm test"],
    ["test", "Test · project", "npm test", "running", "Running npm test…"],
    ["skill", "tdd", undefined, "succeeded", "Loaded skill tdd"]
  ] as const)("gives a standalone %s Tool a Herdr-style semantic summary", (category, label, command, state, summary) => {
    expect(projectAnswerToolRenderModel({
      kind: "tool", id: `tool:${category}`, sequence: 1, category, label,
      ...(command ? { command } : {}), state
    })).toMatchObject({ summary });
  });
});
