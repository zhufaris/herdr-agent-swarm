import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT,
  COMPLETION_CHOICE_REPAIR_REASON,
  handleCompletionChoiceStop,
  handleCompletionChoiceUserPromptSubmit,
  type CompletionChoiceHookEnvironment
} from "../src/runtime/completion-choice-hook.js";

const root = resolve(import.meta.dirname, "..");
const eligibleEnvironment: CompletionChoiceHookEnvironment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "workspace:pane"
};

function validProtocol(): string {
  return [
    "```herdr-choice-list",
    JSON.stringify({
      version: 3,
      choice: {
        question: "Choose the next step.",
        defaultOption: { id: "option-1", label: "方案 1（默认）", submitText: "继续方案 1" },
        alternatives: [{ id: "option-2", label: "方案 2", submitText: "继续方案 2" }]
      }
    }),
    "```"
  ].join("\n");
}

function legacyProtocol(): string {
  return [
    "```herdr-choice-list",
    JSON.stringify({
      version: 1,
      default: "option-1",
      options: [
        { id: "option-1", label: "方案 1（默认）", message: "default" },
        { id: "option-2", label: "方案 2", message: "2" }
      ]
    }),
    "```"
  ].join("\n");
}

function validNoneProtocol(): string {
  return "```herdr-choice-list\n{\"version\":3}\n```";
}

function reportedReviewListProtocol(): string {
  return [
    "```herdr-choice-list",
    JSON.stringify({
      version: 3,
      intent: "review",
      choices: [
        { id: "A", label: "批准 Gate 3", consequence: "立即按 W1/T1 开始 TDD 实现和验证，提交前另行确认 commit message" },
        { id: "B", label: "修改计划", consequence: "停在 Gate 3，修订 ticket plan 后重新审批" },
        { id: "C", label: "拒绝并停止", consequence: "保留隔离 worktree，不开始实现" }
      ]
    }),
    "```"
  ].join("\n");
}

describe("herdr choice list plugin contract", () => {
  it("discovers one Skill and synchronous submit and Stop command Hooks", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "plugins/herdr-choice-list/.codex-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
    const hooks = JSON.parse(readFileSync(resolve(root, "plugins/herdr-choice-list/hooks/hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };

    expect(manifest).toMatchObject({ name: "herdr-choice-list", version: "1.0.0", skills: "./skills/", hooks: "./hooks/hooks.json" });
    expect(Object.keys(hooks.hooks)).toEqual(["UserPromptSubmit", "Stop"]);
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining("${PLUGIN_ROOT}/scripts/herdr-choice-stop-hook.mjs"),
        timeout: 5
      })
    ]);
    expect(hooks.hooks.Stop).toHaveLength(1);
    expect(hooks.hooks.Stop?.[0]?.hooks).toEqual([
      expect.objectContaining({
        type: "command",
        command: expect.stringContaining("${PLUGIN_ROOT}/scripts/herdr-choice-stop-hook.mjs"),
        timeout: 5
      })
    ]);
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toContain("${PLUGIN_DATA}");
    expect(hooks.hooks.Stop?.[0]?.hooks[0]).not.toHaveProperty("async", true);
  });

  it("keeps every repository-owned producer on the version 3 collective-envelope contract", () => {
    const skill = readFileSync(resolve(root, "plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md"), "utf8");
    expect(skill).toContain("original final answer");
    expect(skill).toContain("exactly one version-3");
    expect(skill).toContain("terminal memory citation may follow the choice fence");
    expect(skill).toContain('"version":3');
    expect(skill).toContain('"submitText":"Continue with option 1"');
    expect(skill).not.toMatch(/"intent"|"default"|"message"/);
    expect(skill).toContain("1 to 4");
    expect(skill).toContain("Ignore");
    expect(skill).toContain("Do not include other choice-shaped JSON examples");
    expect(skill).toContain("```herdr-choice-list");
    const metadata = readFileSync(resolve(root, "plugins/herdr-choice-list/skills/herdr-choice-list/agents/openai.yaml"), "utf8");
    expect(metadata).toContain("allow_implicit_invocation: false");
    expect(metadata).toContain("$herdr-choice-list:herdr-choice-list");
    expect(metadata).toContain("version-3");
    expect(metadata).toContain("submitText");
    expect(metadata).toContain("optional terminal memory citation");
    expect(metadata).not.toMatch(/version-2|"intent"|"default"|"message"/);

    const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("version-3 `herdr-choice-list`");
    expect(agents).toContain("terminal memory citation may follow the choice fence");
    expect(agents).not.toMatch(/version-2 `herdr-choice-list`|explicit `intent: "none"`/);
  });

  it("keeps every owned protocol example on one compact JSON line", () => {
    const skill = readFileSync(resolve(root, "plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md"), "utf8");
    const blocks = [...skill.matchAll(/```herdr-choice-list\n([^\n]+)\n```/g)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const json of blocks) {
      expect(JSON.stringify(JSON.parse(json))).toBe(json);
    }
  });
});

describe("completion choice UserPromptSubmit Hook", () => {
  it("adds constant inline context for an eligible Swarm-managed turn without sending its prompt", async () => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceUserPromptSubmit({
      hook_event_name: "UserPromptSubmit",
      prompt: "Choose the deployment strategy."
    }, eligibleEnvironment, eligibility)).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT
      }
    });
    expect(eligibility).toHaveBeenCalledWith({ paneId: "workspace:pane" });
    expect(JSON.stringify(eligibility.mock.calls)).not.toContain("deployment strategy");
  });

  it("instructs only the embedded version 3 shape and forbids legacy sentinels", () => {
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("version-3");
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("defaultOption");
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("submitText");
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("do not emit intent, default, message");
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("exactly one terminal");
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("ordinary JSON examples");
    expect(COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT).toContain("optional terminal memory citation");
  });

  it.each([
    null,
    { hook_event_name: "Stop", prompt: "answer" },
    { hook_event_name: "UserPromptSubmit", prompt: 42 },
    { hook_event_name: "UserPromptSubmit", prompt: "x".repeat(128 * 1024 + 1) }
  ])("fails open without checking eligibility for malformed submit input", async (payload) => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceUserPromptSubmit(payload, eligibleEnvironment, eligibility)).resolves.toEqual({});
    expect(eligibility).not.toHaveBeenCalled();
  });

  it("fails open when submit identity is absent or eligibility is unavailable", async () => {
    const payload = { hook_event_name: "UserPromptSubmit", prompt: "answer" };
    await expect(handleCompletionChoiceUserPromptSubmit(payload, {}, vi.fn().mockResolvedValue(true))).resolves.toEqual({});
    await expect(handleCompletionChoiceUserPromptSubmit(payload, eligibleEnvironment, vi.fn().mockResolvedValue(false))).resolves.toEqual({});
    await expect(handleCompletionChoiceUserPromptSubmit(payload, eligibleEnvironment, vi.fn().mockRejectedValue(new Error("socket unavailable")))).resolves.toEqual({});
  });
});

describe("completion choice Stop Hook", () => {
  const repairReason = COMPLETION_CHOICE_REPAIR_REASON;

  it.each([
    "The implementation is complete.",
    "检测到一个 trace 最终 assistant message 末尾：请选择方案 1、2 或 3；回复 default 即选择方案 1。"
  ])("blocks an eligible final answer once when its terminal protocol is missing: %s", async (lastAssistantMessage) => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceStop({ last_assistant_message: lastAssistantMessage, stop_hook_active: false }, eligibleEnvironment, eligibility)).resolves.toEqual({
      decision: "block",
      reason: expect.stringMatching(/compact.*herdr-choice-list/is)
    });
    expect(eligibility).toHaveBeenCalledWith({ paneId: "workspace:pane" });
  });

  it("allows valid version 3 terminal decisions", async () => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceStop({ last_assistant_message: validProtocol(), stop_hook_active: false }, eligibleEnvironment, eligibility)).resolves.toEqual({});
    await expect(handleCompletionChoiceStop({ last_assistant_message: validNoneProtocol(), stop_hook_active: false }, eligibleEnvironment, eligibility)).resolves.toEqual({});
  });

  it("allows the bounded alternate version 3 review list reported by a final trace", async () => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceStop({
      last_assistant_message: reportedReviewListProtocol(),
      stop_hook_active: false
    }, eligibleEnvironment, eligibility)).resolves.toEqual({});
    expect(eligibility).toHaveBeenCalledWith({ paneId: "workspace:pane" });
  });

  it("allows a valid version 3 decision followed by one terminal memory citation", async () => {
    const citation = [
      "<oai-mem-citation>",
      "<citation_entries>MEMORY.md:1-1|note=[evidence]</citation_entries>",
      "<rollout_ids>019dbb13-b7a0-7000-8000-000000000001</rollout_ids>",
      "</oai-mem-citation>"
    ].join("\n");
    const answer = `Visible answer.\n\n${validProtocol()}\n\n${citation}`;

    await expect(handleCompletionChoiceStop({
      last_assistant_message: answer,
      stop_hook_active: false
    }, eligibleEnvironment, vi.fn().mockResolvedValue(true))).resolves.toEqual({});
  });

  it("allows arbitrary decision-shaped prose with a valid version 3 no-choice protocol", async () => {
    const prose = "**Choose A or B**, 请批准发布；then do not choose, and later choose option C.";
    const answer = `${prose}\n\n${validNoneProtocol()}`;
    await expect(handleCompletionChoiceStop({ last_assistant_message: answer, stop_hook_active: false }, eligibleEnvironment, vi.fn().mockResolvedValue(true))).resolves.toEqual({});
  });

  it("allows an assistant message at 128 KiB and blocks one byte over after eligibility", async () => {
    const protocol = validNoneProtocol();
    const separator = "\n\n";
    const atLimit = `${"x".repeat(128 * 1024 - Buffer.byteLength(separator + protocol, "utf8"))}${separator}${protocol}`;
    const overLimit = `${atLimit}x`;
    const eligibility = vi.fn().mockResolvedValue(true);

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(128 * 1024);
    expect(Buffer.byteLength(overLimit, "utf8")).toBe(128 * 1024 + 1);
    await expect(handleCompletionChoiceStop({ last_assistant_message: atLimit, stop_hook_active: false }, eligibleEnvironment, eligibility)).resolves.toEqual({});
    await expect(handleCompletionChoiceStop({ last_assistant_message: overLimit, stop_hook_active: false }, eligibleEnvironment, eligibility)).resolves.toEqual({
      decision: "block",
      reason: repairReason
    });
    expect(eligibility).toHaveBeenCalledTimes(2);

    const unavailableEligibility = vi.fn().mockResolvedValue(false);
    await expect(handleCompletionChoiceStop({ last_assistant_message: overLimit, stop_hook_active: false }, eligibleEnvironment, unavailableEligibility)).resolves.toEqual({});
    expect(unavailableEligibility).toHaveBeenCalledWith({ paneId: "workspace:pane" });
  });

  it.each([
    ["malformed", "```herdr-choice-list\n{not json}\n```"],
    ["nonterminal", `${validNoneProtocol()}\n\nTrailing prose.`],
    ["multiple", `${validNoneProtocol()}\n\n${validNoneProtocol()}`],
    ["incomplete", "Answer.\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"none\"}"],
    ["oversized", `\`\`\`herdr-choice-list\n${JSON.stringify({ version: 2, intent: "none", padding: "x".repeat(8 * 1024) })}\n\`\`\``],
    ["legacy-version-1", legacyProtocol()],
    ["legacy-version-2", "```herdr-choice-list\n{\"version\":2,\"intent\":\"none\"}\n```"]
  ])("blocks a %s terminal protocol once with one constant payload-free repair", async (_name, invalid) => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceStop({ last_assistant_message: invalid, stop_hook_active: false }, eligibleEnvironment, eligibility)).resolves.toEqual({
      decision: "block",
      reason: repairReason
    });
    await expect(handleCompletionChoiceStop({ last_assistant_message: invalid, stop_hook_active: true }, eligibleEnvironment, eligibility)).resolves.toEqual({});
  });

  it("keeps the repair reason bounded and free of Answer payload", async () => {
    const privateAnswer = "private-answer-payload-7a91";
    const response = await handleCompletionChoiceStop({ last_assistant_message: privateAnswer, stop_hook_active: false }, eligibleEnvironment, vi.fn().mockResolvedValue(true));
    expect(response).toEqual({ decision: "block", reason: repairReason });
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(512);
    expect(JSON.stringify(response)).not.toContain(privateAnswer);
  });

  it("repairs with the embedded version 3 shape only", () => {
    expect(repairReason).toContain("version 3");
    expect(repairReason).toContain("defaultOption");
    expect(repairReason).toContain("submitText");
    expect(repairReason).toContain("do not emit intent, default, message");
  });

  it("unconditionally allows a repeated Stop without consulting eligibility", async () => {
    const eligibility = vi.fn().mockRejectedValue(new Error("must not run"));
    await expect(handleCompletionChoiceStop({ last_assistant_message: "请选择方案 1 或 2", stop_hook_active: true }, {}, eligibility)).resolves.toEqual({});
    expect(eligibility).not.toHaveBeenCalled();
  });

  it.each([
    [null, eligibleEnvironment],
    [{ last_assistant_message: 42, stop_hook_active: false }, eligibleEnvironment],
    [{ last_assistant_message: "请选择方案 1 或 2", stop_hook_active: false }, { ...eligibleEnvironment, HERDR_ENV: "0" }],
    [{ last_assistant_message: "请选择方案 1 或 2", stop_hook_active: false }, { ...eligibleEnvironment, HERDR_PANE_ID: undefined }]
  ])("fails open for malformed payload or missing identity", async (payload, environment) => {
    const eligibility = vi.fn().mockResolvedValue(true);
    await expect(handleCompletionChoiceStop(payload, environment, eligibility)).resolves.toEqual({});
    expect(eligibility).not.toHaveBeenCalled();
  });

  it("fails open when the eligibility helper rejects or returns false", async () => {
    const payload = { last_assistant_message: "请选择方案 1 或 2；回复 default 即选择方案 1。", stop_hook_active: false };
    await expect(handleCompletionChoiceStop(payload, eligibleEnvironment, vi.fn().mockResolvedValue(false))).resolves.toEqual({});
    await expect(handleCompletionChoiceStop(payload, eligibleEnvironment, vi.fn().mockRejectedValue(new Error("socket unavailable")))).resolves.toEqual({});
  });
});
