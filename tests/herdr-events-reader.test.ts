import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/infra/command-runner.js";
import type { AgentTranscriptSource, HerdrPort } from "../src/domain/ports/external.js";
import { HerdrEventsReader } from "../src/runtime/herdr-events-reader.js";

const source: AgentTranscriptSource = {
  agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1",
  nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
};
const pane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: null, label: null, agentState: "idle" as const, foregroundExecutables: [], agentSession: source.nativeSession };
const response = (result: object) => ({ stdout: JSON.stringify({ id: "test", result }), stderr: "" });
const event = (cursor: string, turnId: string, occurredAt: string, payload: object) => ({ schema_version: 1, event_id: cursor, cursor, source_id: "source-1", agent_kind: "traex", session_id: "session-1", turn_id: turnId, occurred_at: occurredAt, payload });

function harness(batches: object[]) {
  const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
    if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 10, earliest_cursor: "c0", latest_cursor: "c0" }] });
    return response(batches.shift() ?? { type: "agent_events_batch", events: [], next_cursor: "c0", earliest_cursor: "c0", latest_cursor: "c0" });
  });
  const herdr = { async listAllPanes() { return [pane]; } } as Pick<HerdrPort, "listAllPanes">;
  return { reader: new HerdrEventsReader({ run }, herdr, "herdr", async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" })), run };
}

describe("HerdrEventsReader", () => {
  it("projects lifecycle, messages, Markdown command tools, and final promotion", async () => {
    const { reader } = harness([
      { type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "m1", channel: "commentary", text: "**Checking**\n\n`code`", truncated: false }),
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_call", call_id: "call-1", name: "exec", arguments: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);', truncated: false }),
        event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "tool_result", call_id: "call-1", text: "2 passed", is_error: false, truncated: false })
      ], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" },
      { type: "agent_events_batch", events: [
        event("c5", "turn-1", "2026-09-26T00:00:04Z", { type: "message", message_id: "m1", channel: "final", text: "**Checking**\n\n`code`", truncated: false }),
        event("c6", "turn-1", "2026-09-26T00:00:05Z", { type: "turn_completed" })
      ], next_cursor: "c6", earliest_cursor: "c0", latest_cursor: "c6" }
    ]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    const first = await opened.cursor.readObservation();
    expect(first.agentMessages).toEqual([expect.objectContaining({ messageId: "m1", channel: "commentary", markdown: "**Checking**\n\n`code`" })]);
    expect(first.timelineDeltas).toContainEqual(expect.objectContaining({ kind: "tool", category: "test", command: "npm test", state: "succeeded" }));
    const second = await opened.cursor.readObservation();
    expect(second.answerDelta).toBe("");
    expect(second.agentMessages).toEqual([expect.objectContaining({ messageId: "m1", channel: "final" })]);
    expect(second.timelineDeltas).toEqual([expect.objectContaining({ id: "message:m1", kind: "final_answer" })]);
    expect(second.turnLifecycle).toMatchObject({ state: "completed", finalAnswer: "**Checking**\n\n`code`" });
  });

  it("projects update_plan without exposing it as tool activity", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "plan-1", name: "exec", arguments: 'const r = await tools.update_plan({plan:[{step:"Inspect",status:"completed"},{step:"Fix",status:"in_progress"}]}); text(r);', truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "plan-1", text: "{}", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    const observed = await opened.cursor.readObservation();
    expect(observed).toMatchObject({
      mainStatus: { planSteps: [{ label: "Inspect", state: "done" }, { label: "Fix", state: "active" }] }
    });
    expect(observed.toolActivities).toBeUndefined();
    expect(observed.timelineDeltas).toBeUndefined();
  });

  it("continues after skipped records and fails closed on source errors", async () => {
    const { reader } = harness([
      { type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "record_skipped", code: "record_too_large" }),
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "m2", channel: "final", text: "after skip", truncated: false })
      ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" },
      { type: "agent_events_batch", events: [event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "source_error", code: "runtime_identity_changed" })], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" }
    ]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "after skip" });
    await expect(opened.cursor.readObservation()).rejects.toThrow("runtime_identity_changed");
  });

  it("rejects a stalled cursor and mismatched pane identity", async () => {
    const stalled = harness([{ type: "agent_events_batch", events: [], next_cursor: "c0", earliest_cursor: "c0", latest_cursor: "c9" }]);
    const opened = await stalled.reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).rejects.toThrow("event cursor stalled");

    const reader = new HerdrEventsReader({ run: vi.fn() }, { async listAllPanes() { return []; } }, "herdr", async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));
    await expect(reader.open(source)).resolves.toEqual({ mode: "unavailable", reason: "transcript_validation_failed" });
  });

  it("opens the active turn from Core's indexed cursor without scanning retained history", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) {
        expect(args[args.indexOf("--from") + 1]).toBe("end");
        return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 65_761_620, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 65_761_620, earliest_cursor: "c0", latest_cursor: "c168805" }] });
      }
      if (args.includes("locate")) {
        expect(args).toEqual(["agent", "events", "locate", "--source", "source-1", "--boundary", "active"]);
        return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: true, after_cursor: "c168000" });
      }
      expect(args[args.indexOf("--after") + 1]).toBe("c168000");
      return response({ type: "agent_events_batch", events: [
        event("c168001", "turn-2", "2026-09-26T00:00:04.250Z", { type: "turn_started" }),
        event("c168002", "turn-2", "2026-09-26T00:00:05Z", { type: "message", message_id: "m2", channel: "commentary", text: "current", truncated: false })
      ], next_cursor: "c168002", earliest_cursor: "c0", latest_cursor: "c168805" });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr", async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    const opened = await reader.openActiveTurn(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({
      freshTurnStart: true,
      answerDelta: "current",
      turnLifecycle: { turnId: "turn-2", startedAt: "2026-09-26T00:00:04.250Z" }
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("recovers an active turn from the previous Core source after a live handoff", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-current", attach_offset: 72_000_000, sources: [
        { source_id: "source-old", terminal_id: "terminal-old", agent_kind: "traex", session_id: "session-1", state: "error", checkpoint_offset: 69_000_000, earliest_cursor: "old:0", latest_cursor: "old:900" },
        { source_id: "source-current", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 72_000_000, earliest_cursor: "current:0", latest_cursor: "current:0" }
      ] });
      if (args.includes("locate")) {
        const sourceId = args[args.indexOf("--source") + 1];
        return response({ type: "agent_events_turn_cursor", source_id: sourceId, found: sourceId === "source-old", after_cursor: sourceId === "source-old" ? "old:700" : "current:0" });
      }
      expect(args[args.indexOf("--source") + 1]).toBe("source-old");
      expect(args[args.indexOf("--after") + 1]).toBe("old:700");
      return response({ type: "agent_events_batch", events: [{ ...event("old:701", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "m1", channel: "commentary", text: "recovered", truncated: false }), source_id: "source-old" }], next_cursor: "old:701", earliest_cursor: "old:0", latest_cursor: "old:900" });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr", async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    const opened = await reader.openActiveTurn(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "recovered" });
    expect(run.mock.calls.filter(([, args]) => args.includes("locate")).map(([, args]) => args[args.indexOf("--source") + 1])).toEqual(["source-current", "source-old"]);
  });

  it.each([
    ["at" as const, "c900", "c901"],
    ["after" as const, "c999", "c1000"]
  ])("opens the %s turn boundary with one locate and no retained-floor reads", async (boundary, locatedCursor, eventCursor) => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 65_761_620, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 65_761_620, earliest_cursor: "c0", latest_cursor: "c168805" }] });
      if (args.includes("locate")) {
        expect(args).toEqual(["agent", "events", "locate", "--source", "source-1", "--boundary", boundary, "--turn-id", "turn-1", "--started-at", "2026-09-26T00:00:00.000Z"]);
        return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: true, after_cursor: locatedCursor });
      }
      expect(args[args.indexOf("--after") + 1]).toBe(locatedCursor);
      return response({ type: "agent_events_batch", events: [event(eventCursor, "turn-next", "2026-09-26T00:01:00Z", { type: "turn_started" })], next_cursor: eventCursor, earliest_cursor: "c0", latest_cursor: "c168805" });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr", async () => ({ sessionId: "session-1", path: "/tmp/session.jsonl" }));

    const opened = boundary === "at"
      ? await reader.openAtTurn(source, "turn-1", "2026-09-26T00:00:00.000Z")
      : await reader.openAfterTurn(source, "turn-1", "2026-09-26T00:00:00.000Z");
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await opened.cursor.readObservation();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects events whose agent or session identity differs from the attached source", async () => {
    const wrongSession = { ...event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }), session_id: "session-other" };
    const { reader } = harness([{ type: "agent_events_batch", events: [wrongSession], next_cursor: "c1", earliest_cursor: "c0", latest_cursor: "c1" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).rejects.toThrow("event identity mismatch");
  });
});
