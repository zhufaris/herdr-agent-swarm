import { describe, expect, it } from "vitest";
import { planAndRenderTurnCard, planTurnCardTimeline, renderTurnCard, TurnCardPayloadOverflowError, type ConversationSegmentCardView } from "../src/cards/turn-card.js";
import { turnCardPresentationPolicy } from "../src/gateways/feishu/turn-card-presentation-policy.js";
import { isGatewayView } from "../src/gateways/contract/view.js";
import { materializeFeishuPresentationView } from "../src/gateways/feishu/presentation.js";
import { renderCompletionReviewCard } from "../src/cards/completion-actions.js";
import { turnSessionStatePresentationFingerprint, turnSessionStateView } from "../src/domain/turn-session-state.js";

const base = (overrides: Partial<ConversationSegmentCardView> = {}): ConversationSegmentCardView => ({
  segmentId: "segment-1", ownerKind: "primary", ownerLabel: "Primary", spaceName: "demo",
  projectLabel: "demo", tabLabel: "a1j3", paneToken: "9e2u",
  requestText: "please inspect the deployment", state: "working", timelineItems: [], gapWarning: null, viewVersion: 1, ...overrides
});

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(text).join(" ");
  return "";
}

function countElementId(value: unknown, elementId: string): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countElementId(item, elementId), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  return (record.element_id === elementId ? 1 : 0)
    + Object.values(record).reduce((count, item) => count + countElementId(item, elementId), 0);
}

type RenderedTurnCard = {
  config: { update_multi: boolean; width_mode: string; streaming_mode: boolean; summary: { content: string } };
  header: { title: { content: string }; subtitle: { content: string }; template?: string };
  body: { elements: unknown[] };
};

describe("unified turn card", () => {
  it("keeps a merged prior input visually active-neutral instead of greyed out", () => {
    const card = renderTurnCard(base({ state: "closed" })) as RenderedTurnCard;
    const rendered = text(card.body.elements);

    expect(card.header.template).toBe("blue");
    expect(card.header.title.content).toContain("已转交后续输入");
    expect(rendered).toContain("已转交后续输入");
    expect(rendered).not.toContain("已并入后续输入");
  });

  it("assigns the page element ID to only one markdown across nested timeline nodes", () => {
    const elementId = "turn-card:segment-1:page:0";
    const card = renderTurnCard(base({
      timelineItems: [
        { kind: "thinking", id: "thinking:1", sequence: 1, label: "Inspect", markdown: "Nested thinking" },
        { kind: "agent_message", id: "message:1", sequence: 2, markdown: "Visible assistant update" }
      ]
    }), { pageIndex: 0, elementId });

    const rendered = text(card);
    expect(countElementId(card, elementId)).toBe(1);
    expect(rendered.match(/Nested thinking/g)).toHaveLength(1);
    expect(rendered.match(/Visible assistant update/g)).toHaveLength(1);
    expect(rendered.indexOf("Nested thinking")).toBeLessThan(rendered.indexOf("Visible assistant update"));
  });

  it("assigns the page element ID to top-level markdown and omits it without markdown", () => {
    const elementId = "turn-card:segment-1:page:0";
    const topLevel = renderTurnCard(base({
      timelineItems: [{ kind: "agent_message", id: "message:1", sequence: 1, markdown: "Top-level assistant update" }]
    }), { pageIndex: 0, elementId });
    const withoutMarkdown = renderTurnCard(base({
      timelineItems: [{ kind: "human_message", id: "human:1", sequence: 1, markdown: "Canonical human input" }]
    }), { pageIndex: 0, elementId });

    expect(countElementId(topLevel, elementId)).toBe(1);
    expect(countElementId(withoutMarkdown, elementId)).toBe(0);
  });

  it("renders a sanitized fresh Completion Review card with minimal callbacks", () => {
    const card = renderCompletionReviewCard({
      actionSetId: `completion-review:v3:${"a".repeat(64)}`,
      mentionOpenId: "ou_requester",
      finalContext: "DUPLICATE_FINAL_CONTEXT_CANARY",
      choicePrompt: {
        question: "Which path?", defaultOption: { id: "approve", label: "Approve", submitText: "default" },
        alternatives: [{ id: "revise", label: "Revise", submitText: "Revise it." }]
      }
    } as never);
    const serialized = JSON.stringify(card);
    expect(serialized.match(/<at id=ou_requester><\/at>/g)).toHaveLength(1);
    expect(serialized).toContain("请参考上方最终回复");
    expect(serialized).toContain("Which path?");
    expect(serialized).toContain('"optionId":"approve"');
    expect(serialized).toContain('"optionId":"revise"');
    expect(serialized).toContain('"optionId":"ignore"');
    expect(serialized).not.toContain("DUPLICATE_FINAL_CONTEXT_CANARY");
    expect(serialized).not.toContain("ownerKind");
    expect(serialized).not.toContain("ownerGeneration");
    expect(serialized).not.toContain("cardMessageId");
  });

  it("plans, measures, and renders one provider-neutral snapshot with a proved encoded bound", () => {
    const view = base({ timelineItems: [{ kind: "agent_message", id: "answer", sequence: 1, markdown: "Canonical answer" }] });
    const budget = { encodedBytes: 12_000, elementCount: 100, actionCount: 10, profileVersion: 1 };
    const planned = turnCardPresentationPolicy.plan(view, { pageIndex: 0 }, {}, budget);
    const measurement = turnCardPresentationPolicy.measure(planned.snapshot);
    const gatewayView = turnCardPresentationPolicy.render(planned.snapshot);
    const materialized = materializeFeishuPresentationView(gatewayView);

    expect(planned.pagePlan).toMatchObject({ policyVersion: 1, budgetProfileVersion: 1, startCursor: null, hasContinuation: false });
    expect(planned.snapshot).toMatchObject({ presentationBudget: budget, presentationMeasure: measurement });
    expect(isGatewayView(gatewayView)).toBe(true);
    expect(gatewayView).not.toHaveProperty("payload");
    expect(materialized).toEqual(planAndRenderTurnCard(view, { pageIndex: 0 }, {}, budget.encodedBytes).card);
    expect(Buffer.byteLength(JSON.stringify(materialized), "utf8")).toBeLessThanOrEqual(measurement.encodedBytesUpperBound);
    expect(measurement.elementCount).toBeGreaterThan(0);
  });

  it("canonically compares legacy and semantic visible structure plus delivery identities and bounds", () => {
    const view = base({ timelineItems: [] });
    const page = { pageIndex:0,elementId:"turn-card:s:page:0",startCursor:null };
    const budget = { encodedBytes:9_000,elementCount:256,actionCount:32,profileVersion:1 };
    const semantic = turnCardPresentationPolicy.plan(view,page,{},budget);
    const legacy = planAndRenderTurnCard(view,page,{},budget.encodedBytes);
    const delivery = {
      deliveryTarget:{ kind:"card_reply",identityFingerprint:"target" },
      scopeOrder:{ scopeFingerprint:"scope",ownerFingerprint:"owner",orderingIdentityFingerprint:"order" },
      idempotencyFingerprint:"idempotency",
      canonicalPageInterval:{ pageIndex:0,startCursor:null,endCursor:legacy.nextCursor,hasContinuation:legacy.nextCursor!==null }
    };

    const matching = turnCardPresentationPolicy.compareLegacyPresentation({ legacyView:legacy.card,semanticSnapshot:semantic.snapshot,legacyDelivery:delivery,semanticDelivery:delivery });
    expect(matching).toMatchObject({ matched:true,mismatches:[] });
    expect(matching.legacy).toEqual(matching.semantic);

    const mismatched = turnCardPresentationPolicy.compareLegacyPresentation({
      legacyView:{ ...legacy.card,header:{ ...(legacy.card as { header:object }).header,title:{ tag:"plain_text",content:"different" } } },
      semanticSnapshot:semantic.snapshot,legacyDelivery:delivery,
      semanticDelivery:{ ...delivery,deliveryTarget:{ kind:"card_update",identityFingerprint:"other" },idempotencyFingerprint:"other",
        canonicalPageInterval:{ ...delivery.canonicalPageInterval,hasContinuation:!delivery.canonicalPageInterval.hasContinuation } }
    });
    expect(mismatched.matched).toBe(false);
    expect(mismatched.mismatches).toEqual(expect.arrayContaining(["visibleStructureFingerprint","deliveryTarget","idempotencyFingerprint","canonicalPageInterval"]));
  });

  it("freezes canonical cursor boundaries independently from later source mutation", () => {
    const timelineItems = Array.from({ length: 6 }, (_, index) => ({
      kind: "agent_message" as const, id: `message:${index}`, sequence: index + 1, markdown: `canonical-${index} ${"字".repeat(180)}`
    }));
    const startCursor = { itemIndex: 1, markdownOffset: 0 };
    const planned = turnCardPresentationPolicy.plan(base({ timelineItems }), { pageIndex: 2, startCursor }, {}, {
      encodedBytes: 2_400, elementCount: 100, actionCount: 10, profileVersion: 7
    });
    const frozenView = turnCardPresentationPolicy.render(planned.snapshot);
    timelineItems[1]!.markdown = "mutated after planning";

    expect(planned.pagePlan).toEqual({
      policyVersion: 1, budgetProfileVersion: 7, pageIndex: 2,
      startCursor, endCursor: expect.any(Object), hasContinuation: true
    });
    expect(Object.isFrozen(planned.snapshot)).toBe(true);
    expect(JSON.stringify(turnCardPresentationPolicy.render(planned.snapshot))).toBe(JSON.stringify(frozenView));
  });

  it("uses the same lifecycle shell for pending, working, and completed turns", () => {
    const card = (state: ConversationSegmentCardView["state"]): RenderedTurnCard => renderTurnCard(base({ state })) as RenderedTurnCard;
    expect(card("pending").header.title.content).toContain("Pending");
    expect(card("working").header.title.content).toContain("Working");
    expect(card("completed").header.title.content).toContain("Completed");
    for (const state of ["pending", "working"] as const) {
      expect(card(state).config.update_multi).toBe(true);
      expect(card(state).config.summary.content).toContain(`${state === "pending" ? "Pending" : "Working"} · please inspect the deployment`);
      expect(card(state).config.streaming_mode).toBe(true);
    }
    expect(card("completed").config.update_multi).toBe(true);
    expect(card("completed").config.summary.content).toContain("Completed · please inspect the deployment");
    expect(card("completed").config.streaming_mode).toBe(false);
  });

  it("renders the explicit Project / Tab / Pane identity without parsing the owner title", () => {
    const card = renderTurnCard(base({
      ownerLabel: "herdr-agent-swarm / stale-tab",
      spaceName: "duplicated-project",
      projectLabel: "herdr-agent-swarm",
      tabLabel: "a1j3",
      paneToken: "9e2u",
      model: "GPT-5.4"
    })) as RenderedTurnCard;
    expect(card.config.width_mode).toBe("fill");
    const value = text(card);
    expect(value).toContain("herdr-agent-swarm / a1j3 / 9e2u · Model: GPT-5.4");
    expect(card.header.title.content).toBe("Working · herdr-agent-swarm / a1j3 / 9e2u · Model: GPT-5.4");
    expect(card.header.subtitle.content).toBe("reply to 👤: please inspect the deployment");
    expect(text(card.body.elements)).not.toContain("herdr-agent-swarm / a1j3 / 9e2u");
    expect(value).not.toContain("herdr-agent-swarm / stale-tab");
    expect(value).not.toContain("duplicated-project");
    expect(value).not.toContain("Pane 9e2u");
  });

  it("omits deployment branch and build commit metadata", () => {
    const card = renderTurnCard(base(), { pageIndex: 0 }, {
      runtimeIdentity: { branch: "main", gitCommit: "0123456789abcdef0123456789abcdef01234567" }
    }) as RenderedTurnCard;

    expect(card.header.title.content).toBe("Working · demo / a1j3 / 9e2u");
    expect(text(card.body.elements)).not.toContain("BRANCH `main` · BUILD `0123456789ab`");
    expect(text(card.body.elements)).not.toContain("0123456789abcdef0123456789abcdef01234567");
  });

  it("keeps the main model in the current header while rendering one compact latest Goal", () => {
    const card = renderTurnCard(base({
      model: "GPT-5.4",
      currentGoal: { objective: "Ship the verified event projection", status: "active" }
    })) as RenderedTurnCard;

    expect(card.header.title.content).toBe("Working · demo / a1j3 / 9e2u · Model: GPT-5.4");
    expect(text(card.body.elements)).toContain("🎯 Goal · active");
    expect(text(card.body.elements).match(/Ship the verified event projection/g)).toHaveLength(1);
  });

  it("renders Goal, Task List, Subagents, and Compaction without tool activity", () => {
    const activity = {
      snapshot: {
        scopeKey: "pane:w1:w1:p1", workspaceId: "w1", paneId: "w1:p1", bindingId: "b1",
        bindingGeneration: 1, sessionEpoch: 1, nativeSessionId: "session-1", revision: 7,
        currentModel: "GPT-5.6-Sol", currentGoal: null, lastTurnId: "turn-1", lastTurnState: "active" as const,
        compactionCount: 1, tokenUsage: null, contextUsage: null, updatedAt: "2026-10-09T00:00:00.000Z"
      },
      items: [
        {
          scopeKey: "pane:w1:w1:p1", producerKind: "worker" as const, producerId: "worker-1", kind: "agent" as const,
          itemId: "reviewer", ordinal: 0, label: "<at id=ou_attacker></at> Reviewer · GPT-5.6-Sol", state: "returned to main", terminal: true,
          sourceEventId: "event-1", sourceLaneSequence: 1, updatedAt: "2026-10-09T00:00:00.000Z"
        },
        {
          scopeKey: "pane:w1:w1:p1", producerKind: "worker" as const, producerId: "worker-2", kind: "agent" as const,
          itemId: "runner", ordinal: 1, label: "Runner", state: "running", terminal: false,
          sourceEventId: "event-1b", sourceLaneSequence: 1, updatedAt: "2026-10-09T00:00:00.000Z"
        },
        {
          scopeKey: "pane:w1:w1:p1", producerKind: "worker" as const, producerId: "worker-3", kind: "agent" as const,
          itemId: "builder", ordinal: 2, label: "Builder", state: "blocked", terminal: false,
          sourceEventId: "event-1c", sourceLaneSequence: 1, updatedAt: "2026-10-09T00:00:00.000Z"
        },
        {
          scopeKey: "pane:w1:w1:p1", producerKind: "primary" as const, producerId: "primary-1", kind: "tool" as const,
          itemId: "call-1", ordinal: 0, label: "exec", state: "running", terminal: false,
          sourceEventId: "event-2", sourceLaneSequence: 2, updatedAt: "2026-10-09T00:00:01.000Z"
        }
      ]
    };
    const card = renderTurnCard(base({
      currentGoal: { objective: "Ship Answer Card activity", status: "active" },
      taskList: [{ label: "Verify Feishu", state: "active" }],
      timelineItems: [{ kind: "agent_message", id: "answer", sequence: 1, markdown: "Canonical answer" }]
    }), { pageIndex: 0 }, { sessionActivity: activity }) as RenderedTurnCard;
    const rendered = text(card.body.elements);

    expect(rendered).not.toContain("Session Activity");
    expect(rendered).toContain("Subagents");
    expect(rendered).toContain("Runner");
    expect(rendered).not.toContain("returned to main");
    const subagentsPanel = (card.body.elements as Array<{ tag?: string; expanded?: boolean; header?: { title?: { content?: string } }; elements?: Array<{ tag?: string; content?: string }> }>).find((element) => element.tag === "collapsible_panel" && element.header?.title?.content?.includes("Subagents"));
    expect(subagentsPanel).toMatchObject({ tag: "collapsible_panel", expanded: true });
    expect(subagentsPanel?.elements).toHaveLength(1);
    expect(subagentsPanel?.elements?.[0]).toMatchObject({ tag: "markdown" });
    const subagentRows = subagentsPanel?.elements?.[0]?.content?.split("\n") ?? [];
    expect(subagentRows.length).toBeGreaterThan(0);
    expect(subagentRows.every((row) => row.startsWith("- "))).toBe(true);
    expect(subagentRows.join("\n")).toContain("Runner");
    expect(JSON.stringify(card)).not.toContain("<at id=ou_attacker></at>");
    expect(rendered).toContain("Compacted 1");
    expect(rendered).not.toContain("exec");
    expect(rendered.indexOf("🎯 Goal")).toBeLessThan(rendered.indexOf("Task List"));
    expect(rendered.indexOf("Task List")).toBeLessThan(rendered.indexOf("Subagents"));
    expect(rendered.indexOf("Subagents")).toBeLessThan(rendered.indexOf("Compacted 1"));
  });

  it("renders one bounded authoritative Session State section on the current Turn Card", () => {
    const card = renderTurnCard(base({
      timelineItems: [{ kind: "agent_message", id: "answer", sequence: 1, markdown: "Canonical answer" }]
    }), { pageIndex: 0 }, { sessionState: {
      paneIdentity: {
        workspace: "/repo/.worktree/reviewer", worktreeName: "reviewer", branch: "swarm/reviewer",
        paneId: "w1:p1", paneToken: "prim"
      },
      modelUsage: {
        model: "GPT-5.6-Sol", contextRemainingPercent: 42, inputTokens: 1_200, outputTokens: 300,
        queuedAt: null, firstVisibleAt: null, completedAt: null, waitMs: 2_500, firstVisibleMs: 4_000
      },
      lastTurnState: "active",
      tokenUsage: 1_500,
      contextUsage: 58,
      compactionCount: 1,
      activeSubagents: [{ label: "Runner", state: "running" }]
    } } as never) as RenderedTurnCard;
    const rendered = text(card.body.elements);

    expect(rendered).toContain("Session State");
    const sessionSummary = (card.body.elements as Array<{ tag?: string; content?: string }>).find((element) => element.tag === "markdown" && element.content?.includes("Session State"));
    expect(sessionSummary?.content).toContain("🟢 运行中");
    expect(rendered).toContain("GPT\\-5\\.6\\-Sol");
    expect(sessionSummary?.content).toContain("ctx 42%");
    expect(sessionSummary?.content).toContain("1.20K in · 300 out");
    expect(sessionSummary?.content).toContain("🧹 1x");
    const detailsPanel = (card.body.elements as Array<{ tag?: string; expanded?: boolean; header?: { title?: { content?: string } }; elements?: Array<{ tag?: string; content?: string }> }>).find((element) => element.tag === "collapsible_panel" && element.header?.title?.content?.includes("Session details"));
    expect(detailsPanel).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(detailsPanel?.elements?.[0]?.content).toContain("reviewer");
    expect(detailsPanel?.elements?.[0]?.content).toContain("swarm/reviewer");
    expect(detailsPanel?.elements?.[0]?.content).toContain("2.50s");
    const subagentsPanel = (card.body.elements as Array<{ tag?: string; expanded?: boolean; header?: { title?: { content?: string } }; elements?: Array<{ tag?: string; content?: string }> }>).find((element) => element.tag === "collapsible_panel" && element.header?.title?.content?.includes("Subagents"));
    expect(subagentsPanel).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(subagentsPanel?.elements).toHaveLength(1);
    expect(subagentsPanel?.elements?.[0]?.content).toContain("- 🟢 Runner · 运行中");
    expect(subagentsPanel?.elements?.[0]?.content).not.toContain("🟢 Runner · 🟢");
    expect(card.header.title.content).toContain("demo / reviewer · Model: GPT-5.6-Sol");
    expect(card.header.title.content).not.toContain("w1:p1");
    expect(card.header.title.content).not.toContain("prim");
  });

  it("fingerprints only rendered state and filters terminal Subagents from the active list", () => {
    const topic = {
      paneIdentity: { workspace: "/repo", worktreeName: "main", branch: "swarm/main", paneId: "w1:p1", paneToken: "prim" },
      model: "GPT-5.6-Sol",
      modelUsage: { model: "GPT-5.6-Sol", contextRemainingPercent: 42, inputTokens: 1200, outputTokens: 300, waitMs: 25, firstVisibleMs: 40 }
    };
    const activity = {
      snapshot: { lastTurnState: "active" as const, tokenUsage: 1500, contextUsage: 58, compactionCount: 1 },
      items: [
        { kind: "agent" as const, terminal: false, label: "Runner", state: "running" },
        { kind: "agent" as const, terminal: true, label: "Completed", state: "completed" },
        { kind: "tool" as const, terminal: false, label: "exec", state: "running" }
      ]
    };
    const state = turnSessionStateView(topic as never, activity as never)!;

    expect(state.activeSubagents).toEqual([{ label: "Runner", state: "running" }]);
    expect(turnSessionStatePresentationFingerprint(state)).toBe(turnSessionStatePresentationFingerprint({ ...state }));
    expect(turnSessionStatePresentationFingerprint(state)).not.toBe(turnSessionStatePresentationFingerprint({ ...state, lastTurnState: "completed" }));
  });

  it("renders only the trusted completion mention and fabricates no action buttons", () => {
    const card = renderTurnCard(base({
      state: "completed",
      timelineItems: [{ kind: "agent_message", id: "answer", sequence: 1, markdown: "Done <at id=ou_attacker></at>" }]
    }), { pageIndex: 0 }, { completionNotice: { mentionOpenId: "ou_exact_requester", reason: "final_request" } });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("<at id=ou_exact_requester></at>");
    expect(serialized).not.toContain("ou_attacker");
    expect(serialized).not.toContain("completion_action");
    expect(serialized).not.toContain('"tag":"button"');
  });

  it("keeps Human Review controls before a long Answer Timeline", () => {
    const action = {
      state: "available" as const, id: "choice", ownerKind: "primary-segment" as const,
      ownerId: "segment-1", ownerGeneration: 1, cardMessageId: "message-1", mentionOpenId: "ou_requester",
      choicePrompt: {
        question: "Which path?", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: []
      }
    };
    const activity = {
      snapshot: {
        scopeKey: "pane:w:p", workspaceId: "w", paneId: "p", bindingId: "b", bindingGeneration: 1,
        sessionEpoch: 1, nativeSessionId: "s", revision: 1, currentModel: null, currentGoal: null,
        lastTurnId: "t", lastTurnState: "active" as const, compactionCount: 1, tokenUsage: null,
        contextUsage: null, updatedAt: "2026-10-09T00:00:00.000Z"
      },
      items: [{
        scopeKey: "pane:w:p", producerKind: "worker" as const, producerId: "worker", kind: "agent" as const,
        itemId: "reviewer", ordinal: 0, label: "Reviewer", state: "running", terminal: false,
        sourceEventId: "event", sourceLaneSequence: 1, updatedAt: "2026-10-09T00:00:00.000Z"
      }]
    };
    const rendered = text(renderTurnCard(base({
      state: "completed", timelineItems: [
        ...Array.from({ length: 12 }, (_, index) => ({ kind: "agent_message" as const, id: `progress-${index}`, sequence: index + 1, markdown: `Progress ${index}` })),
        { kind: "final_answer", id: "final", sequence: 13, markdown: "Canonical answer" }
      ],
      currentGoal: { objective: "Ship it", status: "active" }, taskList: [{ label: "Verify", state: "active" }]
    }), { pageIndex: 0 }, {
      completionActions: action,
      completionNotice: { mentionOpenId: "ou_requester", reason: "both" },
      sessionActivity: activity
    }));

    const ordered = ["Which path?", "Approve", "ou_requester", "Progress 0", "Canonical answer", "🎯 Goal", "Task List", "Subagents", "Compacted 1"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(rendered.indexOf(ordered[index - 1]!)).toBeLessThan(rendered.indexOf(ordered[index]!));
    }
  });

  it("reserves the final completion mention budget without rendering it on an overflow page", () => {
    const view = base({ state: "completed", timelineItems: Array.from({ length: 8 }, (_, index) => ({
      kind: "agent_message" as const, id: `message:${index}`, sequence: index + 1, markdown: `message-${index} ${"x".repeat(240)}`
    })) });
    const notice = { mentionOpenId: "ou_exact_requester", reason: "final_request" as const };
    const hidden = planAndRenderTurnCard(view, { pageIndex: 0 }, { completionNotice: null, completionNoticeBudget: notice }, 1_800);
    const visible = planAndRenderTurnCard(view, { pageIndex: 0 }, { completionNotice: notice }, 1_800);

    expect(hidden.nextCursor).not.toBeNull();
    expect(hidden.nextCursor).toEqual(visible.nextCursor);
    expect(hidden.items.map(({ id }) => id)).toEqual(visible.items.map(({ id }) => id));
    expect(JSON.stringify(hidden.card)).not.toContain("ou_exact_requester");
    expect(JSON.stringify(visible.card)).toContain("<at id=ou_exact_requester></at>");
  });

  it("omits an unavailable Tab component without inventing or parsing one", () => {
    const card = renderTurnCard(base({ projectLabel: "herdr-agent-swarm", tabLabel: null, paneToken: "9e2u" }));
    expect(text(card)).toContain("herdr-agent-swarm / 9e2u");
  });

  it("keeps Worker and continuation identities on the same compact title contract", () => {
    const card = renderTurnCard(base({
      ownerKind: "worker", ownerLabel: "worker-old-title", projectLabel: "herdr-agent-swarm",
      tabLabel: "worker-a", paneToken: "wk9x"
    }), { pageIndex: 1 }, { continuation: true }) as RenderedTurnCard;
    const value = text(card);
    expect(value).toContain("herdr-agent-swarm / worker-a / wk9x");
    expect(value).toContain("第 2 页");
    expect(card.header.title.content).toContain("第 2 页");
    expect(text(card.body.elements)).not.toContain("第 2 页");
    expect(value).not.toContain("worker-old-title");
  });

  it("bounds the request in the reply title and keeps thinking collapsed", () => {
    const request = "request ".repeat(600);
    const card = renderTurnCard(base({ requestText: request, timelineItems: [{ kind: "thinking", id: "thinking:1", sequence: 1, label: "plan", markdown: "full thinking text" }] })) as RenderedTurnCard;
    const serialized = JSON.stringify(card);
    expect(card.header.subtitle.content).toMatch(/^reply to 👤: request /);
    expect(card.header.subtitle.content.length).toBeLessThanOrEqual(80);
    expect(text(card.body.elements)).not.toContain(request.trim());
    expect(serialized).toContain("full thinking text");
    expect(serialized).toContain('"expanded":false');
  });

  it("uses the same reply title and no request body on first and continuation pages", () => {
    const first = renderTurnCard(base({ requestText: "inspect the release" })) as RenderedTurnCard;
    const continuation = renderTurnCard(base({ requestText: "inspect the release" }), { pageIndex: 1 }, { continuation: true }) as RenderedTurnCard;

    expect(first.header.title.content).toBe("Working · demo / a1j3 / 9e2u");
    expect(first.header.subtitle.content).toBe("reply to 👤: inspect the release");
    expect(continuation.header.title.content).toBe("Working · demo / a1j3 / 9e2u  ·  第 2 页");
    expect(continuation.header.subtitle.content).toBe("reply to 👤: inspect the release");
    expect(text(first.body.elements)).not.toContain("Human Request");
    expect(text(first.body.elements)).not.toContain("inspect the release");
    expect(text(continuation.body.elements)).not.toContain("Human Request");
    expect(text(continuation.body.elements)).not.toContain("inspect the release");
    expect(first.body.elements).toEqual([]);
  });

  it("normalizes and redacts the title without splitting emoji boundaries", () => {
    const card = renderTurnCard(base({ requestText: `${"a".repeat(65)}😀tail\napi_key="super-secret"` })) as RenderedTurnCard;
    expect(card.header.subtitle.content).toBe(`reply to 👤: ${"a".repeat(65)}…`);
    expect(card.header.subtitle.content).not.toContain("super-secret");
    expect(card.header.subtitle.content).not.toContain("�");
    expect(card.header.subtitle.content.length).toBeLessThanOrEqual(80);
  });

  it("collapses whitespace and renders the exact redacted title", () => {
    const card = renderTurnCard(base({ requestText: "first\nsecond\tapi_key=super-secret" })) as RenderedTurnCard;
    expect(card.header.subtitle.content).toBe("reply to 👤: first second api_key=[REDACTED]");
  });

  it("renders canonical Task List states with distinct progress icons", () => {
    const card = renderTurnCard(base({ taskList: [
      { label: "Inspect", state: "done" },
      { label: "Implement", state: "active" },
      { label: "Review", state: "pending" },
      { label: "Recover", state: "failed" }
    ] })) as { body: { elements: Array<{ tag?: string; expanded?: boolean; header?: { title?: { content?: string } }; elements?: unknown[] }> } };
    const serialized = JSON.stringify(card);
    const taskList = card.body.elements.find((element) => element.header?.title?.content?.startsWith("📋 Task List"));

    expect(taskList).toMatchObject({ tag: "collapsible_panel", expanded: true });
    expect(taskList?.header?.title?.content).toBe("📋 Task List · 4 项");
    expect(serialized).toContain("✓ • Inspect");
    expect(serialized).toContain("◌ • Implement");
    expect(serialized).toContain("☐ • Review");
    expect(serialized).toContain("✕ • Recover");
  });

  it("shows an explicit waiting status without assistant text and keeps Worker identity", () => {
    const card = renderTurnCard(base({ ownerKind: "worker", ownerLabel: "Worker A", tabLabel: "Worker A", timelineItems: [{ kind: "status", id: "status:1", sequence: 1, label: "Waiting for command", state: "blocked" }] }));
    expect(text(card)).toContain("Waiting for command");
    expect(text(card)).toContain("Worker A");
  });

  it("redacts secrets and repeats compact request context on continuation pages", () => {
    const card = renderTurnCard(base({ requestText: 'api_key="super-secret"\u001b[31m', timelineItems: [] }), { pageIndex: 1 }, { continuation: true });
    const value = JSON.stringify(card);
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("\\u001b");
    expect(value).toContain("reply to 👤:");
    expect(value).not.toContain("Human Request");
    expect(value).toContain("第 2 页");
  });

  it("advances through one canonical timeline using the supplied page cursor", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ kind: "agent_message" as const, id: `message:${index}`, sequence: index + 1, markdown: `canonical-message-${index} ${"x".repeat(180)}` }));
    const first = planTurnCardTimeline(items, { pageIndex: 0 }, 500);
    expect(first.nextCursor).not.toBeNull();
    const second = planTurnCardTimeline(items, { pageIndex: 1, startCursor: first.nextCursor }, 500);
    expect(second.items.map((item) => item.id)).not.toEqual(expect.arrayContaining(first.items.map((item) => item.id)));
    expect(second.nextCursor).not.toEqual(first.nextCursor);
    const page0 = text(renderTurnCard(base({ timelineItems: items }), { pageIndex: 0, startCursor: null }, {}, 1_800));
    const page1 = text(renderTurnCard(base({ timelineItems: items }), { pageIndex: 1, startCursor: first.nextCursor }, {}, 1_800));
    expect(page0).toContain("canonical-message-0");
    expect(page1).not.toContain("canonical-message-0");
  });

  it("keeps worst-case structured content within the configured payload limit", () => {
    const limit = 9_000;
    const card = renderTurnCard(base({
      ownerKind: "worker", ownerLabel: "Worker worst-case", requestText: "human ".repeat(2_000), gapWarning: "gap ".repeat(500),
      currentGoal: { objective: "goal ".repeat(500), status: "blocked" }, taskList: Array.from({ length: 12 }, (_, index) => ({ label: `task-${index} ${"detail ".repeat(40)}`, state: "running" })),
      timelineItems: [{ kind: "agent_message", id: "long", sequence: 1, markdown: "timeline ".repeat(4_000) }]
    }), { pageIndex: 0 }, { completionActions: { state: "consumed", ignored: true, id: "a", ownerKind: "primary-prompt", ownerId: "p", ownerGeneration: 1, cardMessageId: "m" } }, limit);
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(limit);
  });

  it("bounds an oversized first item at the minimum practical limit and keeps its cursor ownership", () => {
    const items = [
      { kind: "agent_message" as const, id: "assistant:huge", sequence: 1, markdown: "assistant ".repeat(8_000) },
      { kind: "thinking" as const, id: "thinking:huge", sequence: 2, label: "plan", markdown: "thinking ".repeat(8_000) },
      { kind: "status" as const, id: "wait:huge", sequence: 3, label: "Waiting for command", state: "blocked" as const }
    ];
    const limit = 2_000;
    const first = planTurnCardTimeline(items, { pageIndex: 0 }, 300);
    const card = renderTurnCard(base({ requestText: "human ".repeat(400), gapWarning: "gap ".repeat(100), timelineItems: items }), { pageIndex: 0, startCursor: null }, {}, limit);
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(limit);
    expect(JSON.stringify(card)).toContain("内容已截断");
    expect(first.nextCursor).not.toBeNull();
    const next = planTurnCardTimeline(items, { pageIndex: 1, startCursor: first.nextCursor }, 300);
    expect(next.nextCursor).not.toEqual(first.nextCursor);
    expect(JSON.stringify(card)).toContain("内容已截断");
  });

  it("returns a bounded explicit overflow marker for tool, waiting, and action-only fixed payloads", () => {
    const actionSet = { state: "available" as const, id: "action", ownerKind: "primary-prompt" as const, ownerId: "p", ownerGeneration: 1, cardMessageId: "m", mentionOpenId: "u" };
    for (const timelineItems of [
      [{ kind: "tool" as const, id: "tool:huge", sequence: 1, category: "command" as const, label: "huge tool", result: "output ".repeat(20_000), state: "failed" as const }],
      [{ kind: "status" as const, id: "wait", sequence: 1, label: "Waiting for command", state: "blocked" as const }]
    ]) {
      const card = renderTurnCard(base({ timelineItems, requestText: "request" }), { pageIndex: 0 }, { completionActions: actionSet }, 1_500);
      expect(JSON.stringify(card).length).toBeLessThanOrEqual(1_500);
      expect(JSON.stringify(card)).toContain("内容超出配置上限");
    }
  });

  it("fails deterministically when even the identity-bearing minimum cannot fit", () => {
    expect(() => renderTurnCard(base({ requestText: "x" }), { pageIndex: 0 }, {}, 50)).toThrow(TurnCardPayloadOverflowError);
  });
});
