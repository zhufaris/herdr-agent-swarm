import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PromptRunWorkflow } from "../src/coordinator/prompt-run-workflow.js";
import { DetachedPromptObserver } from "../src/coordinator/detached-prompt-observer.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { TestConversationViewProjector as ConversationViewProjector } from "./helpers/create-test-conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { inspectTraceEndReviewProtocol } from "../src/domain/completion-choice.js";

describe("detached Bridge Prompt recovery from settled Core events", () => {
  it("turns an expired exact-turn cursor into durable needs-human after a fresh runtime check without replay", async () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    expect(stores.driver.applyPromptNativeSubmissionReceipt({
      promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1",
      dispatchedAt: "2026-10-01T10:04:48.000Z", state: "accepted",
      notice: "Core accepted the native submission; observing without replay"
    })).toBe(true);
    stores.driver.database.prepare(`UPDATE prompt_jobs
      SET state='running', observation_state='detached', transcript_turn_id='turn-1',
        transcript_turn_started_at='2026-10-01T10:04:48.000Z'
      WHERE id='prompt-1'`).run();
    const observeRuntime = vi.fn(async () => ({
      pane: {
        paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"],
        agentState: "idle" as const,
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      },
      traexProcess: true, composerReady: true, evidenceSource: "structured" as const
    }));
    let activeChecks = 0;
    const observer = new DetachedPromptObserver({
      store: stores.promptRecovery,
      herdr: { observeRuntime },
      transcript: {
        async openDetached() { return { mode: "unavailable" as const, reason: "cursor_expired" }; },
        async read(source: unknown) { return { source, observation: { answerDelta: "" }, accepted: false }; },
        async own(_binding: unknown, prompt: unknown, observation: unknown) { return { owned: false, prompt, observation }; },
        retain() {}, async publishOwned() {}
      },
      registry: { attachTurn: () => new AbortController(), updateTurnState: vi.fn(), detachTurn: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => activeChecks++ === 0, isStopping: () => false,
      publish: vi.fn(), renderRunCard: primaryPresentation.answerCard
    } as never);

    await observer.observe(stores.driver.getPrompt("prompt-1")!);

    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(stores.driver.getPrompt("prompt-1")).toMatchObject({
      state: "uncertain", observationState: "completed", transcriptTurnId: "turn-1"
    });
    expect(stores.driver.loadRunCard("prompt-1")).toMatchObject({ phase: "uncertain" });
    expect(stores.driver.getRecoveryStageForBinding("b1")).toBe("needs_human");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='turn.recovery.cursor_gap'").get()).toEqual({ count: 1 });
    stores.driver.close();
  });

  it("repairs an uncertain Prompt without replaying an invalid historical continuation", () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    const create = stores.driver.listPendingOutboundReplies().find((reply) => reply.promptId === "prompt-1" && reply.kind === "stream_card_create")!;
    stores.driver.markOutboundReplyDelivered(create.id, "answer-prompt-1", "card-prompt-1");
    expect(stores.promptRecovery.skipOldestDetachedPrompt({
      bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "user-1", sourceMessageId: "skip-1",
      reason: "result uncertain", occurredAt: "2026-10-01T10:04:59.000Z", rootMessageId: "root",
      renderRunCard: primaryPresentation.answerCard
    })).toMatchObject({ outcome: "skipped", promptId: "prompt-1" });
    expect(stores.promptRecovery.scanDurablePromptWork().hints).not.toContainEqual({ kind: "detached-observer-ready", bindingId: "b1", promptId: "prompt-1" });
    stores.driver.updateBinding("b1", { lastAgentState: "idle", lastOutputFingerprint: "newer-turn" });
    seedSettledCompletedTurn(stores, "prompt-1");
    expect(stores.promptRecovery.scanDurablePromptWork().hints).toContainEqual({ kind: "detached-observer-ready", bindingId: "b1", promptId: "prompt-1" });

    const input = {
      promptId: "prompt-1", bindingId: "b1", expectedBindingGeneration: 1,
      expectedPaneId: "w1:p1", expectedNativeSessionId: "session-1", occurredAt: "2026-10-01T10:05:00.000Z",
      renderRunCard: primaryPresentation.answerCard
    };
    expect(stores.promptRecovery.recoverProjectedBridgeTurn(input)).toEqual({
      outcome: "recovered", terminalState: "completed", answer: "historical final answer", turnId: "turn-1",
      recoveryMode: "late", outboxReserved: false,
      completionActionEligibility: { outcome: "skipped", reason: "historical-recovery" }
    });
    expect(stores.driver.getPrompt("prompt-1")).toMatchObject({ state: "delivered", observationState: "completed", transcriptTurnId: "turn-1" });
    expect(stores.driver.getBinding("b1")).toMatchObject({ lastAgentState: "idle", lastOutputFingerprint: "newer-turn" });
    expect(stores.driver.database.prepare("SELECT page_index, state, message_id FROM answer_pages WHERE prompt_id='prompt-1' ORDER BY page_index").all()).toEqual([
      { page_index: 0, state: "frozen", message_id: "answer-prompt-1" },
      { page_index: 1, state: "creating", message_id: null }
    ]);
    const continuations = stores.driver.database.prepare(`SELECT idempotency_key,state,error,gateway_plan_hash
      FROM outbound_replies WHERE prompt_id='prompt-1' AND kind='stream_card_create'
        AND idempotency_key LIKE 'prompt-recovery-continuation:%'`).all();
    expect(continuations).toEqual([{
      idempotency_key: "prompt-recovery-continuation:prompt-1:turn-1:completed",
      state: "dead_letter", error: "Gateway plan preparation failed", gateway_plan_hash: null
    }]);
    expect(stores.driver.listPendingOutboundReplies().filter((reply) => reply.idempotencyKey.startsWith("primary-next-input:"))).toHaveLength(0);

    expect(stores.promptRecovery.recoverProjectedBridgeTurn(input)).toEqual({ outcome: "stale" });
    expect(stores.driver.listPendingOutboundReplies().filter((reply) => reply.idempotencyKey.startsWith("prompt-recovery-continuation:"))).toHaveLength(0);
    expect(stores.driver.database.prepare("SELECT page_index, state, message_id FROM answer_pages WHERE prompt_id='prompt-1' ORDER BY page_index").all()).toEqual([
      { page_index: 0, state: "frozen", message_id: "answer-prompt-1" },
      { page_index: 1, state: "creating", message_id: null }
    ]);
    stores.driver.close();
  });

  it("repairs an uncertain aborted Prompt without publishing an old-page lifecycle event", async () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    expect(stores.promptRecovery.skipOldestDetachedPrompt({
      bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "user-1", sourceMessageId: "skip-1",
      reason: "result uncertain", occurredAt: "2026-10-01T10:04:59.000Z", rootMessageId: "root",
      renderRunCard: primaryPresentation.answerCard
    })).toMatchObject({ outcome: "skipped" });
    seedSettledAbortedTurn(stores, "prompt-1");

    const publish = vi.fn(async () => {});
    const outboundWake = vi.fn();
    const workflow = new PromptRunWorkflow({
      stores: { dispatch: stores.promptDispatch, recovery: stores.promptRecovery, session: stores.promptSession },
      herdr: {} as never, bus: { publish }, scheduler: { subscribe: () => () => {}, wake: vi.fn() },
      outboundWork: { wake: outboundWake, subscribe() { return () => {}; } }, presentation: primaryPresentation,
      turnTimeoutMs: 1_000, bindingPrompts: { applyCoreObservation: vi.fn(async () => ({ outcome: "ignored" as const, owned: false as const, terminal: null, prompt: null })) },
      logger: pino({ enabled: false })
    });
    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "prompt-1" });
    await vi.waitFor(() => expect(stores.driver.getPrompt("prompt-1")).toMatchObject({ state: "failed", observationState: "completed" }));

    expect(stores.driver.getPrompt("prompt-1")).toMatchObject({ state: "failed", observationState: "completed", error: "TraeX turn was aborted: cancelled" });
    expect(stores.driver.loadRunCard("prompt-1")).toMatchObject({ phase: "failed", notice: "TraeX turn was aborted: cancelled" });
    expect(stores.driver.database.prepare(`SELECT state,error,gateway_plan_hash FROM outbound_replies
      WHERE idempotency_key='prompt-recovery-continuation:prompt-1:turn-1:aborted'`).get()).toEqual({
      state: "dead_letter", error: "Gateway plan preparation failed", gateway_plan_hash: null
    });
    expect(publish).not.toHaveBeenCalled();
    expect(outboundWake).not.toHaveBeenCalled();
    await workflow.stop();
    stores.driver.close();
  });

  it("atomically restores exact ownership and the final Answer without replaying the Prompt", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "ou_creator" });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const view = createQueuedRunCard({
      promptId: "prompt-1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1",
      requestText: "recover me", queuePosition: 1, occurredAt: "2026-10-01T10:04:47.000Z"
    });
    stores.driver.acceptPrompt({
      prompt: { id: "prompt-1", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "user-1", body: "recover me" },
      view, rootMessageId: "root", answerCard: {}
    });
    expect(stores.driver.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("prompt-1");
    expect(stores.driver.markPromptNativeQueued({
      promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1", dispatchedAt: "2026-10-01T10:04:48.000Z"
    })).toBe(true);
    stores.promptRecovery.recoverRunningPrompts();
    stores.driver.database.prepare("UPDATE run_cards SET phase='running' WHERE prompt_id='prompt-1'").run();

    const events: CoreEventEnvelope[] = [
      { schemaVersion: 1, eventId: "historical-start", cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.568Z", payload: { type: "turn_started" } },
      { schemaVersion: 1, eventId: "historical-human", cursor: "c2", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.700Z", payload: { type: "human_message", message_id: "human-1", text: "recover me", truncated: false, submission_id: "prompt-1" } },
      { schemaVersion: 1, eventId: "historical-commentary", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:55.000Z", payload: { type: "message", message_id: "commentary-1", channel: "commentary", text: "```herdr-choice-list\n{\"version\":3,\"choice\":{\"question\":\"继续吗？\",\"defaultOption\":{\"id\":\"yes\",\"label\":\"继续\",\"submitText\":\"继续\"},\"alternatives\":[]}}\n```", truncated: false } },
      { schemaVersion: 1, eventId: "historical-final", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:56.242Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "historical final answer", truncated: false } },
      { schemaVersion: 1, eventId: "historical-completed", cursor: "c5", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:56.392Z", payload: { type: "turn_completed" } }
    ];
    stores.coreEvents.ingestBatch({
      laneId: "lane-historical", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: "c5", latestCursor: "c5", events, ingestedAt: "2026-10-01T10:04:57.000Z"
    });
    stores.coreEvents.acknowledge("lane-historical", events.map(({ eventId }) => eventId), "projected", "2026-10-01T10:04:57.100Z", undefined, { kind: "binding", id: "b1" });

    const input = {
      promptId: "prompt-1", bindingId: "b1", expectedBindingGeneration: 1,
      expectedPaneId: "w1:p1", expectedNativeSessionId: "session-1", occurredAt: "2026-10-01T10:05:00.000Z"
    };
    expect(stores.promptRecovery.recoverProjectedBridgeTurn(input)).toEqual({
      outcome: "recovered", terminalState: "completed", answer: "historical final answer", turnId: "turn-1",
      completionActionEligibility: { outcome: "deferred" }
    });
    expect(stores.driver.getPrompt("prompt-1")).toMatchObject({
      state: "delivered", observationState: "completed", transcriptTurnId: "turn-1",
      transcriptTurnStartedAt: "2026-10-01T10:04:48.000Z"
    });
    expect(stores.driver.database.prepare(`SELECT prompt_id, binding_id, binding_generation, pane_id,
      native_session_id, turn_id, started_at FROM prompt_transcript_turns WHERE prompt_id='prompt-1'`).all()).toEqual([{
      prompt_id: "prompt-1", binding_id: "b1", binding_generation: 1, pane_id: "w1:p1",
      native_session_id: "session-1", turn_id: "turn-1", started_at: "2026-10-01T10:04:48.000Z"
    }]);
    expect(stores.driver.loadRunCard("prompt-1")).toMatchObject({ phase: "completed", answer: "historical final answer" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id='prompt-1'").get()).toEqual({ count: 1 });
    expect(stores.driver.listPendingOutboundReplies().filter((reply) => reply.idempotencyKey === "primary-next-input:b1:1:prompt-1")).toHaveLength(0);
    expect(stores.driver.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind = 'primary-prompt' AND owner_id = 'prompt-1'").get()).toEqual({ state: "waiting_for_answer" });
    expect(stores.promptRecovery.recoverProjectedBridgeTurn(input)).toEqual({ outcome: "stale" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='turn.recovery.bridge_projected'").get()).toEqual({ count: 1 });
    stores.driver.close();
  });

  it("uses Core lane sequence so a later explicit none clears an older detached review", () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    const attemptCountBefore = stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id='prompt-1'").get();
    seedSettledCompletedTurn(stores, "prompt-1", [
      { schemaVersion: 1, eventId: "z-earlier-review", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:09:00.000Z", payload: { type: "message", message_id: "review-1", channel: "commentary", text: v3ReviewFence("Earlier review?"), truncated: false } },
      { schemaVersion: 1, eventId: "a-later-none", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:03:00.000Z", payload: { type: "message", message_id: "none-1", channel: "commentary", text: v3NoneFence(), truncated: false } },
      { schemaVersion: 1, eventId: "m-plain-final", cursor: "c5", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:02:00.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "lane ordered answer", truncated: false } }
    ]);

    expect(stores.promptRecovery.recoverProjectedBridgeTurn(recoveryInput())).toEqual({
      outcome: "recovered", terminalState: "completed", answer: "lane ordered answer", turnId: "turn-1",
      completionActionEligibility: { outcome: "deferred" }
    });
    expect(stores.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt'").get()).toEqual({ question: "是否继续？", default_option_id: "continue" });
    expect(stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id='prompt-1'").get()).toEqual(attemptCountBefore);
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id='lane-prompt-1' ORDER BY sequence").all()).toEqual(Array.from({ length: 6 }, () => ({ state: "projected" })));
    expect(stores.coreEvents.getCheckpoint("lane-prompt-1")).toMatchObject({ readCursor: "c6" });
    stores.driver.close();
  });

  it("uses Core lane sequence instead of timestamps and event IDs to select the later detached review", () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    seedSettledCompletedTurn(stores, "prompt-1", [
      { schemaVersion: 1, eventId: "z-earlier-none", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:09:00.000Z", payload: { type: "message", message_id: "none-1", channel: "commentary", text: v3NoneFence(), truncated: false } },
      { schemaVersion: 1, eventId: "a-later-review", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:03:00.000Z", payload: { type: "message", message_id: "review-1", channel: "commentary", text: v3ReviewFence("Later review?", "later"), truncated: false } },
      { schemaVersion: 1, eventId: "m-plain-final", cursor: "c5", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:02:00.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "lane ordered answer", truncated: false } }
    ]);

    expect(stores.promptRecovery.recoverProjectedBridgeTurn(recoveryInput())).toMatchObject({
      outcome: "recovered", answer: "lane ordered answer", completionActionEligibility: { outcome: "deferred" }
    });
    expect(stores.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt'").get()).toEqual({
      question: "Later review?", default_option_id: "later"
    });
    stores.driver.close();
  });

  it("keeps valid native final metadata authoritative over detached textual evidence", () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    seedSettledCompletedTurn(stores, "prompt-1", [
      { schemaVersion: 1, eventId: "text-review", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:50.000Z", payload: { type: "message", message_id: "review-1", channel: "commentary", text: v3ReviewFence("Text review?", "text"), truncated: false } },
      { schemaVersion: 1, eventId: "native-final", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:51.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "native answer", truncated: false, completion_choice: { version: 2, intent: "human_review", question: "Native review?", default: "native", options: [{ id: "native", label: "Native", message: "default" }] } } }
    ]);

    expect(stores.promptRecovery.recoverProjectedBridgeTurn(recoveryInput())).toMatchObject({
      outcome: "recovered", answer: "native answer", completionActionEligibility: { outcome: "deferred" }
    });
    expect(stores.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt'").get()).toEqual({
      question: "Native review?", default_option_id: "native"
    });
    stores.driver.close();
  });

  it.each([
    ["null", null],
    ["text scalar", JSON.stringify({ version: 2, intent: "human_review", question: "Wrapped native?", default: "wrapped", options: [{ id: "wrapped", label: "Wrapped", message: "default" }] })],
    ["number", 3],
    ["boolean", true],
    ["array", []],
    ["malformed object", { version: 2 }]
  ])("fails closed on present malformed native %s metadata without textual fallback", (_label, malformedNative) => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    seedMalformedNativeCompletedTurn(stores, malformedNative);

    expect(stores.promptRecovery.recoverProjectedBridgeTurn(recoveryInput())).toMatchObject({
      outcome: "recovered", answer: "fail closed answer", completionActionEligibility: { outcome: "skipped", reason: "no-review-choice" }
    });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt'").get()).toEqual({ count: 0 });
    stores.driver.close();
  });

  it("does not let v1, truncated, invalid, or oversized text create or clear a detached review", () => {
    const oversizedReview = completeOversizedV3ReviewFence();
    expect(Buffer.byteLength(oversizedReview, "utf8")).toBeGreaterThan(8_192);
    const oversizedPayload = JSON.parse(oversizedReview.slice("```herdr-choice-list\n".length, -"\n```".length)) as {
      choice: { defaultOption: { submitText: string }; alternatives: Array<{ submitText: string }> };
    };
    expect([oversizedPayload.choice.defaultOption, ...oversizedPayload.choice.alternatives].every(({ submitText }) => submitText.length <= 2_000)).toBe(true);
    expect(inspectTraceEndReviewProtocol(oversizedReview, { terminal: true })).toMatchObject({ kind: "invalid", reason: "oversized" });
    const excluded = [
      { schemaVersion: 1, eventId: "v1-none", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:50.000Z", payload: { type: "message", message_id: "v1", channel: "commentary", text: "```herdr-choice-list\n{\"version\":1}\n```", truncated: false } },
      { schemaVersion: 1, eventId: "truncated-none", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:51.000Z", payload: { type: "message", message_id: "truncated", channel: "commentary", text: v3NoneFence(), truncated: true } },
      { schemaVersion: 1, eventId: "invalid-none", cursor: "c5", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:52.000Z", payload: { type: "message", message_id: "invalid", channel: "commentary", text: "```herdr-choice-list\n{\"version\":3,\"extra\":true}\n```", truncated: false } },
      { schemaVersion: 1, eventId: "oversized-review", cursor: "c6", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:53.000Z", payload: { type: "message", message_id: "oversized", channel: "commentary", text: oversizedReview, truncated: false } }
    ] satisfies CoreEventEnvelope[];

    const excludedOnly = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(excludedOnly, "prompt-1");
    seedSettledCompletedTurn(excludedOnly, "prompt-1", [
      ...excluded,
      { schemaVersion: 1, eventId: "excluded-final", cursor: "c7", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:54.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "excluded answer", truncated: false } }
    ]);
    expect(excludedOnly.promptRecovery.recoverProjectedBridgeTurn(recoveryInput())).toMatchObject({ completionActionEligibility: { outcome: "skipped", reason: "no-review-choice" } });
    expect(excludedOnly.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt'").get()).toEqual({ count: 0 });
    excludedOnly.driver.close();

    const retained = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(retained, "prompt-1");
    seedSettledCompletedTurn(retained, "prompt-1", [
      { schemaVersion: 1, eventId: "valid-review", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:49.000Z", payload: { type: "message", message_id: "review-1", channel: "commentary", text: v3ReviewFence("Retained review?", "retained"), truncated: false } },
      ...excluded.map((event, index) => ({ ...event, eventId: `retained-${event.eventId}`, cursor: `c${index + 4}` })),
      { schemaVersion: 1, eventId: "retained-final", cursor: "c8", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:54.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "retained answer", truncated: false } }
    ]);
    expect(retained.promptRecovery.recoverProjectedBridgeTurn(recoveryInput())).toMatchObject({ completionActionEligibility: { outcome: "deferred" } });
    expect(retained.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt'").get()).toEqual({
      question: "Retained review?", default_option_id: "retained"
    });
    retained.driver.close();
  });

  it("takes needs-human without settling or replay when a submission-correlated human event belongs to two lanes", () => {
    const stores = createTestStoreBundle(":memory:");
    try {
      prepareDetachedPrompt(stores, "prompt-1");
      seedSettledCompletedTurn(stores, "prompt-1");
      const attemptCountBefore = stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id='prompt-1'").get();
      const duplicateHuman: CoreEventEnvelope = {
        schemaVersion: 1, eventId: "prompt-1-human", cursor: "c2", sourceId: "source-1", agentKind: "traex",
        sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.700Z",
        payload: { type: "human_message", message_id: "human-1", text: "prompt-1", truncated: false, submission_id: "prompt-1" }
      };
      stores.coreEvents.ingestBatch({
        laneId: "lane-prompt-1-duplicate", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
        afterCursor: "start", nextCursor: duplicateHuman.cursor, latestCursor: duplicateHuman.cursor,
        events: [duplicateHuman], ingestedAt: "2026-10-01T10:04:58.000Z"
      });
      stores.coreEvents.acknowledge("lane-prompt-1-duplicate", [duplicateHuman.eventId], "projected", "2026-10-01T10:04:58.100Z", undefined, { kind: "binding", id: "b1" });

      expect(stores.promptRecovery.recoverProjectedBridgeTurn({ ...recoveryInput(), renderRunCard: primaryPresentation.answerCard })).toMatchObject({
        outcome: "needs_human"
      });
      expect(stores.driver.getPrompt("prompt-1")).toMatchObject({ state: "uncertain", observationState: "completed", transcriptTurnId: null });
      expect(stores.driver.loadRunCard("prompt-1")).toMatchObject({ phase: "uncertain", answer: "" });
      expect(stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id='prompt-1'").get()).toEqual(attemptCountBefore);
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM prompt_transcript_turns WHERE prompt_id='prompt-1'").get()).toEqual({ count: 0 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id='prompt-1'").get()).toEqual({ count: 0 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='turn.recovery.ambiguous'").get()).toEqual({ count: 1 });
    } finally {
      stores.lifecycle.close();
    }
  });

  it("publishes one completion effect through normal recovery and leaves later FIFO work runnable", async () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    for (const promptId of ["prompt-1", "following"] as const) {
      const view = createQueuedRunCard({
        promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1",
        requestText: promptId, queuePosition: 1, occurredAt: promptId === "prompt-1" ? "2026-10-01T10:04:47.000Z" : "2026-10-01T10:04:58.000Z"
      });
      stores.driver.acceptPrompt({
        prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "user-1", body: promptId },
        view, rootMessageId: "root", answerCard: primaryPresentation.answerCard(view)
      });
      if (promptId === "prompt-1") {
        expect(stores.driver.claimNextDispatchablePrompt("b1")?.prompt.id).toBe(promptId);
        expect(stores.driver.markPromptNativeQueued({ promptId, bindingId: "b1", submissionId: promptId, dispatchedAt: "2026-10-01T10:04:48.000Z" })).toBe(true);
        stores.promptRecovery.recoverRunningPrompts();
        stores.driver.database.prepare("UPDATE run_cards SET phase='running' WHERE prompt_id='prompt-1'").run();
      }
    }
    const create = stores.driver.listPendingOutboundReplies().find((reply) => reply.promptId === "prompt-1" && reply.kind === "stream_card_create")!;
    stores.driver.markOutboundReplyDelivered(create.id, "answer-prompt-1", "card-prompt-1");
    seedSettledCompletedTurn(stores, "prompt-1");

    const finishStreamingCard = vi.fn(async () => {});
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic", rootMessageId: "root" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "card" }; },
      async replyStreamingCard() { return { messageId: "answer-created", cardId: "card-created" }; },
      async streamCardContent() {}, finishStreamingCard, async updateCard() {},
      async shareThread() { return { messageId: "shared" }; }
    };
    const logger = pino({ enabled: false });
    const publisher = createTestPublisher(ringPublisherStore(stores), lark, logger);
    const stopPublisher = publisher.start();
    const bus = new BridgeEventBus();
    const projector = new ConversationViewProjector(
      bus, stores.driver, publisher, publisher, logger, primaryPresentation,
      undefined, undefined, { cardUpdateDebounceMs: 0, mainCardUpdateDebounceMs: 0 }
    );
    projector.start();
    const schedulerWake = vi.fn();
    const receipt = vi.fn();
    const observeRuntime = vi.fn();
    const workflow = new PromptRunWorkflow({
      stores: { dispatch: stores.promptDispatch, recovery: stores.promptRecovery, session: stores.promptSession },
      herdr: { observeRuntime } as never,
      bus,
      scheduler: { subscribe: () => () => {}, wake: schedulerWake },
      outboundWork: publisher,
      presentation: primaryPresentation,
      turnTimeoutMs: 1_000,
      transcriptReader: { getSubmissionReceipt: receipt } as never,
      bindingPrompts: { applyCoreObservation: vi.fn(async () => ({ outcome: "ignored" as const, owned: false as const, terminal: null, prompt: null })) },
      logger
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "prompt-1" });
    await vi.waitFor(() => expect(finishStreamingCard).toHaveBeenCalledOnce());
    expect(receipt).not.toHaveBeenCalled();
    expect(observeRuntime).not.toHaveBeenCalled();
    expect(stores.driver.getPrompt("prompt-1")).toMatchObject({ state: "delivered", observationState: "completed" });
    expect(stores.driver.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("following");
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "prompt-1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));
    expect(finishStreamingCard).toHaveBeenCalledOnce();
    await workflow.stop();
    await projector.stop();
    stopPublisher();
    stores.driver.close();
  });

  it("fails closed on stale fences and terminalizes ambiguous evidence without stealing a conflicting turn", () => {
    const stores = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(stores, "prompt-1");
    seedSettledCompletedTurn(stores, "prompt-1");
    const base = {
      promptId: "prompt-1", bindingId: "b1", expectedBindingGeneration: 1,
      expectedPaneId: "w1:p1", expectedNativeSessionId: "session-1", occurredAt: "2026-10-01T10:05:00.000Z"
    };

    expect(stores.promptRecovery.recoverProjectedBridgeTurn({ ...base, expectedPaneId: "w1:other" })).toEqual({ outcome: "stale" });
    expect(stores.promptRecovery.recoverProjectedBridgeTurn({ ...base, expectedNativeSessionId: "session-2" })).toEqual({ outcome: "stale" });
    const duplicateTerminal: CoreEventEnvelope = {
      schemaVersion: 1, eventId: "duplicate-terminal", cursor: "c5", sourceId: "source-1", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:57.000Z", payload: { type: "turn_completed" }
    };
    stores.coreEvents.ingestBatch({
      laneId: "lane-prompt-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "c4", nextCursor: "c5", latestCursor: "c5", events: [duplicateTerminal], ingestedAt: "2026-10-01T10:04:58.000Z"
    });
    stores.coreEvents.acknowledge("lane-prompt-1", [duplicateTerminal.eventId], "projected", "2026-10-01T10:04:58.100Z", undefined, { kind: "binding", id: "b1" });

    expect(stores.promptRecovery.recoverProjectedBridgeTurn({ ...base, renderRunCard: primaryPresentation.answerCard })).toMatchObject({
      outcome: "needs_human", outboxReserved: true
    });
    expect(stores.driver.getPrompt("prompt-1")).toMatchObject({ state: "uncertain", observationState: "completed", transcriptTurnId: null });
    expect(stores.driver.loadRunCard("prompt-1")).toMatchObject({ phase: "uncertain", answer: "" });
    expect(stores.driver.getRecoveryStageForBinding("b1")).toBe("needs_human");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='turn.recovery.ambiguous'").get()).toEqual({ count: 1 });
    stores.driver.close();

    const conflicted = createTestStoreBundle(":memory:");
    prepareDetachedPrompt(conflicted, "prompt-1");
    const ownerView = createQueuedRunCard({
      promptId: "other-owner", bindingId: "b1", title: "Other", workspaceId: "w1", paneId: "w1:p1",
      requestText: "other", queuePosition: 1, occurredAt: "2026-10-01T10:04:47.500Z"
    });
    conflicted.driver.acceptPrompt({
      prompt: { id: "other-owner", bindingId: "b1", larkMessageId: "message-other", actorOpenId: "user-1", body: "other" },
      view: ownerView, rootMessageId: "root", answerCard: {}
    });
    conflicted.driver.database.prepare("UPDATE prompt_jobs SET state='delivered', observation_state='completed', transcript_turn_id='turn-1', transcript_turn_started_at='2026-10-01T10:04:48.000Z' WHERE id='other-owner'").run();
    conflicted.driver.database.prepare("UPDATE run_cards SET phase='completed', answer='owner final answer' WHERE prompt_id='other-owner'").run();
    conflicted.driver.database.prepare(`INSERT INTO prompt_transcript_turns(
      prompt_id,binding_id,binding_generation,pane_id,native_session_id,turn_id,started_at,chain_id,parent_turn_id,origin,ordinal,created_at
    ) VALUES ('other-owner','b1',1,'w1:p1','session-1','turn-1','2026-10-01T10:04:48.000Z','turn-1',NULL,'prompt',0,'2026-10-01T10:04:48.000Z')`).run();
    seedSettledCompletedTurn(conflicted, "prompt-1");

    expect(conflicted.promptRecovery.recoverProjectedBridgeTurn(base)).toEqual({ outcome: "turn_owned_by_other_prompt" });
    expect(conflicted.driver.getPrompt("prompt-1")).toMatchObject({ state: "recovering", observationState: "detached", transcriptTurnId: null });
    expect(conflicted.driver.getPrompt("other-owner")).toMatchObject({ state: "delivered", observationState: "completed", transcriptTurnId: "turn-1" });
    expect(conflicted.driver.loadRunCard("other-owner")).toMatchObject({ phase: "completed", answer: "owner final answer" });
    conflicted.driver.close();
  });
});

function prepareDetachedPrompt(stores: ReturnType<typeof createTestStoreBundle>, promptId: string): void {
  stores.driver.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
  stores.driver.updateBinding("b1", {
    state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
    agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
  });
  const view = createQueuedRunCard({
    promptId, bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1",
    requestText: promptId, queuePosition: 1, occurredAt: "2026-10-01T10:04:47.000Z"
  });
  stores.driver.acceptPrompt({
    prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "user-1", body: promptId },
    view, rootMessageId: "root", answerCard: {}
  });
  stores.driver.claimNextDispatchablePrompt("b1");
  stores.driver.markPromptNativeQueued({ promptId, bindingId: "b1", submissionId: promptId, dispatchedAt: "2026-10-01T10:04:48.000Z" });
  stores.promptRecovery.recoverRunningPrompts();
  stores.driver.database.prepare("UPDATE run_cards SET phase='running' WHERE prompt_id=?").run(promptId);
}

function seedSettledCompletedTurn(stores: ReturnType<typeof createTestStoreBundle>, promptId: string, messageEvents?: readonly CoreEventEnvelope[]): void {
  const messages = messageEvents ?? [
    { schemaVersion: 1, eventId: `${promptId}-final`, cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:56.242Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "historical final answer", truncated: false } } satisfies CoreEventEnvelope
  ];
  const terminalCursor = `c${messages.length + 3}`;
  const events: CoreEventEnvelope[] = [
    { schemaVersion: 1, eventId: `${promptId}-start`, cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.568Z", payload: { type: "turn_started" } },
    { schemaVersion: 1, eventId: `${promptId}-human`, cursor: "c2", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.700Z", payload: { type: "human_message", message_id: "human-1", text: promptId, truncated: false, submission_id: promptId } },
    ...messages,
    { schemaVersion: 1, eventId: `${promptId}-completed`, cursor: terminalCursor, sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:56.392Z", payload: { type: "turn_completed" } }
  ];
  stores.coreEvents.ingestBatch({
    laneId: `lane-${promptId}`, sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
    afterCursor: "start", nextCursor: terminalCursor, latestCursor: terminalCursor, events, ingestedAt: "2026-10-01T10:04:57.000Z"
  });
  stores.coreEvents.acknowledge(`lane-${promptId}`, events.map(({ eventId }) => eventId), "projected", "2026-10-01T10:04:57.100Z", undefined, { kind: "binding", id: "b1" });
}

function v3ReviewFence(question = "Recovered review?", optionId = "continue"): string {
  return `\`\`\`herdr-choice-list\n{"version":3,"choice":{"question":"${question}","defaultOption":{"id":"${optionId}","label":"Continue","submitText":"Continue"},"alternatives":[]}}\n\`\`\``;
}

function v3NoneFence(): string {
  return "```herdr-choice-list\n{\"version\":3}\n```";
}

function completeOversizedV3ReviewFence(): string {
  const option = (id: string, label: string) => ({ id, label, submitText: `${id}:`.padEnd(2_000, id) });
  return `\`\`\`herdr-choice-list\n${JSON.stringify({
    version: 3,
    choice: {
      question: "Choose one oversized but otherwise valid option set?",
      defaultOption: option("a", "Option A"),
      alternatives: [option("b", "Option B"), option("c", "Option C"), option("d", "Option D")]
    }
  })}\n\`\`\``;
}

function recoveryInput() {
  return {
    promptId: "prompt-1", bindingId: "b1", expectedBindingGeneration: 1,
    expectedPaneId: "w1:p1", expectedNativeSessionId: "session-1", occurredAt: "2026-10-01T10:05:00.000Z"
  };
}

function seedMalformedNativeCompletedTurn(stores: ReturnType<typeof createTestStoreBundle>, malformedNative: unknown): void {
  const events: CoreEventEnvelope[] = [
    { schemaVersion: 1, eventId: "prompt-1-start", cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.568Z", payload: { type: "turn_started" } },
    { schemaVersion: 1, eventId: "prompt-1-human", cursor: "c2", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.700Z", payload: { type: "human_message", message_id: "human-1", text: "prompt-1", truncated: false, submission_id: "prompt-1" } },
    { schemaVersion: 1, eventId: "text-review", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:50.000Z", payload: { type: "message", message_id: "review-1", channel: "commentary", text: v3ReviewFence(), truncated: false } },
    { schemaVersion: 1, eventId: "malformed-native-final", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:51.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "fail closed answer", truncated: false, completion_choice: { version: 2, intent: "human_review", question: "Temporary native?", default: "temporary", options: [{ id: "temporary", label: "Temporary", message: "default" }] } } }
  ];
  stores.coreEvents.ingestBatch({
    laneId: "lane-prompt-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
    afterCursor: "start", nextCursor: "c4", latestCursor: "c4", events, ingestedAt: "2026-10-01T10:04:52.000Z"
  });
  stores.coreEvents.acknowledge("lane-prompt-1", events.map(({ eventId }) => eventId), "projected", "2026-10-01T10:04:52.100Z", undefined, { kind: "binding", id: "b1" });
  const persisted = stores.driver.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id='malformed-native-final'").get() as { event_json: string };
  const malformed = JSON.parse(persisted.event_json) as { payload: Record<string, unknown> };
  malformed.payload.completion_choice = malformedNative;
  stores.driver.database.prepare("UPDATE core_event_inbox SET event_json=? WHERE event_id='malformed-native-final'").run(JSON.stringify(malformed));

  const terminal: CoreEventEnvelope = { schemaVersion: 1, eventId: "prompt-1-completed", cursor: "c5", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:56.392Z", payload: { type: "turn_completed" } };
  stores.coreEvents.ingestBatch({
    laneId: "lane-prompt-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
    afterCursor: "c4", nextCursor: "c5", latestCursor: "c5", events: [terminal], ingestedAt: "2026-10-01T10:04:57.000Z"
  });
  stores.coreEvents.acknowledge("lane-prompt-1", [terminal.eventId], "projected", "2026-10-01T10:04:57.100Z", undefined, { kind: "binding", id: "b1" });
}

function seedSettledAbortedTurn(stores: ReturnType<typeof createTestStoreBundle>, promptId: string): void {
  const events: CoreEventEnvelope[] = [
    { schemaVersion: 1, eventId: `${promptId}-start`, cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.568Z", payload: { type: "turn_started" } },
    { schemaVersion: 1, eventId: `${promptId}-human`, cursor: "c2", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:48.700Z", payload: { type: "human_message", message_id: "human-1", text: promptId, truncated: false, submission_id: promptId } },
    { schemaVersion: 1, eventId: `${promptId}-aborted`, cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-01T10:04:56.392Z", payload: { type: "turn_aborted", reason: "cancelled" } }
  ];
  stores.coreEvents.ingestBatch({
    laneId: `lane-${promptId}`, sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
    afterCursor: "start", nextCursor: "c3", latestCursor: "c3", events, ingestedAt: "2026-10-01T10:04:57.000Z"
  });
  stores.coreEvents.acknowledge(`lane-${promptId}`, events.map(({ eventId }) => eventId), "projected", "2026-10-01T10:04:57.100Z", undefined, { kind: "binding", id: "b1" });
}

function ringPublisherStore(stores: ReturnType<typeof createTestStoreBundle>) {
  return Object.assign(stores.driver, {
    acquireInstanceLease: stores.lease.acquireInstanceLease.bind(stores.lease),
    activateWriteFence: stores.lifecycle.activateWriteFence.bind(stores.lifecycle)
  }) as never;
}
