import { describe, expect, it, vi } from "vitest";
import { HerdrEventsAdapter } from "../src/adapters/herdr-events-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import type { AgentTranscriptSource, HerdrPort } from "../src/domain/ports/external.js";
import type { CoreEventCapabilities, HerdrEventsPort } from "../src/domain/herdr-events.js";
import { renderAnswerTimeline } from "../src/cards/answer-timeline.js";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";
import { HerdrEventsReader } from "../src/runtime/herdr-events-reader.js";
import { HerdrEventSourceSession } from "../src/runtime/herdr-events/source-session.js";
import { agentEvent as event, attachedSource, coreEventResponse as response, MemoryCoreEventInbox } from "./helpers/herdr-events.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

const source: AgentTranscriptSource = { agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1", nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } };
const pane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: null, label: null, agentState: "idle" as const, foregroundExecutables: [], agentSession: source.nativeSession };
const eventsAdapter = (run: CommandRunner["run"]) => new HerdrEventsAdapter({ run }, "herdr");

function harness(batches: object[]) {
  const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
    if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 10, latest_cursor: "c0" }] });
    return response(batches.shift() ?? { type: "agent_events_batch", events: [], next_cursor: "c0", earliest_cursor: "c0", latest_cursor: "c0" });
  });
  const herdr = { async listAllPanes() { return [pane]; } } as Pick<HerdrPort, "listAllPanes">;
  return { reader: new HerdrEventsReader(eventsAdapter(run), herdr, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" })), run };
}

describe("HerdrEventsReader", () => {
  it("retries a transient general capability failure and caches only the recovered result", async () => {
    const supported: CoreEventCapabilities = {
      exactTurnRecovery: true,
      historicalTurnIndexRecovery: true,
      sessionTurnEnumeration: true,
      visibleReasoning: true,
      sessionEventRingV2: true
    };
    let release!: (value: CoreEventCapabilities) => void;
    const recovered = new Promise<CoreEventCapabilities>((resolve) => { release = resolve; });
    const capabilities = vi.fn<HerdrEventsPort["capabilities"]>()
      .mockRejectedValueOnce(new Error("Core socket unavailable"))
      .mockReturnValueOnce(recovered);
    const session = new HerdrEventSourceSession(
      { capabilities } as unknown as HerdrEventsPort,
      { async listAllPanes() { return []; } },
      async () => null
    );

    await expect(session.capabilities()).resolves.toEqual({
      exactTurnRecovery: false,
      historicalTurnIndexRecovery: false,
      sessionTurnEnumeration: false,
      visibleReasoning: false,
      sessionEventRingV2: false
    });
    const firstRecovered = session.capabilities();
    const concurrentRecovered = session.capabilities();
    expect(capabilities).toHaveBeenCalledTimes(2);
    release(supported);
    await expect(Promise.all([firstRecovered, concurrentRecovered])).resolves.toEqual([supported, supported]);
    await expect(session.capabilities()).resolves.toBe(supported);
    expect(capabilities).toHaveBeenCalledTimes(2);
  });

  it("retries transient session stream and ring support failures while caching successes", async () => {
    const supportsSessionEventStream = vi.fn<HerdrEventsPort["supportsSessionEventStream"]>()
      .mockRejectedValueOnce(new Error("stream probe unavailable"))
      .mockResolvedValue(true);
    const supportsSessionEventRingV2 = vi.fn<NonNullable<HerdrEventsPort["supportsSessionEventRingV2"]>>()
      .mockRejectedValueOnce(new Error("ring probe unavailable"))
      .mockResolvedValue(true);
    const session = new HerdrEventSourceSession(
      { supportsSessionEventStream, supportsSessionEventRingV2 } as unknown as HerdrEventsPort,
      { async listAllPanes() { return []; } },
      async () => null
    );

    await expect(session.supportsSessionStream()).rejects.toThrow("stream probe unavailable");
    await expect(session.supportsSessionStream()).resolves.toBe(true);
    await expect(session.supportsSessionStream()).resolves.toBe(true);
    expect(supportsSessionEventStream).toHaveBeenCalledTimes(2);

    await expect(session.supportsSessionRingV2()).rejects.toThrow("ring probe unavailable");
    await expect(session.supportsSessionRingV2()).resolves.toBe(true);
    await expect(session.supportsSessionRingV2()).resolves.toBe(true);
    expect(supportsSessionEventRingV2).toHaveBeenCalledTimes(2);
  });

  it("rebuilds only Task List and Goal state from exact already-projected Core evidence", async () => {
    const stores = createTestStoreBundle(":memory:");
    const events = [
      event("c1", "turn-1", "2026-09-30T16:16:14.000Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-30T16:16:20.000Z", { type: "tool_call", call_id: "plan-old", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Old plan", status: "in_progress" }] }), truncated: false }),
      event("source-1:3", "turn-1", "2026-09-30T16:16:20.500Z", { type: "goal_changed", goal_id: "goal-1", objective: "Ship safely", status: "active", source_updated_at: 1, truncated: false }),
      event("c3", "turn-1", "2026-09-30T16:16:21.000Z", { type: "message", message_id: "answer-before-owner", channel: "assistant", text: "must not be replayed", truncated: false }),
      event("c4", "turn-1", "2026-09-30T16:16:22.000Z", { type: "turn_completed" }),
      event("c5", "turn-1", "2026-09-30T16:16:23.000Z", { type: "tool_call", call_id: "plan-new", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Current plan", status: "completed" }] }), truncated: false })
    ].map((item) => ({
      schemaVersion: 1 as const, eventId: item.event_id, cursor: item.cursor, sourceId: item.source_id,
      agentKind: item.agent_kind, sessionId: item.session_id, turnId: item.turn_id, occurredAt: item.occurred_at, payload: item.payload
    }));
    stores.driver.database.prepare(`INSERT INTO conversation_turn_projections(
      agent_kind,session_id,turn_id,started_at,source_lane_id,projection_id,origin,binding_id,binding_generation,pane_id,
      state_json,answer_card_json,answer_message_id,answer_card_id,delivered_revision,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?)`).run(
      "traex", "session-1", "turn-1", "2026-09-30T16:16:14.000Z", "lane-1", "historical-turn", "herdr",
      null, null, null, "{}", "{}", "2026-09-30T16:16:24.000Z", "2026-09-30T16:16:24.000Z"
    );
    stores.coreEvents.ingestBatch({ laneId: "lane-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: "c5", latestCursor: "c5", events, ingestedAt: "2026-09-30T16:16:24.000Z" });
    stores.coreEvents.acknowledge("lane-1", events.map(({ eventId }) => eventId), "projected", "2026-09-30T16:16:25.000Z", undefined, { kind: "binding", id: "binding-1" });
    const reader = new HerdrEventsReader(eventsAdapter(vi.fn(async () => { throw new Error("must not read Core"); })), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), stores.coreEvents);

    await expect(reader.replayProjectedTurnState(source, "turn-1", "2026-09-30T16:16:14.000Z")).resolves.toEqual({
      planSteps: [{ key: "plan:0", label: "Current plan", state: "done" }],
      goalChanges: [expect.objectContaining({ goalId: "goal-1", objective: "Ship safely", status: "active", sourceSequence: 3 })]
    });
    await expect(reader.replayProjectedTurnState({ ...source, nativeSession: { ...source.nativeSession!, value: "wrong-session" } }, "turn-1", "2026-09-30T16:16:14.000Z")).resolves.toBeNull();
    await expect(reader.replayProjectedTurnState(source, "wrong-turn", "2026-09-30T16:16:14.000Z")).resolves.toBeNull();
    await expect(reader.replayProjectedTurnState(source, "turn-1", "2026-09-30T16:16:13.000Z")).resolves.toBeNull();
    await expect(reader.replayProjectedTurnState(source, "turn-1", "2026-09-30T16:16:24.000Z")).resolves.toBeNull();

    stores.lifecycle.close();
  });

  it("falls back to typed exact-turn recovery when retained live events no longer contain the turn", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("recover-turn")) return response({
        type: "agent_events_recovery_batch",
        outcome: "recovered",
        canonical_started_at: "2026-09-25T00:00:00.000Z",
        events: [
          event("recovery:t:1", "turn-old", "2026-09-25T00:00:00Z", { type: "turn_started" }),
          event("recovery:t:2", "turn-old", "2026-09-25T00:00:01Z", { type: "message", message_id: "old-answer", channel: "final", text: "recovered", truncated: false }),
          event("recovery:t:3", "turn-old", "2026-09-25T00:00:02Z", { type: "turn_completed" })
        ],
        next_cursor: "opaque-recovery-cursor",
        complete: true
      });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    const opened = await reader.openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z");
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    expect(opened.recoveredIdentity).toEqual({ turnId: "turn-old", canonicalStartedAt: "2026-09-25T00:00:00.000Z" });
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({
      turnId: "turn-old", answerDelta: "recovered",
      turnLifecycle: { turnId: "turn-old", state: "completed", startedAt: "2026-09-25T00:00:00.000Z", finalAnswer: "recovered" }
    });
    await expect(opened.cursor.readObservation()).resolves.toEqual({ answerDelta: "" });
    expect(run.mock.calls.filter((call) => call[1].includes("recover-turn"))).toHaveLength(1);
  });

  it.each([
    ["indexing", "recovery_indexing"],
    ["not_found", "recovery_not_found"],
    ["ambiguous", "recovery_ambiguous"]
  ] as const)("returns typed %s historical recovery outcome", async (outcome, reason) => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("recover-turn")) return response({ type: "agent_events_recovery_batch", outcome, events: [], next_cursor: "", complete: outcome !== "indexing" });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z")).resolves.toEqual({ mode: "unavailable", reason });
  });

  it("distinguishes unavailable historical recovery capability from a missing turn", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: false, session_turn_enumeration_v1: true });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z")).resolves.toEqual({ mode: "unavailable", reason: "recovery_capability_unavailable" });
  });

  it("returns a typed transient outcome when Core historical recovery fails", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("recover-turn")) throw new Error("Core recovery temporarily unavailable");
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z")).resolves.toEqual({ mode: "unavailable", reason: "recovery_transient_failure" });
  });

  it("fails closed when a recovered continuation changes its typed outcome", async () => {
    let recoveryRead = 0;
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("recover-turn") && recoveryRead++ === 0) return response({
        type: "agent_events_recovery_batch", outcome: "recovered", canonical_started_at: "2026-09-25T00:00:00.000Z",
        events: [event("recovery:t:1", "turn-old", "2026-09-25T00:00:00Z", { type: "turn_started" })],
        next_cursor: "opaque-recovery-cursor", complete: false
      });
      if (args.includes("recover-turn")) return response({
        type: "agent_events_recovery_batch", outcome: "not_found", events: [], next_cursor: "", complete: true
      });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    const opened = await reader.openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z");
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ turnId: "turn-old", freshTurnStart: true });
    await expect(opened.cursor.readObservation()).rejects.toThrow("Core exact-turn recovery changed outcome to not_found");
  });

  it("stages exact recovery pages until a complete validated snapshot without formal projection", async () => {
    const stores = createTestStoreBundle(":memory:");
    let recoveryRead = 0;
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("recover-turn") && recoveryRead++ === 0) return response({
        type: "agent_events_recovery_batch", outcome: "recovered", canonical_started_at: "2026-09-25T00:00:00.000Z",
        events: [
          event("recovery:1", "turn-old", "2026-09-25T00:00:00.000Z", { type: "turn_started" }),
          event("recovery:2", "turn-old", "2026-09-25T00:00:01.000Z", { type: "human_message", message_id: "human-1", text: "recover", truncated: false })
        ],
        next_cursor: "recovery:2", complete: false
      });
      if (args.includes("recover-turn")) {
        expect(args).toEqual(expect.arrayContaining(["--after", "recovery:2"]));
        return response({
          type: "agent_events_recovery_batch", outcome: "recovered", canonical_started_at: "2026-09-25T00:00:00.000Z",
          events: [
            event("recovery:3", "turn-old", "2026-09-25T00:00:02.000Z", { type: "turn_completed" })
          ],
          next_cursor: "recovery:3", complete: true
        });
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const createReader = () => new HerdrEventsReader(
      eventsAdapter(run),
      { async listAllPanes() { return [pane]; } },
      async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }),
      stores.coreEvents,
      {},
      stores.turnSnapshots
    );

    await expect(createReader().openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z")).resolves.toEqual({ mode: "unavailable", reason: "recovery_indexing" });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot({
      agentKind: "traex", sessionId: "session-1", turnId: "turn-old", requestedStartedAt: "2026-09-25T00:00:00Z"
    })).toMatchObject({ state: "staging", nextCursor: "recovery:2", complete: false });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });

    const opened = await createReader().openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z");
    expect(opened).toMatchObject({
      mode: "typed",
      recoveredIdentity: { turnId: "turn-old", canonicalStartedAt: "2026-09-25T00:00:00.000Z" }
    });
    if (opened.mode !== "typed") throw new Error("expected ready authoritative snapshot cursor");
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({
      turnId: "turn-old",
      freshTurnStart: true,
      requestText: "recover",
      turnLifecycle: { turnId: "turn-old", state: "completed", startedAt: "2026-09-25T00:00:00.000Z" },
      authoritativeSnapshot: {
        agentKind: "traex",
        sessionId: "session-1",
        turnId: "turn-old",
        requestedStartedAt: "2026-09-25T00:00:00Z",
        canonicalStartedAt: "2026-09-25T00:00:00.000Z"
      }
    });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot({
      agentKind: "traex", sessionId: "session-1", turnId: "turn-old", requestedStartedAt: "2026-09-25T00:00:00Z"
    })).toMatchObject({
      state: "ready",
      nextCursor: "recovery:3",
      complete: true,
      events: [expect.objectContaining({ eventId: "recovery:1" }), expect.objectContaining({ eventId: "recovery:2" }), expect.objectContaining({ eventId: "recovery:3" })]
    });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it.each([
    ["cross-session event", { ...event("recovery:t:1", "turn-old", "2026-09-25T00:00:00Z", { type: "turn_started" }), session_id: "session-other" }],
    ["unsupported event schema", { ...event("recovery:t:1", "turn-old", "2026-09-25T00:00:00Z", { type: "turn_started" }), schema_version: 2 }]
  ] as const)("fails closed with a transient outcome for a recovered %s", async (_case, recoveredEvent) => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9" });
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("recover-turn")) return response({
        type: "agent_events_recovery_batch", outcome: "recovered", canonical_started_at: "2026-09-25T00:00:00.000Z",
        events: [recoveredEvent], next_cursor: "opaque-recovery-cursor", complete: true
      });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.openAtTurn(source, "turn-old", "2026-09-25T00:00:00Z")).resolves.toEqual({ mode: "unavailable", reason: "recovery_transient_failure" });
  });

  it("returns only submission receipts fenced to the requested native session", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("submission")) return response({
        type: "agent_events_submission_receipt", submission_id: "prompt-1", state: "terminal", agent_kind: "traex",
        session_id: "session-1", turn_id: "turn-1", started_at: "2026-09-25T00:00:00Z", terminal_state: "completed"
      });
      throw new Error("unexpected command");
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.getSubmissionReceipt(source, "prompt-1")).resolves.toEqual({
      submissionId: "prompt-1", state: "terminal", agentKind: "traex", sessionId: "session-1",
      turnId: "turn-1", startedAt: "2026-09-25T00:00:00Z", terminalState: "completed"
    });
  });

  it("enumerates bounded Core turn identities without transcript bodies", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("capabilities")) return response({ type: "agent_events_capabilities", exact_turn_recovery_v1: true, session_turn_enumeration_v1: true });
      if (args.includes("turns")) return response({
        type: "agent_events_turn_list", turns: [{ turn_id: "turn-1", started_at: "2026-09-25T00:00:00Z", terminal_state: "completed", has_human_message: true }],
        next_cursor: "opaque-turn-cursor", complete: true
      });
      throw new Error("unexpected command");
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.listSessionTurns(source)).resolves.toEqual({
      turns: [{ turnId: "turn-1", startedAt: "2026-09-25T00:00:00Z", terminalState: "completed", hasHumanMessage: true }],
      nextCursor: "opaque-turn-cursor", complete: true
    });
  });

  it("projects a Core human message as request ownership and an Answer timeline item", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:00.100Z", { type: "human_message", message_id: "user-1", text: "continue", truncated: false })
    ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c2" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    const observed = await opened.cursor.readObservation();
    expect(observed).toMatchObject({
      turnId: "turn-1",
      freshTurnStart: true,
      requestText: "continue",
      requestMessageId: "user-1",
      answerDelta: ""
    });
    expect(observed.timelineDeltas).toEqual([
      { kind: "human_message", id: "human:user-1", sequence: 1, markdown: "continue" }
    ]);
  });

  it("projects a native Goal lifecycle event without inventing answer or tool activity", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("source-1:12", "turn-1", "2026-09-30T00:00:01Z", {
        type: "goal_changed", goal_id: "goal-1", objective: "Ship native Goal support", status: "active", source_updated_at: 42, truncated: false
      })
    ], next_cursor: "source-1:12", earliest_cursor: "c0", latest_cursor: "source-1:12" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    expect(await opened.cursor.readObservation()).toMatchObject({
      turnId: "turn-1",
      answerDelta: "",
      goalChanges: [{
        goalId: "goal-1", objective: "Ship native Goal support", status: "active", sourceUpdatedAt: 42,
        sourceId: "source-1", sourceSequence: 12, sourceEventId: "source-1:12", nativeSessionId: "session-1"
      }]
    });
  });

  it("exposes the validated transcript descriptor for metadata-only lineage inspection", async () => {
    const descriptor = { sessionId: "session-1", path: "/tmp/session.jsonl" };
    const reader = new HerdrEventsReader(eventsAdapter(vi.fn()), { async listAllPanes() { return [pane]; } }, async () => descriptor);

    await expect(reader.resolveTranscriptDescriptor(source)).resolves.toEqual(descriptor);
  });

  it("classifies native commentary and analysis messages without exposing reasoning bodies", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "thinking-1", channel: "analysis", text: "**Inspecting native events**\n\nPrivate chain of thought", truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "commentary-1", channel: "commentary", text: "Public progress", truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();

    expect(observed.answerDelta).toBe("Public progress");
    expect(observed.timelineDeltas).toEqual([
      { kind: "agent_message", id: "message:commentary-1", sequence: 1, markdown: "Public progress" }
    ]);
    expect(JSON.stringify(observed)).not.toContain("Private chain of thought");
  });

  it("uses the attach high-water cursor for a new turn and projects lifecycle, tools, and final answer", async () => {
    const { reader, run } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"npm test"}', truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: '{"exit_code":0}', is_error: false, truncated: false }),
      event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "message", message_id: "m1", channel: "final", text: "done", truncated: false }),
      event("c5", "turn-1", "2026-09-26T00:00:04Z", { type: "turn_completed" })
    ], next_cursor: "c5", earliest_cursor: "c0", latest_cursor: "c5" }]);
    const opened = await reader.open(source);
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();
    expect(observed).toMatchObject({ turnId: "turn-1", freshTurnStart: true, answerDelta: "done", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-26T00:00:00.000Z", finalAnswer: "done" } });
    expect(observed.toolActivities).toEqual([expect.objectContaining({ key: "tool:call-1", state: "active" }), expect.objectContaining({ key: "tool:call-1", state: "done" })]);
    expect(observed.timelineDeltas).toContainEqual(expect.objectContaining({ id: "tool:call-1", result: '{"exit_code":0}', state: "succeeded" }));
    expect(run.mock.calls.at(-1)?.[1]).toContain("c0");
    expect(run.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--from", "end"]));
  });

  it("marks Core-truncated safe tool output instead of presenting it as complete", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"npm test"}', truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: "partial output", is_error: false, truncated: true })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();
    expect(observed.timelineDeltas).toContainEqual(expect.objectContaining({
      id: "tool:call-1", result: "partial output\n\n… source event truncated"
    }));
  });

  it("unwraps nested native Tool result output before timeline rendering", async () => {
    const wrapped = JSON.stringify({ test: { exit_code: 0, output: "actual output", wall_time_seconds: 0.4 } });
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec", arguments: JSON.stringify({ input: "const r = await tools.exec_command({cmd: 'npm test'}); text(r);" }), truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: wrapped, is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    expect((await opened.cursor.readObservation()).timelineDeltas?.at(-1)).toMatchObject({ result: "actual output" });
  });

  it("projects raw Code Mode arguments from native Core events as a visible command", async () => {
    const input = "const r = await tools.exec_command({cmd: 'git status --short'}); text(r.output);";
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec", arguments: input, truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: "Script completed\nWall time 0.1 seconds\nOutput:\n M src/main.ts", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();

    expect(observed.timelineDeltas).toContainEqual(expect.objectContaining({
      id: "tool:call-1",
      category: "step",
      command: "git status --short",
      state: "succeeded"
    }));
  });

  it("renders raw Core Step activity as compact semantic rows", async () => {
    const input = "const r = await tools.exec_command({cmd: 'git status --short'}); text(r.output);";
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec", arguments: input, truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: "Script completed\nWall time 0.1 seconds\nOutput:\n M src/main.ts", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const items = (await opened.cursor.readObservation()).timelineDeltas ?? [];

    const cardkit = JSON.stringify(renderAnswerTimeline(items));
    expect(cardkit).toContain("🛠️ Run · git status --short · … 运行中");
    expect(cardkit).toContain("🛠️ Run · git status --short · ✓ 完成");
    expect(cardkit).toContain("```bash\\ngit status --short\\n```");
  });

  it("projects every nested Tool in one raw Code Mode exec as a stable grouped timeline item", async () => {
    const input = [
      "const patch = \"*** Begin Patch\\n*** Update File: /repo/src/main.ts\\n@@\\n-old\\n+new\\n*** End Patch\";",
      "const results = await Promise.all([",
      "  tools.view_image({path: '/tmp/screen.png'}),",
      "  tools.web_search({query: 'CardKit'}),",
      "  tools.apply_patch(patch),",
      "  tools.exec_command({cmd: 'npm test'}),",
      "  tools.custom_widget({target: 'dashboard'})",
      "]);",
      "text(results);"
    ].join("\n");
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "batch-1", name: "exec", arguments: input, truncated: false })
    ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c2" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const items = (await opened.cursor.readObservation()).timelineDeltas ?? [];

    expect(items).toEqual([
      expect.objectContaining({ id: "tool:batch-1", category: "tool", label: "exec", state: "running" }),
      expect.objectContaining({ id: "tool:batch-1:nested:0", parentToolId: "tool:batch-1", category: "read", label: "/tmp/screen.png", state: "running" }),
      expect.objectContaining({ id: "tool:batch-1:nested:1", parentToolId: "tool:batch-1", category: "search", label: "CardKit", state: "running" }),
      expect.objectContaining({ id: "tool:batch-1:nested:2", parentToolId: "tool:batch-1", category: "edit", label: "main.ts (+1 -1)", state: "running" }),
      expect.objectContaining({ id: "tool:batch-1:nested:3", parentToolId: "tool:batch-1", category: "test", label: "Test · project", command: "npm test", state: "running" }),
      expect.objectContaining({ id: "tool:batch-1:nested:4", parentToolId: "tool:batch-1", category: "tool", label: "custom_widget", state: "running" })
    ]);
    const cardkit = JSON.stringify(renderAnswerTimeline(items));
    expect(cardkit).toContain("🔧 Tool · exec · … 运行中");
    expect(cardkit).toContain("📖 Read · /tmp/screen.png · … 运行中");
    expect(cardkit).toContain("🔍 Search · CardKit · … 运行中");
    expect(cardkit).toContain("✏️ Edit · main.ts (+1 -1) · … 运行中");
    expect(cardkit).toContain("🧪 Test · npm test · … 运行中");
    expect(cardkit).toContain("🔧 Tool · custom_widget · … 运行中");
  });

  it("renders raw Core Search and Read calls as one Herdr-style compact group", async () => {
    const input = [
      "const results = await Promise.all([",
      "  tools.web_search({query: '\"scanDurablePromptWork\" in sqlite'}),",
      "  tools.view_image({path: 'src/store/sqlite/prompt-recovery-store.ts (1-240)'}),",
      "  tools.view_image({path: 'src/coordinator/prompt-turn-executor.ts (1-220)'})",
      "]);",
      "text(results);"
    ].join("\n");
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "explore-1", name: "exec", arguments: input, truncated: false })
    ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c2" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const items = (await opened.cursor.readObservation()).timelineDeltas ?? [];

    const cardkit = renderAnswerTimeline(items);
    expect(cardkit[0]).toMatchObject({
      header: { title: { content: '🔍 Searching for "scanDurablePromptWork" in sqlite, reading 2 files…' } },
      elements: [{ content: expect.stringContaining('Search "scanDurablePromptWork" in sqlite') }]
    });
    const payload = JSON.stringify(cardkit);
    expect(payload).toContain("Read src/store/sqlite/prompt-recovery-store.ts (1-240)");
    expect(payload).toContain("Read src/coordinator/prompt-turn-executor.ts (1-220)");
    expect(payload).not.toContain("🔧 Tool · exec");
  });

  it("renders a raw Code Mode apply_patch call as an Edit in final payloads", async () => {
    const input = [
      "const patch = \"*** Begin Patch\\n*** Update File: /workspace/project/src/runtime/herdr-events-reader.ts\\n@@\\n-old\\n+new\\n*** End Patch\";",
      "text(await tools.apply_patch(patch));"
    ].join("\n");
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "edit-1", name: "exec", arguments: input, truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "edit-1", text: "{}", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const items = (await opened.cursor.readObservation()).timelineDeltas ?? [];

    expect(items).toContainEqual(expect.objectContaining({ category: "edit", label: "herdr-events-reader.ts (+1 -1)", state: "succeeded" }));
    const payload = JSON.stringify(renderAnswerTimeline(items));
    expect(payload).toContain("✏️ Edit · herdr-events-reader.ts (+1 -1) · ✓ 完成");
    expect(payload).toContain("**Diff**");
    expect(payload).toContain("*** Update File: /workspace/project/src/runtime/herdr-events-reader.ts");
    expect(payload).not.toContain("Result");
  });

  it("projects a raw Code Mode plan update into the Main Card task list", async () => {
    const input = `const p = await tools.update_plan({explanation:"live",plan:[{step:"Inspect Core events",status:"completed"},{step:"Fix Main Card tasks",status:"in_progress"},{step:"Verify deployment",status:"pending"}]}); text(p);`;
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "plan-call", name: "exec", arguments: input, truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "plan-call", text: "{}", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();

    expect(observed.mainStatus?.planSteps).toEqual([
      { key: "plan:0", label: "Inspect Core events", state: "done" },
      { key: "plan:1", label: "Fix Main Card tasks", state: "active" },
      { key: "plan:2", label: "Verify deployment", state: "pending" }
    ]);
    expect(observed.timelineDeltas).toBeUndefined();
    expect(observed.toolActivities).toBeUndefined();
  });

  it("keeps native Wait calls in both status and the Answer timeline", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "wait-1", name: "write_stdin", arguments: '{"session_id":42}', truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "wait-1", text: '{"session_id":42,"output":"still running"}', is_error: false, truncated: false }),
      event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "tool_call", call_id: "wait-2", name: "write_stdin", arguments: '{"session_id":42}', truncated: false }),
      event("c5", "turn-1", "2026-09-26T00:00:04Z", { type: "tool_result", call_id: "wait-2", text: '{"exit_code":0,"output":"complete"}', is_error: false, truncated: false })
    ], next_cursor: "c5", earliest_cursor: "c0", latest_cursor: "c5" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();
    expect(observed.toolActivities).toEqual([
      { key: "wait:session 42", kind: "step", label: "Wait · session 42", state: "active" },
      { key: "wait:session 42", kind: "step", label: "Wait · session 42", state: "active" },
      { key: "wait:session 42", kind: "step", label: "Wait · session 42", state: "active" },
      { key: "wait:session 42", kind: "step", label: "Wait · session 42", state: "done" }
    ]);
    expect(observed.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", sequence: 1, state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", sequence: 2, result: "still running", state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:wait-2", category: "step", label: "Wait · session 42", sequence: 3, state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:wait-2", category: "step", label: "Wait · session 42", sequence: 4, result: "complete", state: "succeeded" })
    ]);
  });

  it("preserves structurally recognized Skill identity from native events", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "skill-1", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n 1,200p /tmp/data00/" + "home/alice/.trae/skills/herdr/SKILL.md" }), truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "skill-1", text: "large skill instructions", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const observed = await opened.cursor.readObservation();
    expect(observed.timelineDeltas).toContainEqual(expect.objectContaining({ id: "tool:skill-1", category: "skill", label: "herdr", state: "succeeded" }));
    expect(JSON.stringify(observed.timelineDeltas)).not.toContain("large skill instructions");
  });

  it("keeps Skill results out of final payloads projected from raw Core events", async () => {
    const input = "const skill = await tools.exec_command({cmd: 'sed -n 1,200p /tmp/data00/" + "home/alice/.trae/skills/herdr/SKILL.md'}); text(skill.output);";
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "skill-1", name: "exec", arguments: input, truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "skill-1", text: "private skill instructions", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const items = (await opened.cursor.readObservation()).timelineDeltas ?? [];

    const cardkit = JSON.stringify(renderAnswerTimeline(items));
    expect(cardkit).toContain("🧩 Skill · herdr · ✓ 完成");
    expect(cardkit).not.toContain("private skill instructions");
    expect(cardkit).not.toContain("Result");
  });

  it("preserves a native safe Tool result beyond the prose rendering bound", async () => {
    const output = "safe-native-output-".repeat(5_000);
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"build"}', truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: output, is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    expect((await opened.cursor.readObservation()).timelineDeltas?.at(-1)).toMatchObject({ result: output });
  });

  it("marks native Tool result truncation at the durable safety bound", async () => {
    const output = "x".repeat(MAX_TURN_OUTPUT_CHARS + 100);
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"build"}', truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: output, is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    const projected = (await opened.cursor.readObservation()).timelineDeltas?.at(-1);
    expect(projected).toMatchObject({ kind: "tool" });
    if (!projected || projected.kind !== "tool") return;
    expect(projected.result).toHaveLength(MAX_TURN_OUTPUT_CHARS);
    expect(projected.result?.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });

  it("replays exactly one retained turn for detached recovery", async () => {
    const history = { type: "agent_events_batch", events: [
      event("c3", "wanted", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c4", "wanted", "2026-09-26T00:00:01Z", { type: "message", message_id: "m2", channel: "final", text: "replayed", truncated: false }),
      event("c5", "wanted", "2026-09-26T00:00:02Z", { type: "turn_completed" })
    ], next_cursor: "c5", earliest_cursor: "c0", latest_cursor: "c5" };
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c5")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: true, after_cursor: "c2" });
      return response(history);
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));
    const opened = await reader.openAtTurn(source, "wanted", "2026-09-26T00:00:00Z");
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    expect(await opened.cursor.readObservation()).toMatchObject({ turnId: "wanted", answerDelta: "replayed", turnLifecycle: { state: "completed" } });
    expect(run.mock.calls.find(([, args]) => args.includes("locate"))?.[1]).toEqual([
      "agent", "events", "locate", "--source", "source-1", "--boundary", "at", "--turn-id", "wanted", "--started-at", "2026-09-26T00:00:00Z"
    ]);
  });

  it("keeps projection state across batches and does not repeat a promoted final message", async () => {
    const { reader } = harness([
      { type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00.456Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "m1", channel: "commentary", text: "same answer", truncated: false })
      ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c2" },
      { type: "agent_events_batch", events: [
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "m1", channel: "final", text: "same answer", truncated: false }),
        event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "turn_completed" })
      ], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" }
    ]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    expect(await opened.cursor.readObservation()).toMatchObject({ answerDelta: "same answer", turnLifecycle: { state: "active", startedAt: "2026-09-26T00:00:00.000Z" } });
    expect(await opened.cursor.readObservation()).toMatchObject({ answerDelta: "", turnLifecycle: { state: "completed", finalAnswer: "same answer" } });
  });

  it("delivers multiple turns from one Core batch as separate observations", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "turn_completed" }),
      event("c3", "turn-2", "2026-09-26T00:01:00Z", { type: "turn_started" }),
      event("c4", "turn-2", "2026-09-26T00:01:01Z", { type: "message", message_id: "m2", channel: "final", text: "second", truncated: false })
    ], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    expect(await opened.cursor.readObservation()).toMatchObject({ turnId: "turn-1", turnLifecycle: { state: "completed" } });
    expect(await opened.cursor.readObservation()).toMatchObject({ turnId: "turn-2", freshTurnStart: true, answerDelta: "second" });
  });

  it("durably ingests a Core batch before projection and settles one event at a time", async () => {
    const inbox = new MemoryCoreEventInbox();
    let readCalls = 0;
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c0")] });
      readCalls += 1;
      return response({ type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "turn_completed" }),
        event("c3", "turn-2", "2026-09-26T00:01:00Z", { type: "turn_started" }),
        event("c4", "turn-2", "2026-09-26T00:01:01Z", { type: "message", message_id: "m2", channel: "final", text: "second", truncated: false })
      ], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), inbox);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ turnId: "turn-1", freshTurnStart: true, turnLifecycle: { state: "active" } });
    expect([...inbox.pending.values()][0]?.map((item) => item.eventId)).toEqual(["c1", "c2", "c3", "c4"]);
    await opened.cursor.acknowledge?.("projected");
    expect([...inbox.pending.values()][0]?.map((item) => item.eventId)).toEqual(["c2", "c3", "c4"]);

    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ turnId: "turn-1", turnLifecycle: { state: "completed" } });
    expect(readCalls).toBe(1);
  });

  it("carries an explicit Worker Turn owner into durable Core settlement", async () => {
    const inbox = new MemoryCoreEventInbox();
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c0")] });
      return response({ type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" })
      ], next_cursor: "c1", earliest_cursor: "c0", latest_cursor: "c1" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), inbox);
    const opened = await reader.open({ ...source, coreEventOwner: { kind: "worker_turn", id: "worker-turn-1" } });
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    await expect(opened.cursor.readObservation()).resolves.toMatchObject({
      coreEventSettlement: { owner: { kind: "worker_turn", id: "worker-turn-1" } }
    });
  });

  it("rolls back cursor projection state while retrying one poison event and then projects its healthy neighbour", async () => {
    const inbox = new MemoryCoreEventInbox();
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c0")] });
      return response({ type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "poison", channel: "final", text: "retry me", truncated: false }),
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "healthy", channel: "final", text: "later answer", truncated: false })
      ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), inbox);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ freshTurnStart: true });
    await opened.cursor.acknowledge?.("projected");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(opened.cursor.readObservation()).resolves.toMatchObject({
        answerDelta: "retry me",
        timelineDeltas: [expect.objectContaining({ id: "message:poison", sequence: 1 })]
      });
      await opened.cursor.acknowledge?.("quarantined", "projection failed");
    }
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({
      answerDelta: "later answer",
      timelineDeltas: [expect.objectContaining({ id: "message:healthy", sequence: 1 })]
    });
  });

  it("quarantines a reducer poison event without blocking the next Core event", async () => {
    const inbox = new MemoryCoreEventInbox();
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c0")] });
      return response({ type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "source_error", code: "malformed_record" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "healthy", channel: "final", text: "still projected", truncated: false })
      ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c2" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), inbox);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(opened.cursor.readObservation()).resolves.toEqual({ answerDelta: "" });
    }
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "still projected" });
    expect(inbox.projectionAttempts.get("c1")).toBe(3);
  });

  it("preserves normalized Core event order across independent settlements", async () => {
    const inbox = new MemoryCoreEventInbox();
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c0")] });
      return response({ type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "human_message", message_id: "human-1", text: "request", truncated: false }),
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "agent-1", channel: "assistant", text: "working", truncated: false }),
        event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "tool_call", call_id: "tool-1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }), truncated: false }),
        event("c5", "turn-1", "2026-09-26T00:00:04Z", { type: "tool_result", call_id: "tool-1", text: "passed", is_error: false, truncated: false }),
        event("source-1:6", "turn-1", "2026-09-26T00:00:05Z", { type: "goal_changed", goal_id: "goal-1", objective: "Ship safely", status: "active", source_updated_at: 1, truncated: false }),
        event("c7", "turn-1", "2026-09-26T00:00:06Z", { type: "tool_call", call_id: "plan-1", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Verify", status: "in_progress" }] }), truncated: false }),
        event("c8", "turn-1", "2026-09-26T00:00:07Z", { type: "record_skipped", code: "record_too_large" }),
        event("c9", "turn-1", "2026-09-26T00:00:08Z", { type: "turn_completed" })
      ], next_cursor: "c9", earliest_cursor: "c0", latest_cursor: "c9" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), inbox);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    const observations = [];
    for (let index = 0; index < 9; index += 1) {
      observations.push(await opened.cursor.readObservation());
      await opened.cursor.acknowledge?.("projected");
    }
    expect(observations).toEqual([
      expect.objectContaining({ freshTurnStart: true }),
      expect.objectContaining({ requestText: "request", timelineDeltas: [expect.objectContaining({ kind: "human_message", sequence: 1 })] }),
      expect.objectContaining({ answerDelta: "working", timelineDeltas: [expect.objectContaining({ kind: "agent_message", sequence: 2 })] }),
      expect.objectContaining({ timelineDeltas: [expect.objectContaining({ kind: "tool", action: "Test", target: "npm test", state: "running", sequence: 3 })] }),
      expect.objectContaining({ timelineDeltas: [expect.objectContaining({ kind: "tool", action: "Test", target: "npm test", resultSummary: { outcome: "success", text: "passed" }, state: "succeeded", sequence: 4 })] }),
      expect.objectContaining({ goalChanges: [expect.objectContaining({ goalId: "goal-1", status: "active" })] }),
      expect.objectContaining({ mainStatus: { planSteps: [expect.objectContaining({ label: "Verify", state: "active" })] } }),
      expect.objectContaining({ answerDelta: "" }),
      expect.objectContaining({ turnLifecycle: expect.objectContaining({ state: "completed" }) })
    ]);
  });

  it("replays unacknowledged inbox events after reopening without rereading Core", async () => {
    const inbox = new MemoryCoreEventInbox();
    let readCalls = 0;
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c1")] });
      readCalls += 1;
      return response({ type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "message", message_id: "m1", channel: "final", text: "durable", truncated: false })
      ], next_cursor: "c1", earliest_cursor: "c0", latest_cursor: "c1" });
    });
    const createReader = () => new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }), inbox);
    const first = await createReader().open(source);
    if (first.mode !== "typed" || !first.cursor.readObservation) return;
    await expect(first.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "durable" });

    const reopened = await createReader().open(source);
    if (reopened.mode !== "typed" || !reopened.cursor.readObservation) return;
    await expect(reopened.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "durable" });
    expect(readCalls).toBe(1);
  });

  it("continues projecting after Core skips an oversized record", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "record_skipped", code: "record_too_large" }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "m1", channel: "final", text: "after skip", truncated: false }),
      event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "turn_completed" })
    ], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    const observed = await opened.cursor.readObservation();
    expect(observed).toMatchObject({
      answerDelta: "after skip",
      timelineDeltas: [
        expect.objectContaining({ kind: "final_answer", id: "message:m1" })
      ],
      turnLifecycle: { state: "completed", finalAnswer: "after skip" }
    });
    expect(JSON.stringify(observed)).not.toContain("record_too_large");
    expect(JSON.stringify(observed)).not.toContain("Some Core records could not be displayed");
  });

  it("retains Core command text while preserving the original Step category", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }), truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "call-1", text: "clean", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;

    expect((await opened.cursor.readObservation()).timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", category: "step", command: "git status --short", state: "running" }),
      expect.objectContaining({ kind: "tool", category: "step", command: "git status --short", result: "clean", state: "succeeded" })
    ]);
  });

  it("requests history from start for recovery boundaries", async () => {
    const { reader, run } = harness([{ type: "agent_events_batch", events: [], next_cursor: "c0", earliest_cursor: "c0", latest_cursor: "c0" }]);
    await reader.openActiveTurn(source);
    expect(run.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--from", "start"]));
  });

  it("uses Core locate without scanning retained history for the active turn", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c9")] });
      if (args.includes("locate")) return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: true, after_cursor: "c5" });
      return response({ type: "agent_events_batch", events: [], next_cursor: "c9", earliest_cursor: "c0", latest_cursor: "c9" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await expect(reader.openActiveTurn(source)).resolves.toMatchObject({ mode: "typed" });
    expect(run.mock.calls.find(([, args]) => args.includes("locate"))?.[1]).toEqual([
      "agent", "events", "locate", "--source", "source-1", "--boundary", "active"
    ]);
    expect(run.mock.calls.some(([, args]) => args.includes("read"))).toBe(false);
  });

  it("uses the bounded Core locator independently for each exact-turn recovery", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => args.includes("attach")
      ? response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [attachedSource("source-1", "active", "c2")] })
      : response({ type: "agent_events_turn_cursor", source_id: "source-1", found: true, after_cursor: "c0" }));
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    const [first, second] = await Promise.all([
      reader.openAtTurn(source, "wanted", "2026-09-26T00:00:00Z"),
      reader.openAtTurn(source, "wanted", "2026-09-26T00:00:00Z")
    ]);
    const third = await reader.openAtTurn(source, "wanted", "2026-09-26T00:00:00Z");

    expect([first.mode, second.mode, third.mode]).toEqual(["typed", "typed", "typed"]);
    expect(run.mock.calls.filter(([, args]) => args.includes("locate"))).toHaveLength(3);
    expect(run.mock.calls.filter(([, args]) => args.includes("read"))).toHaveLength(0);
  });

  it("does not scan historical sources that Core has already fenced as failed", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [
        attachedSource("failed-source", "error", "failed-cursor"),
        attachedSource("source-1", "active", "c0")
      ] });
      return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c0" });
    });
    const reader = new HerdrEventsReader(eventsAdapter(run), { async listAllPanes() { return [pane]; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    await reader.openAtTurn(source, "missing", "2026-09-26T00:00:00Z");

    expect(run.mock.calls.some(([, args]) => args.includes("failed-source"))).toBe(false);
  });

  it("fails closed when pane runtime identity is unavailable", async () => {
    const reader = new HerdrEventsReader(eventsAdapter(vi.fn()), { async listAllPanes() { return []; } }, async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));
    await expect(reader.open(source)).resolves.toEqual({ mode: "unavailable", reason: "transcript_validation_failed" });
  });
});
