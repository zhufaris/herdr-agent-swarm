import { describe, expect, it } from "vitest";
import { parseHerdrAgentEvent } from "../src/adapters/herdr-events-adapter.js";
import { HerdrEventProjector } from "../src/runtime/herdr-events/event-projector.js";
import { normalizeAndPersistCompletionChoice } from "../src/store/sqlite/completion-choice-store.js";
import type { SqliteContext } from "../src/store/sqlite/context.js";
import { agentEvent } from "./helpers/herdr-events.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

describe("HerdrEventProjector", () => {
  it("removes a native mention and complete terminal choice protocol from visible final output", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:native", "turn-native", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "final-native", channel: "final",
        text: [
          "Done.", "", "<at id=ou_1234567890abcdef></at>", "", "$herdr-choice-list:herdr-choice-list",
          "```herdr-choice-list", '{"version":2,"intent":"none"}', "```"
        ].join("\n"), truncated: false
      }))
    ]);
    expect(projected.answerDelta).toBe("Done.");
    expect(JSON.stringify(projected)).not.toContain("<at id=");
    expect(JSON.stringify(projected)).not.toContain("$herdr-choice-list");
  });

  it("removes terminal choice protocol JSON from visible final output while preserving structured metadata", () => {
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Next?", default: "keep",
      options: [{ id: "keep", label: "Keep", message: "default" }]
    };
    const text = `Visible answer.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``;
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:choice", "turn-choice", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "final-choice", channel: "final", text, truncated: false,
        completion_choice: completionChoice
      }))
    ]);

    expect(projected.answerDelta).toBe("Visible answer.");
    expect(projector.snapshot().completionChoice).toEqual({
      question: "Next?", defaultOption: { id: "keep", label: "Keep", submitText: "default" }, alternatives: []
    });
    expect(projected.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "final_answer", markdown: "Visible answer." })
    ]);
    expect(JSON.stringify(projected)).not.toContain("herdr-choice-list");
  });

  it("projects a v3 final envelope without transport while retaining its terminal citation evidence", () => {
    const choice = {
      version: 3,
      choice: {
        question: "Approve?",
        defaultOption: { id: "approve", label: "Approve", submitText: "Approve the change." },
        alternatives: []
      }
    };
    const citation = "<oai-mem-citation>\n<citation_entries>MEMORY.md:1-1|note=[evidence]</citation_entries>\n<rollout_ids>019dbb13-b7a0-7000-8000-000000000001</rollout_ids>\n</oai-mem-citation>";
    const source = `Visible answer.\n\n$herdr-choice-list:herdr-choice-list\n\`\`\`herdr-choice-list\n${JSON.stringify(choice)}\n\`\`\`\n\n${citation}`;

    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-v3-citation", "turn-v3-citation", "2026-10-16T00:00:00Z", {
        type: "message", message_id: "v3-citation", channel: "final", text: source, truncated: false
      }))
    ]);

    expect(projected.answerDelta).toBe(`Visible answer.\n\n${citation}`);
    expect(projected.timelineDeltas).toEqual([expect.objectContaining({ kind: "final_answer", markdown: `Visible answer.\n\n${citation}` })]);
    expect(JSON.stringify(projected)).not.toContain("herdr-choice-list");
    expect(projected.answerDelta).toContain("oai-mem-citation");
  });

  it("keeps a malformed terminal choice in projected evidence while still removing requester syntax and invocation", () => {
    const malformed = "```herdr-choice-list\n{not-json}\n```";
    const citation = "<oai-mem-citation>\n<citation_entries>MEMORY.md:3-3|note=[evidence]</citation_entries>\n<rollout_ids>019dbb13-b7a0-7000-8000-000000000003</rollout_ids>\n</oai-mem-citation>";
    const source = `Visible answer.\n\n<at id=ou_1234567890abcdef></at>\n\n$herdr-choice-list:herdr-choice-list\n${malformed}\n\n${citation}`;

    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-invalid-envelope", "turn-invalid-envelope", "2026-10-16T00:00:00Z", {
        type: "message", message_id: "invalid-envelope", channel: "final", text: source, truncated: false
      }))
    ]);

    expect(projected.answerDelta).toBe(`Visible answer.\n\n${malformed}\n\n${citation}`);
    expect(projected.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "final_answer", markdown: `Visible answer.\n\n${malformed}\n\n${citation}` })
    ]);
    expect(projector.snapshot().completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoiceSource).toBeUndefined();
    expect(projected.answerDelta).not.toContain("<at id=");
    expect(projected.answerDelta).not.toContain("$herdr-choice-list:herdr-choice-list");
  });

  it.each(["developer", "system"] as const)("suppresses %s messages from answers, timeline deltas, and recovered completion choices", (role) => {
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent(`source-${role}:start`, "turn-role", "2026-10-22T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent(`source-${role}:commentary`, "turn-role", "2026-10-22T00:00:01Z", {
        type: "message",
        message_id: `${role}-commentary`,
        role,
        channel: "commentary",
        text: `Internal guidance\n\n\`\`\`herdr-choice-list\n{"version":2,"intent":"none"}\n\`\`\``,
        truncated: false
      })),
      parseHerdrAgentEvent(agentEvent(`source-${role}:final`, "turn-role", "2026-10-22T00:00:02Z", {
        type: "message",
        message_id: `${role}-final`,
        role,
        channel: "final",
        text: "Internal final answer.",
        truncated: false
      })),
      parseHerdrAgentEvent(agentEvent(`source-${role}:done`, "turn-role", "2026-10-22T00:00:03Z", { type: "turn_completed" }))
    ]);

    expect(projected.answerDelta).toBe("");
    expect(projected.timelineDeltas).toBeUndefined();
    expect(projected.turnLifecycle).toMatchObject({ state: "completed" });
    expect(projected.turnLifecycle?.finalAnswer).toBeUndefined();
    expect(projected.turnLifecycle?.completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoiceSource).toBeUndefined();
  });

  it("suppresses token-usage telemetry from answers, timeline deltas, and completion choices", () => {
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-token:start", "turn-token", "2026-10-22T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-token:usage", "turn-token", "2026-10-22T00:00:01Z", {
        type: "token_usage",
        response_id: "response-1",
        response: {
          input_tokens: 80,
          cached_input_tokens: 10,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 105
        },
        thread: {
          input_tokens: 800,
          cached_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 1_050
        },
        auto_compact_limit: 3_000
      })),
      parseHerdrAgentEvent(agentEvent("source-token:done", "turn-token", "2026-10-22T00:00:02Z", { type: "turn_completed" }))
    ]);

    expect(projected.answerDelta).toBe("");
    expect(projected.timelineDeltas).toBeUndefined();
    expect(projected.turnLifecycle).toMatchObject({ state: "completed" });
    expect(projected.turnLifecycle?.finalAnswer).toBeUndefined();
    expect(projected.turnLifecycle?.completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoiceSource).toBeUndefined();
  });

  it("suppresses context-snapshot telemetry from answers, timeline deltas, and completion choices", () => {
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-context:start", "turn-context", "2026-10-22T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-context:snapshot", "turn-context", "2026-10-22T00:00:01Z", {
        type: "context_snapshot",
        model: "GPT-5.6-Sol",
        provider: "trae",
        permission_mode: "managed",
        current_date: "2026-10-22",
        timezone: "Etc/UTC",
        auto_compact_limit: 3_000
      })),
      parseHerdrAgentEvent(agentEvent("source-context:done", "turn-context", "2026-10-22T00:00:02Z", { type: "turn_completed" }))
    ]);

    expect(projected.answerDelta).toBe("");
    expect(projected.timelineDeltas).toBeUndefined();
    expect(projected.turnLifecycle).toMatchObject({ state: "completed" });
    expect(projected.turnLifecycle?.finalAnswer).toBeUndefined();
    expect(projected.turnLifecycle?.completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoice).toBeUndefined();
    expect(projector.snapshot().completionChoiceSource).toBeUndefined();
  });

  it("recovers a structured choice from commentary when the final keeps only the invocation marker", () => {
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Approve Gate 2?", default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }, { id: "revise", label: "Revise", message: "Revise the specification." }]
    };
    const visible = "Specification is ready.";
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-x268:start", "turn-x268", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-x268:commentary", "turn-x268", "2026-10-15T13:00:01Z", {
        type: "message", message_id: "x268-message", channel: "commentary",
        text: `${visible}\n\n$herdr-choice-list:herdr-choice-list\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-x268:final", "turn-x268", "2026-10-15T13:00:02Z", {
        type: "message", message_id: "x268-message", channel: "final",
        text: `${visible}\n\n$herdr-choice-list:herdr-choice-list`, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-x268:done", "turn-x268", "2026-10-15T13:00:03Z", { type: "turn_completed" }))
    ]);

    expect(projected.answerDelta).toBe(visible);
    expect(projected.turnLifecycle).toMatchObject({
      state: "completed",
      finalAnswer: visible,
      completionChoice: {
        question: "Approve Gate 2?",
        defaultOption: { id: "approve", label: "Approve", submitText: "default" },
        alternatives: [{ id: "revise", label: "Revise", submitText: "Revise the specification." }]
      }
    });
    expect(projector.snapshot().completionChoice).toEqual({
      question: "Approve Gate 2?", defaultOption: { id: "approve", label: "Approve", submitText: "default" },
      alternatives: [{ id: "revise", label: "Revise", submitText: "Revise the specification." }]
    });
    expect(JSON.stringify(projected)).not.toContain("herdr-choice-list");
  });

  it("recovers an embedded version 3 choice from commentary without replacing its default submit text", () => {
    const protocol = {
      version: 3,
      choice: {
        question: "Approve Gate 2?",
        defaultOption: { id: "approve", label: "Approve", submitText: "Approve the design." },
        alternatives: [{ id: "revise", label: "Revise", submitText: "Revise the design." }]
      }
    };
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-v3:start", "turn-v3", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-v3:commentary", "turn-v3", "2026-10-15T13:00:01Z", {
        type: "message", message_id: "v3-commentary", channel: "commentary",
        text: `Ready.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(protocol)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-v3:final", "turn-v3", "2026-10-15T13:00:02Z", {
        type: "message", message_id: "v3-final", channel: "final", text: "Ready.", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-v3:done", "turn-v3", "2026-10-15T13:00:03Z", { type: "turn_completed" }))
    ]);

    expect(projected.turnLifecycle).toMatchObject({
      state: "completed",
      finalAnswer: "Ready.",
      completionChoice: {
        question: "Approve Gate 2?",
        defaultOption: { id: "approve", label: "Approve", submitText: "Approve the design." },
        alternatives: [{ id: "revise", label: "Revise", submitText: "Revise the design." }]
      }
    });
    expect(projector.snapshot().completionChoiceSource).toBe("protocol");
  });

  it("projects and persists the reported alternate version 3 review list as durable button input", () => {
    const protocol = {
      version: 3,
      intent: "review",
      choices: [
        { id: "A", label: "批准 Gate 3", consequence: "立即按 W1/T1 开始 TDD 实现和验证，提交前另行确认 commit message" },
        { id: "B", label: "修改计划", consequence: "停在 Gate 3，修订 ticket plan 后重新审批" },
        { id: "C", label: "拒绝并停止", consequence: "保留隔离 worktree，不开始实现" }
      ]
    };
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-v3-alternate:start", "turn-v3-alternate", "2026-10-19T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-v3-alternate:commentary", "turn-v3-alternate", "2026-10-19T00:00:01Z", {
        type: "message", message_id: "v3-alternate-commentary", channel: "commentary",
        text: `Ready.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(protocol)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-v3-alternate:final", "turn-v3-alternate", "2026-10-19T00:00:02Z", {
        type: "message", message_id: "v3-alternate-final", channel: "final", text: "Ready.", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-v3-alternate:done", "turn-v3-alternate", "2026-10-19T00:00:03Z", { type: "turn_completed" }))
    ]);
    const expected = {
      question: "请选择下一步。",
      defaultOption: { id: "A", label: "批准 Gate 3", submitText: "立即按 W1/T1 开始 TDD 实现和验证，提交前另行确认 commit message" },
      alternatives: [
        { id: "B", label: "修改计划", submitText: "停在 Gate 3，修订 ticket plan 后重新审批" },
        { id: "C", label: "拒绝并停止", submitText: "保留隔离 worktree，不开始实现" }
      ]
    };

    expect(projected.turnLifecycle).toMatchObject({ state: "completed", finalAnswer: "Ready.", completionChoice: expected });
    const store = new SqliteBindingStore(":memory:");
    try {
      const persisted = normalizeAndPersistCompletionChoice({
        context: store as unknown as SqliteContext,
        ownerKind: "primary-prompt",
        ownerId: "prompt-v3-alternate",
        ownerGeneration: 1,
        answer: projected.turnLifecycle?.finalAnswer ?? "",
        completionChoice: projected.turnLifecycle?.completionChoice,
        occurredAt: "2026-10-19T00:00:03Z"
      });
      expect(persisted.invalidReason).toBeUndefined();
      expect(persisted.choice?.prompt).toEqual(expected);
    } finally {
      store.close();
    }
  });

  it("persists a projected version 3 choice whose default submit text is not the legacy sentinel", () => {
    const protocol = {
      version: 3,
      choice: {
        question: "Approve Gate 2?",
        defaultOption: { id: "approve", label: "Approve", submitText: "Approve the design." },
        alternatives: [{ id: "revise", label: "Revise", submitText: "Revise the design." }]
      }
    };
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-v3-persist:start", "turn-v3-persist", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-v3-persist:commentary", "turn-v3-persist", "2026-10-15T13:00:01Z", {
        type: "message", message_id: "v3-persist-commentary", channel: "commentary",
        text: `Ready.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(protocol)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-v3-persist:final", "turn-v3-persist", "2026-10-15T13:00:02Z", {
        type: "message", message_id: "v3-persist-final", channel: "final", text: "Ready.", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-v3-persist:done", "turn-v3-persist", "2026-10-15T13:00:03Z", { type: "turn_completed" }))
    ]);
    const store = new SqliteBindingStore(":memory:");
    try {
      const persisted = normalizeAndPersistCompletionChoice({
        context: store as unknown as SqliteContext,
        ownerKind: "primary-prompt",
        ownerId: "prompt-v3-persist",
        ownerGeneration: 1,
        answer: projected.turnLifecycle?.finalAnswer ?? "",
        completionChoice: projected.turnLifecycle?.completionChoice,
        occurredAt: "2026-10-15T13:00:03Z"
      });
      expect(persisted.invalidReason).toBeUndefined();
      expect(persisted.choice?.prompt).toEqual(protocol.choice);
    } finally {
      store.close();
    }
  });

  it("captures a structured choice before waiting commentary becomes a blocked status", () => {
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Approve?", default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }]
    };
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-status:start", "turn-status", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-status:commentary", "turn-status", "2026-10-15T13:00:01Z", {
        type: "message", message_id: "status-message", channel: "commentary",
        text: `Waiting for user confirmation.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-status:final", "turn-status", "2026-10-15T13:00:02Z", {
        type: "message", message_id: "status-message", channel: "final", text: "Done.\n\n$herdr-choice-list:herdr-choice-list", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-status:done", "turn-status", "2026-10-15T13:00:03Z", { type: "turn_completed" }))
    ]);

    expect(projected.timelineDeltas).toEqual([expect.objectContaining({ kind: "status", state: "blocked" })]);
    expect(projected.turnLifecycle).toMatchObject({
      state: "completed",
      finalAnswer: "Done.",
      completionChoice: {
        question: "Approve?",
        defaultOption: { id: "approve", label: "Approve", submitText: "default" },
        alternatives: []
      }
    });
  });

  it("does not derive or clear structured choices from truncated protocol text", () => {
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Approve?", default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }]
    };
    const projector = new HerdrEventProjector();
    projector.project([
      parseHerdrAgentEvent(agentEvent("source-truncated:start", "turn-truncated", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-truncated:partial-choice", "turn-truncated", "2026-10-15T13:00:01Z", {
        type: "message", message_id: "partial-choice", channel: "commentary", text: `Partial\n\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``, truncated: true
      }))
    ]);
    expect(projector.snapshot().completionChoice).toBeUndefined();

    projector.project([
      parseHerdrAgentEvent(agentEvent("source-truncated:choice", "turn-truncated", "2026-10-15T13:00:02Z", {
        type: "message", message_id: "choice", channel: "commentary", text: `Full\n\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-truncated:partial-none", "turn-truncated", "2026-10-15T13:00:03Z", {
        type: "message", message_id: "partial-none", channel: "commentary", text: "Partial\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"none\"}\n```", truncated: true
      }))
    ]);
    expect(projector.snapshot().completionChoice).toEqual({
      question: "Approve?", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: []
    });
  });

  it.each(["status", "system", "progress"])("does not derive structured choices from the %s telemetry channel", (channel) => {
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Approve?", default: "approve",
      options: [{ id: "approve", label: "Approve", message: "default" }]
    };
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent(`source-channel:${channel}`, "turn-channel", "2026-10-15T13:00:00Z", {
        type: "message", message_id: `channel-${channel}`, channel,
        text: `Waiting for approval\n\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent(`source-channel:${channel}:done`, "turn-channel", "2026-10-15T13:00:01Z", { type: "turn_completed" }))
    ]);

    expect(projector.snapshot().completionChoice).toBeUndefined();
    expect(projected.turnLifecycle?.completionChoice).toBeUndefined();
  });

  it("keeps native final metadata ahead of later same-turn protocol declarations", () => {
    const commentaryChoice = { version: 2, intent: "human_review", question: "Commentary?", default: "keep", options: [{ id: "keep", label: "Keep", message: "default" }] } as const;
    const nativeChoice = { version: 2, intent: "human_review", question: "Native?", default: "continue", options: [{ id: "continue", label: "Continue", message: "default" }] } as const;
    const projector = new HerdrEventProjector();
    projector.project([
      parseHerdrAgentEvent(agentEvent("source-priority:start", "turn-priority", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-priority:final", "turn-priority", "2026-10-15T13:00:01Z", { type: "message", message_id: "native-choice", channel: "final", text: "Final.", truncated: false, completion_choice: nativeChoice })),
      parseHerdrAgentEvent(agentEvent("source-priority:commentary", "turn-priority", "2026-10-15T13:00:02Z", { type: "message", message_id: "commentary-choice", channel: "commentary", text: `Commentary\n\n\`\`\`herdr-choice-list\n${JSON.stringify(commentaryChoice)}\n\`\`\``, truncated: false })),
      parseHerdrAgentEvent(agentEvent("source-priority:none", "turn-priority", "2026-10-15T13:00:03Z", { type: "message", message_id: "protocol-none", channel: "commentary", text: `No review\n\n\`\`\`herdr-choice-list\n{"version":2,"intent":"none"}\n\`\`\``, truncated: false }))
    ]);
    expect(projector.snapshot().completionChoice).toEqual({
      question: "Native?", defaultOption: { id: "continue", label: "Continue", submitText: "default" }, alternatives: []
    });
    expect(projector.snapshot().completionChoiceSource).toBe("native");
  });

  it("projects a valid same-turn intent-none declaration as the default Continue choice", () => {
    const choice = { version: 2, intent: "human_review", question: "Review?", default: "approve", options: [{ id: "approve", label: "Approve", message: "default" }] };
    const projector = new HerdrEventProjector();
    projector.project([
      parseHerdrAgentEvent(agentEvent("source-none:start", "turn-none", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-none:choice", "turn-none", "2026-10-15T13:00:01Z", { type: "message", message_id: "choice", channel: "commentary", text: `Answer\n\n\`\`\`herdr-choice-list\n${JSON.stringify(choice)}\n\`\`\``, truncated: false })),
      parseHerdrAgentEvent(agentEvent("source-none:clear", "turn-none", "2026-10-15T13:00:02Z", { type: "message", message_id: "clear", channel: "commentary", text: `No review\n\n\`\`\`herdr-choice-list\n{"version":2,"intent":"none"}\n\`\`\``, truncated: false }))
    ]);
    expect(projector.snapshot().completionChoice).toEqual({
      question: "是否继续？", defaultOption: { id: "continue", label: "继续", submitText: "continue" }, alternatives: []
    });
    expect(projector.snapshot().completionChoiceSource).toBe("protocol");
  });

  it("does not carry a recovered choice into a new turn or recover ordinary invalid commentary", () => {
    const choice = { version: 2, intent: "human_review", question: "Review?", default: "approve", options: [{ id: "approve", label: "Approve", message: "default" }] };
    const projector = new HerdrEventProjector();
    projector.project([
      parseHerdrAgentEvent(agentEvent("source-reset:start-1", "turn-reset-1", "2026-10-15T13:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-reset:choice", "turn-reset-1", "2026-10-15T13:00:01Z", { type: "message", message_id: "choice", channel: "commentary", text: `Answer\n\n\`\`\`herdr-choice-list\n${JSON.stringify(choice)}\n\`\`\``, truncated: false })),
      parseHerdrAgentEvent(agentEvent("source-reset:start-2", "turn-reset-2", "2026-10-15T13:01:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-reset:ordinary", "turn-reset-2", "2026-10-15T13:01:01Z", { type: "message", message_id: "ordinary", channel: "commentary", text: "No transport here.", truncated: false })),
      parseHerdrAgentEvent(agentEvent("source-reset:invalid", "turn-reset-2", "2026-10-15T13:01:02Z", { type: "message", message_id: "invalid", channel: "commentary", text: "\`\`\`herdr-choice-list\n{bad}\n\`\`\`", truncated: false }))
    ]);
    expect(projector.snapshot().completionChoice).toBeUndefined();
  });

  it("keeps ineligible choice-like text visible in a non-final assistant message", () => {
    const text = "Visible answer.\n\n```herdr-choice-list\n{bad}\n```";
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:assistant-choice", "turn-choice", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "assistant-choice", channel: "assistant", text, truncated: false
      }))
    ]);

    expect(projected.answerDelta).toBe(text);
    expect(projected.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "agent_message", markdown: text })
    ]);
    expect(JSON.stringify(projected)).toContain("herdr-choice-list");
  });

  it("keeps ineligible choice-like text visible in visible reasoning", () => {
    const text = "Safe reasoning.\n\n```herdr-choice-list\n{bad}\n```";
    const projected = new HerdrEventProjector({ reasoningDisplay: "visible" }).project([
      parseHerdrAgentEvent(agentEvent("source-1:reasoning-choice", "turn-choice", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "reasoning-choice", channel: "reasoning_visible",
        text, truncated: false
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "thinking", markdown: text })
    ]);
    expect(JSON.stringify(projected)).toContain("herdr-choice-list");
  });

  it("keeps protocol JSON out of a repeated final message lifecycle", () => {
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Next?", default: "keep",
      options: [{ id: "keep", label: "Keep", message: "default" }]
    };
    const projector = new HerdrEventProjector();
    projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:start", "turn-choice", "2026-09-30T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-1:first", "turn-choice", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "final-choice", channel: "final", text: "Visible answer.", truncated: false
      }))
    ]);
    const repeatedText = `Visible answer.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(completionChoice)}\n\`\`\``;
    const completed = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:repeat", "turn-choice", "2026-09-30T00:00:02Z", {
        type: "message", message_id: "final-choice", channel: "final", text: repeatedText, truncated: false,
        completion_choice: completionChoice
      })),
      parseHerdrAgentEvent(agentEvent("source-1:done", "turn-choice", "2026-09-30T00:00:03Z", { type: "turn_completed" }))
    ]);

    expect(completed.turnLifecycle).toMatchObject({
      state: "completed",
      finalAnswer: "Visible answer.",
      completionChoice: {
        question: "Next?",
        defaultOption: { id: "keep", label: "Keep", submitText: "default" },
        alternatives: []
      }
    });
    expect(JSON.stringify(completed)).not.toContain("herdr-choice-list");
  });

  it("keeps ineligible choice-like text visible without activating choice metadata", () => {
    const text = [
      "Before",
      "```herdr-choice-list\n{bad}\n```",
      "Between",
      "```herdr-choice-list\n{\"version\":2,\"intent\":\"none\"}\n```",
      "After"
    ].join("\n\n");
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:invalid-choice", "turn-choice", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "invalid-choice", channel: "final", text, truncated: false
      }))
    ]);

    expect(projected.answerDelta).toBe(text);
    expect(projector.snapshot().completionChoice).toBeUndefined();
    expect(JSON.stringify(projected)).toContain("herdr-choice-list");
    expect(JSON.stringify(projected)).toContain("{bad}");
  });

  it("consumes only exact final requester markers outside Markdown code", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "final-mention", channel: "final",
        text: "Done @_user_1. `@_user_1` and @_user_2 remain.", truncated: false
      }))
    ]);

    expect(projected).toMatchObject({
      answerDelta: "Done. `@_user_1` and @_user_2 remain.",
      timelineDeltas: [expect.objectContaining({
        kind: "final_answer", markdown: "Done. `@_user_1` and @_user_2 remain."
      })]
    });
  });

  it("restores sequence and deduplication state after a failed projection", () => {
    const projector = new HerdrEventProjector();
    projector.project([parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", { type: "turn_started" }))]);
    const snapshot = projector.snapshot();

    expect(projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", { type: "message", message_id: "retry", channel: "final", text: "retry", truncated: false }))
    ])).toMatchObject({ timelineDeltas: [expect.objectContaining({ id: "message:retry", sequence: 1 })] });

    projector.restore(snapshot);
    expect(projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", { type: "message", message_id: "healthy", channel: "final", text: "healthy", truncated: false }))
    ])).toMatchObject({
      answerDelta: "healthy",
      timelineDeltas: [expect.objectContaining({ id: "message:healthy", sequence: 1 })]
    });
  });

  it("keeps protocol failures out of an otherwise pure projection result", () => {
    const projector = new HerdrEventProjector();
    expect(() => projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", { type: "source_error", code: "malformed_record" }))
    ])).toThrow("agent event source failed: malformed_record");
  });

  it("preserves explicitly public reasoning under a compact collapsible title and can hide it", () => {
    const event = parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
      type: "message", message_id: "reasoning-1", channel: "reasoning_visible", text: "Inspecting delivery state", truncated: false
    }));

    expect(new HerdrEventProjector({ reasoningDisplay: "summary" }).project([event]).timelineDeltas).toEqual([
      { kind: "thinking", id: "thinking:reasoning-1", sequence: 1, label: "Inspecting delivery state", markdown: "Inspecting delivery state" }
    ]);
    expect(new HerdrEventProjector({ reasoningDisplay: "hidden" }).project([event]).timelineDeltas).toBeUndefined();
  });

  it("starts repeated reasoning message ids with fresh sequence state in a new turn", () => {
    const projector = new HerdrEventProjector({ reasoningDisplay: "visible" });
    expect(projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:start-1", "turn-1", "2026-09-30T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-1:reasoning-1", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "reasoning-shared", channel: "reasoning_visible", text: "first turn", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:answer-1", "turn-1", "2026-09-30T00:00:02Z", {
        type: "message", message_id: "answer-1", channel: "assistant", text: "first answer", truncated: false
      }))
    ]).timelineDeltas).toEqual([
      expect.objectContaining({ id: "thinking:reasoning-shared", sequence: 1 }),
      expect.objectContaining({ id: "message:answer-1", sequence: 2 })
    ]);

    expect(projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:start-2", "turn-2", "2026-09-30T00:01:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-1:reasoning-2", "turn-2", "2026-09-30T00:01:01Z", {
        type: "message", message_id: "reasoning-shared", channel: "reasoning_visible", text: "second turn", truncated: false
      }))
    ]).timelineDeltas).toEqual([
      expect.objectContaining({ id: "thinking:reasoning-shared", sequence: 3, markdown: "second turn" })
    ]);
  });

  it("defaults remote reasoning to hidden and shows only explicitly public reasoning", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "analysis-1", channel: "analysis", text: "private analysis", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning", text: "private reasoning", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
        type: "message", message_id: "public-1", channel: "reasoning_visible", text: "**Safe progress**\n\nPublic detail", truncated: false
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      { kind: "thinking", id: "thinking:public-1", sequence: 1, label: "Safe progress", markdown: "**Safe progress**\n\nPublic detail" }
    ]);
  });

  it("drops private reasoning before waiting or approval status classification", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "analysis-waiting", channel: "analysis", text: "Waiting for approval: private detail", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "reasoning-approval", channel: "reasoning", text: "Approval required for private operation", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
        type: "message", message_id: "public-waiting", channel: "reasoning_visible", text: "Waiting for approval", truncated: false
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      { kind: "status", id: "status:public-waiting", sequence: 1, label: "Waiting for approval", state: "blocked" }
    ]);
    expect(JSON.stringify(projected)).not.toContain("private detail");
    expect(JSON.stringify(projected)).not.toContain("private operation");
  });

  it("ignores private reasoning and projects a later public version with stable identity", () => {
    const projector = new HerdrEventProjector({ reasoningDisplay: "visible" });
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning", text: "Inspecting delivery state", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning_visible", text: "**Inspecting delivery state**\n\nFull Pane-visible detail", truncated: false
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      { kind: "thinking", id: "thinking:reasoning-1", sequence: 1, label: "Inspecting delivery state", markdown: "**Inspecting delivery state**\n\nFull Pane-visible detail" }
    ]);
    expect(new HerdrEventProjector({ reasoningDisplay: "summary" }).project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning", text: "Safe summary", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning_visible", text: "Private detail", truncated: false
      }))
    ]).timelineDeltas).toEqual([
      { kind: "thinking", id: "thinking:reasoning-1", sequence: 1, label: "Private detail", markdown: "Private detail" }
    ]);
    expect(new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning", text: "Safe summary", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "reasoning-1", channel: "reasoning_visible", text: "Default Pane-visible detail", truncated: false
      }))
    ]).timelineDeltas).toEqual([
      { kind: "thinking", id: "thinking:reasoning-1", sequence: 1, label: "Default Pane-visible detail", markdown: "Default Pane-visible detail" }
    ]);
  });

  it("projects waiting-for-command status messages into the visible timeline", () => {
    const event = parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
      type: "message", message_id: "status-1", channel: "status", text: "waiting for command", truncated: false
    }));

    expect(new HerdrEventProjector().project([event]).timelineDeltas).toEqual([
      { kind: "status", id: "status:status-1", sequence: 1, label: "waiting for command", state: "running" }
    ]);
  });

  it("keeps the Wait Tool call visible alongside waiting-for-command status", () => {
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "tool_call", call_id: "wait-1", name: "wait", arguments: JSON.stringify({ session_id: 42 }), truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "message", message_id: "status-1", channel: "status", text: "Waiting for command", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
        type: "tool_result", call_id: "wait-1", text: "Script completed", is_error: false, truncated: false
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", state: "running" }),
      { kind: "status", id: "status:status-1", sequence: 2, label: "Waiting for command", state: "running" },
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", state: "succeeded" })
    ]);
  });

  it("keeps the full agent lifecycle in status without duplicating it into Answer", () => {
    const projector = new HerdrEventProjector();
    const started = projector.project([parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Review Agent", state: "started"
    }))]);
    const failed = projector.project([parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
      type: "agent_activity", agent_id: "reviewer", display_name: "Review Agent", state: "failed",
      content: "Found a failing invariant.", content_truncated: false
    }))]);

    expect(started.toolActivities).toEqual([
      { key: "agent:reviewer", kind: "step", label: "Agent · Review Agent", state: "active" }
    ]);
    expect(started.timelineDeltas).toBeUndefined();
    expect(failed.toolActivities).toEqual([
      { key: "agent:reviewer", kind: "step", label: "Agent · Review Agent", state: "failed" }
    ]);
    expect(failed.timelineDeltas).toBeUndefined();
  });

  it("projects model, compaction, and model-aware subagent facts without private or inferred details", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-10-07T00:00:01Z", {
        type: "model_changed", model: "GPT-5.6-Sol", private_path: "/private/model"
      })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-10-07T00:00:02Z", {
        type: "context_compacted", summary: "private compact summary"
      })),
      parseHerdrAgentEvent(agentEvent("source-1:4", "turn-1", "2026-10-07T00:00:03Z", {
        type: "tool_call", call_id: "spawn-1", name: "collaboration__spawn_agent",
        arguments: JSON.stringify({ task_name: "reviewer", model: "inferred-model", message: "private prompt" }), truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:5", "turn-1", "2026-10-07T00:00:04Z", {
        type: "agent_activity", agent_id: "/root/reviewer", state: "started", model: "GPT-5.6-Sol"
      })),
      parseHerdrAgentEvent(agentEvent("source-1:6", "turn-1", "2026-10-07T00:00:05Z", {
        type: "agent_activity", agent_id: "/root/reviewer", state: "completed", model: "GPT-5.6-Sol"
      }))
    ]);

    expect(projected.model).toBe("GPT-5.6-Sol");
    expect(projected.timelineDeltas).toEqual([
      { kind: "status", id: "model:source-1:2", sequence: 1, label: "🧠 Model · GPT-5.6-Sol", state: "completed" },
      { kind: "status", id: "context-compacted:source-1:3", sequence: 2, label: "🗜️ Context compacted", state: "completed" },
      { kind: "tool", id: "tool:spawn-1", sequence: 3, category: "step", label: "reviewer", action: "Agent", target: "reviewer", state: "running" }
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/private|inferred-model/);
  });

  it("keeps repeated model transitions distinct and replay-stable", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", { type: "model_changed", model: "A" })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-10-07T00:00:01Z", { type: "model_changed", model: "B" })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-10-07T00:00:02Z", { type: "model_changed", model: "A" }))
    ]);

    expect(projected.model).toBe("A");
    expect(projected.timelineDeltas).toEqual([
      { kind: "status", id: "model:source-1:1", sequence: 1, label: "🧠 Model · A", state: "completed" },
      { kind: "status", id: "model:source-1:2", sequence: 2, label: "🧠 Model · B", state: "completed" },
      { kind: "status", id: "model:source-1:3", sequence: 3, label: "🧠 Model · A", state: "completed" }
    ]);
  });

  it("keeps subagent lifecycle out of Answer and labels only an explicit requested model", () => {
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "tool_call", call_id: "spawn-1", name: "collaboration__spawn_agent",
        arguments: JSON.stringify({ task_name: "reviewer", model: "GPT-5.4", message: "private task" }), truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "agent_activity", agent_id: "/root/reviewer", display_name: "Review Agent", state: "started"
      })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
        type: "agent_activity", agent_id: "/root/reviewer", display_name: "Review Agent", state: "running"
      })),
      parseHerdrAgentEvent(agentEvent("source-1:4", "turn-1", "2026-09-30T00:00:03Z", {
        type: "agent_activity", agent_id: "/root/reviewer", display_name: "Review Agent", state: "blocked"
      })),
      parseHerdrAgentEvent(agentEvent("source-1:5", "turn-1", "2026-09-30T00:00:04Z", {
        type: "agent_activity", agent_id: "/root/reviewer", display_name: "Review Agent", state: "completed"
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      { kind: "tool", id: "tool:spawn-1", sequence: 1, category: "step", label: "reviewer", action: "Agent", target: "reviewer", state: "running" }
    ]);
    expect(JSON.stringify(projected.timelineDeltas)).not.toContain("private task");

    const withoutModelProjector = new HerdrEventProjector();
    const spawnedWithoutModel = withoutModelProjector.project([
      parseHerdrAgentEvent(agentEvent("source-2:1", "turn-2", "2026-09-30T00:00:00Z", {
        type: "tool_call", call_id: "spawn-2", name: "collaboration__spawn_agent",
        arguments: JSON.stringify({ task_name: "tester", message: "test" }), truncated: false
      }))
    ]);
    const withoutModel = withoutModelProjector.project([
      parseHerdrAgentEvent(agentEvent("source-2:2", "turn-2", "2026-09-30T00:00:01Z", {
        type: "agent_activity", agent_id: "/root/tester", state: "started"
      }))
    ]);
    const collidingWithoutModel = withoutModelProjector.project([
      parseHerdrAgentEvent(agentEvent("source-2:3", "turn-2", "2026-09-30T00:00:02Z", {
        type: "agent_activity", agent_id: "/other/tester", state: "started"
      }))
    ]);
    expect(spawnedWithoutModel.toolActivities).toEqual([
      expect.objectContaining({ key: "agent:tester", state: "active" })
    ]);
    expect(withoutModel.toolActivities).toEqual([
      { key: "agent:tester", kind: "step", label: "Agent · /root/tester", state: "active" }
    ]);
    expect(withoutModel.timelineDeltas).toBeUndefined();
    expect(collidingWithoutModel.timelineDeltas).toBeUndefined();
    expect(JSON.stringify(withoutModel.toolActivities)).not.toContain("model");

    const reverseProjector = new HerdrEventProjector();
    reverseProjector.project([
      parseHerdrAgentEvent(agentEvent("source-3:1", "turn-3", "2026-09-30T00:00:00Z", {
        type: "tool_call", call_id: "spawn-3", name: "collaboration__spawn_agent",
        arguments: JSON.stringify({ task_name: "tester", message: "test" }), truncated: false
      }))
    ]);
    const reverseCollision = reverseProjector.project([
      parseHerdrAgentEvent(agentEvent("source-3:2", "turn-3", "2026-09-30T00:00:01Z", {
        type: "agent_activity", agent_id: "/other/tester", state: "started"
      }))
    ]);
    const reverseOwner = reverseProjector.project([
      parseHerdrAgentEvent(agentEvent("source-3:3", "turn-3", "2026-09-30T00:00:02Z", {
        type: "agent_activity", agent_id: "/root/tester", state: "started"
      }))
    ]);
    expect(reverseCollision.timelineDeltas).toBeUndefined();
    expect(reverseOwner.timelineDeltas).toBeUndefined();
  });

  it("uses one collision-safe Agent identity for a spawn task and its canonical path activity", () => {
    const projector = new HerdrEventProjector();
    const spawned = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "tool_call", call_id: "spawn-1", name: "collaboration__spawn_agent",
        arguments: JSON.stringify({ task_name: "reviewer", model: "GPT-5.4", message: "review" }), truncated: false
      }))
    ]);
    const collidingLeaf = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "agent_activity", agent_id: "/other/reviewer", display_name: "Other Review Agent", state: "started"
      }))
    ]);
    const started = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
        type: "agent_activity", agent_id: "/root/reviewer", display_name: "Review Agent", state: "started"
      }))
    ]);

    expect(spawned.toolActivities).toEqual([
      expect.objectContaining({ key: "agent:reviewer", state: "active" })
    ]);
    expect(started.toolActivities).toEqual([
      { key: "agent:reviewer", kind: "step", label: "Agent · Review Agent · requested model: GPT-5.4", state: "active" }
    ]);
    expect(spawned.timelineDeltas).toEqual([
      { kind: "tool", id: "tool:spawn-1", sequence: 1, category: "step", label: "reviewer", action: "Agent", target: "reviewer", state: "running" }
    ]);
    expect(started.timelineDeltas).toBeUndefined();
    expect(collidingLeaf.toolActivities).toEqual([
      { key: "agent:/other/reviewer", kind: "step", label: "Agent · Other Review Agent", state: "active" }
    ]);
    expect(collidingLeaf.timelineDeltas).toBeUndefined();
  });

  it("keeps collaboration tool calls and results in the Answer timeline", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
        type: "tool_call", call_id: "list-1", name: "collaboration__list_agents", arguments: "{}", truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", {
        type: "tool_result", call_id: "list-1", text: "completed", is_error: false, truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
        type: "tool_call", call_id: "follow-1", name: "collaboration__followup_task",
        arguments: JSON.stringify({ target: "reviewer", message: "continue" }), truncated: false
      })),
      parseHerdrAgentEvent(agentEvent("source-1:4", "turn-1", "2026-09-30T00:00:03Z", {
        type: "tool_result", call_id: "follow-1", text: "completed", is_error: false, truncated: false
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", id: "tool:list-1", label: "list_agents", state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:list-1", label: "list_agents", state: "succeeded" }),
      expect.objectContaining({ kind: "tool", id: "tool:follow-1", label: "reviewer", state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:follow-1", label: "reviewer", state: "succeeded" })
    ]);
  });

  it("keeps skipped-record diagnostics out of Feishu while projecting a bounded terminal cancellation", () => {
    const projected = new HerdrEventProjector().project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", { type: "record_skipped", code: "malformed_secret_token" })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", { type: "record_skipped", code: "oversized_raw_payload" })),
      parseHerdrAgentEvent(agentEvent("source-1:4", "turn-1", "2026-09-30T00:00:03Z", {
        type: "turn_aborted", reason: `operator cancelled api_key=live-secret ${"detail ".repeat(100)}`
      }))
    ]);

    expect(projected.timelineDeltas).toEqual([expect.objectContaining({
      kind: "status", id: "turn-aborted:source-1:4", sequence: 1, state: "cancelled"
    })]);
    expect(projected.timelineDeltas?.[0]).toMatchObject({
      kind: "status", id: "turn-aborted:source-1:4", sequence: 1, state: "cancelled"
    });
    const rendered = JSON.stringify(projected.timelineDeltas);
    expect(rendered).toContain("operator cancelled api_key=[REDACTED]");
    expect(rendered).not.toContain("live-secret");
    expect(rendered).not.toContain("malformed_secret_token");
    expect(rendered).not.toContain("oversized_raw_payload");
    expect((projected.timelineDeltas?.[0] as { label: string }).label.length).toBeLessThanOrEqual(240);
    expect(projected.answerDelta).toBe("");
  });

  it("normalizes a real envelope sequence with Human, nested Tool, result, and Assistant items", () => {
    const projector = new HerdrEventProjector();
    const projected = projector.project([
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", { type: "human_message", message_id: "human-1", text: "check", truncated: false, submission_id: "submission-1" })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec", arguments: "{}", truncated: false })),
      parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", { type: "tool_result", call_id: "call-1", text: "done", is_error: false, truncated: false })),
      parseHerdrAgentEvent(agentEvent("source-1:4", "turn-1", "2026-09-30T00:00:03Z", { type: "message", message_id: "answer-1", channel: "final", text: "done", truncated: false }))
    ]);
    expect(projected.timelineDeltas?.map(({ id }) => id)).toEqual(["human:human-1", "tool:call-1", "tool:call-1", "message:answer-1"]);
    expect(projected.timelineDeltas?.[2]).toMatchObject({ state: "succeeded", result: "done" });
  });
});
