import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/infra/command-runner.js";
import type { AgentTranscriptSource, HerdrPort } from "../src/domain/ports/external.js";
import { HerdrEventsReader } from "../src/runtime/herdr-events-reader.js";
import { CommandError } from "../src/infra/command-runner.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { renderRequestAnswerCard } from "../src/cards/run-card.js";
import { piSessionId } from "../src/runtime/agents/pi-transcript-identity.js";

const source: AgentTranscriptSource = {
  agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1",
  nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
};
const pane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: null, label: null, agentState: "idle" as const, foregroundExecutables: [], agentSession: source.nativeSession };
const response = (result: object) => ({ stdout: JSON.stringify({ id: "test", result }), stderr: "" });
const event = (cursor: string, turnId: string, occurredAt: string, payload: object) => ({ schema_version: 1, event_id: cursor, cursor, source_id: "source-1", agent_kind: "traex", session_id: "session-1", turn_id: turnId, occurred_at: occurredAt, payload });

function harness(batches: object[]) {
  const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
    if (args.includes("sources")) {
      return response({ type: "agent_events_sources", enabled: true, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 10, earliest_cursor: "c0", latest_cursor: "c0" }] });
    }
    if (args.includes("attach")) {
      expect(args).toEqual(["agent", "events", "attach", "--pane", "w1:p1", "--kind", "traex", "--session-id", "session-1", "--from", "end"]);
      return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 10, earliest_cursor: "c0", latest_cursor: "c0" }] });
    }
    return response(batches.shift() ?? { type: "agent_events_batch", events: [], next_cursor: "c0", earliest_cursor: "c0", latest_cursor: "c0" });
  });
  const herdr = { async listAllPanes() { return [pane]; } } as Pick<HerdrPort, "listAllPanes">;
  return { reader: new HerdrEventsReader({ run }, herdr, "herdr"), run };
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

  it("accepts Core human messages without projecting them into the Answer", async () => {
    const { reader } = harness([
      { type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "human_message", message_id: "human-1", text: "private request", truncated: false })
      ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c3" },
      { type: "agent_events_batch", events: [
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "message", message_id: "m1", channel: "final", text: "visible answer", truncated: false })
      ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }
    ]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    const beforeTurn = await opened.cursor.readObservation();
    const observed = await opened.cursor.readObservation();

    expect(beforeTurn).toMatchObject({ turnId: "turn-1", freshTurnStart: true, answerDelta: "", requestText: "private request" });
    expect(observed.answerDelta).toBe("visible answer");
    expect(observed).not.toHaveProperty("requestText");
  });

  it("never attaches a pending human message to a different turn", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-old", "2026-09-26T00:00:00Z", { type: "human_message", message_id: "human-old", text: "old request", truncated: false }),
      event("c2", "turn-new", "2026-09-26T00:00:01Z", { type: "turn_started" })
    ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c2" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    await expect(opened.cursor.readObservation()).resolves.toEqual({ turnId: "turn-old", answerDelta: "" });
    const started = await opened.cursor.readObservation();
    expect(started).toMatchObject({ turnId: "turn-new", freshTurnStart: true, answerDelta: "" });
    expect(started).not.toHaveProperty("requestText");
  });

  it("keeps ordinary tools out of semantic Task List progress", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "command-1", name: "exec_command", arguments: JSON.stringify({ cmd: "git status" }), truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "command-1", text: "clean", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    const observed = await opened.cursor.readObservation();
    expect(observed.toolActivities).toEqual([
      expect.objectContaining({ key: "tool:command-1", kind: "analyze", state: "active" }),
      expect.objectContaining({ key: "tool:command-1", kind: "analyze", state: "done" })
    ]);
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

  it("keeps terminal lifecycle monotonic across later event batches", async () => {
    const { reader } = harness([
      { type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "turn_completed" })
      ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c3" },
      { type: "agent_events_batch", events: [
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "files_changed", file_count: 1 })
      ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }
    ]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    expect((await opened.cursor.readObservation()).turnLifecycle).toMatchObject({ state: "completed" });
    expect((await opened.cursor.readObservation()).turnLifecycle).toMatchObject({ state: "completed" });
  });

  it("projects Skill calls as summary-only timeline tools", async () => {
    const skillPath = ["", "data00", "home", "fixture-user", ".agents", "skills", "test", "SKILL.md"].join("/");
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "skill-1", name: "read_file", arguments: JSON.stringify({ path: skillPath }), truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "skill-1", text: "full private skill instructions", is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    const observed = await opened.cursor.readObservation();
    expect(observed.timelineDeltas).toContainEqual(expect.objectContaining({ category: "skill", label: "test", state: "succeeded" }));
    expect(JSON.stringify(observed.timelineDeltas)).not.toContain("full private skill instructions");
  });

  it("shows bounded write_stdin input as code without exposing polled command output", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "tool_call", call_id: "stdin-1", name: "write_stdin", arguments: JSON.stringify({ session_id: 263, chars: "echo visible\nTOKEN=do-not-show\n" }), truncated: false }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_result", call_id: "stdin-1", text: JSON.stringify({ exit_code: 0, output: "private process output" }), is_error: false, truncated: false })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    const observed = await opened.cursor.readObservation();

    expect(observed.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", id: "tool:stdin-1", category: "input", label: "session 263", command: "echo visible\nTOKEN=[REDACTED]", state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:stdin-1", category: "input", label: "session 263", command: "echo visible\nTOKEN=[REDACTED]", state: "succeeded" })
    ]);
    expect(JSON.stringify(observed.timelineDeltas)).not.toMatch(/do-not-show|private process output/);
  });

  it("projects Core files_changed events into the Answer timeline", async () => {
    const { reader } = harness([{ type: "agent_events_batch", events: [
      event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
      event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "files_changed", file_count: 2 }),
      event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "files_changed", file_count: 3 })
    ], next_cursor: "c3", earliest_cursor: "c0", latest_cursor: "c3" }]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    const observed = await opened.cursor.readObservation();

    expect(observed.toolActivities).toEqual([
      { key: "files-changed:turn-1", kind: "edit", label: "已编辑 2 个文件", state: "done" },
      { key: "files-changed:turn-1", kind: "edit", label: "已编辑 3 个文件", state: "done" }
    ]);
    expect(observed.timelineDeltas).toEqual([
      { kind: "tool", id: "files-changed:turn-1", sequence: 1, category: "edit", label: "已编辑 2 个文件", state: "succeeded" },
      { kind: "tool", id: "files-changed:turn-1", sequence: 1, category: "edit", label: "已编辑 3 个文件", state: "succeeded" }
    ]);
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Edit files", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 0, occurredAt: "2026-09-26T00:00:00Z" });
    const view = reduceRunCard(queued, { type: "output", occurredAt: "2026-09-26T00:00:02Z", answerSnapshot: "", progressEvents: [], timelineDeltas: observed.timelineDeltas });
    expect(view.timelineItems).toEqual([{
      kind: "tool", id: "files-changed:turn-1", sequence: 1, category: "edit", label: "已编辑 3 个文件", state: "succeeded"
    }]);
    const card = renderRequestAnswerCard(view, { timelineItems: view.timelineItems });
    expect(JSON.stringify(card)).toContain("✏️ Edited · 已编辑 3 个文件 · ✅");
  });

  it("does not regress the edited-file total when retained events are replayed", async () => {
    const { reader } = harness([
      { type: "agent_events_batch", events: [
        event("c1", "turn-1", "2026-09-26T00:00:00Z", { type: "turn_started" }),
        event("c2", "turn-1", "2026-09-26T00:00:01Z", { type: "files_changed", file_count: 3 })
      ], next_cursor: "c2", earliest_cursor: "c0", latest_cursor: "c4" },
      { type: "agent_events_batch", events: [
        event("c3", "turn-1", "2026-09-26T00:00:02Z", { type: "files_changed", file_count: 2 }),
        event("c4", "turn-1", "2026-09-26T00:00:03Z", { type: "files_changed", file_count: 4 })
      ], next_cursor: "c4", earliest_cursor: "c0", latest_cursor: "c4" }
    ]);
    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");

    const first = await opened.cursor.readObservation();
    const replayed = await opened.cursor.readObservation();

    expect(first.timelineDeltas).toEqual([
      { kind: "tool", id: "files-changed:turn-1", sequence: 1, category: "edit", label: "已编辑 3 个文件", state: "succeeded" }
    ]);
    expect(replayed.timelineDeltas).toEqual([
      { kind: "tool", id: "files-changed:turn-1", sequence: 1, category: "edit", label: "已编辑 4 个文件", state: "succeeded" }
    ]);
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

    const reader = new HerdrEventsReader({ run: vi.fn() }, { async listAllPanes() { return []; } }, "herdr");
    await expect(reader.open(source)).resolves.toEqual({ mode: "unavailable", reason: "transcript_validation_failed" });
  });

  it("opens an already registered Core source without requiring an Agent transcript path", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) throw new Error("Herdr 0.9 attach requires --path");
      expect(args).toEqual(["agent", "events", "sources"]);
      return response({
        type: "agent_events_sources",
        enabled: true,
        sources: [{
          source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1",
          state: "active", checkpoint_offset: 10, earliest_cursor: "c0", latest_cursor: "c9"
        }]
      });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr");

    await expect(reader.open(source)).resolves.toMatchObject({ mode: "typed" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("derives the expected Pi session identity without locating a JSONL path", async () => {
    const piSource: AgentTranscriptSource = {
      agentKind: "pi", bindingId: "worker-1", generation: 3, paneId: "w1:p2", nativeSession: null
    };
    const sessionId = piSessionId(piSource.bindingId, piSource.generation);
    const piPane = { ...pane, paneId: "w1:p2", terminalId: "terminal-2", agentSession: { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/core-owned/session.jsonl" } };
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("sources")) return response({ type: "agent_events_sources", enabled: true, sources: [{ source_id: "source-pi", terminal_id: "terminal-2", agent_kind: "pi", session_id: sessionId, state: "active", checkpoint_offset: 0, earliest_cursor: "c0", latest_cursor: "c0" }] });
      expect(args).toEqual(["agent", "events", "attach", "--pane", "w1:p2", "--kind", "pi", "--session-id", sessionId, "--from", "end"]);
      return response({ type: "agent_events_attached", source_id: "source-pi", attach_offset: 0, sources: [{ source_id: "source-pi", terminal_id: "terminal-2", agent_kind: "pi", session_id: sessionId, state: "active", checkpoint_offset: 0, earliest_cursor: "c0", latest_cursor: "c0" }] });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [piPane]; } }, "herdr");

    await expect(reader.open(piSource)).resolves.toMatchObject({ mode: "typed" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("opens the active turn from Core's indexed cursor without scanning retained history", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("sources")) return response({ type: "agent_events_sources", enabled: true, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 65_761_620, earliest_cursor: "c0", latest_cursor: "c168805" }] });
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
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr");

    const opened = await reader.open(source, { kind: "active" });
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
      if (args.includes("sources")) return response({ type: "agent_events_sources", enabled: true, sources: [
        { source_id: "source-old", terminal_id: "terminal-old", agent_kind: "traex", session_id: "session-1", state: "error", checkpoint_offset: 69_000_000, earliest_cursor: "old:0", latest_cursor: "old:900" },
        { source_id: "source-current", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 72_000_000, earliest_cursor: "current:0", latest_cursor: "current:0" }
      ] });
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-current", attach_offset: 72_000_000, sources: [
        { source_id: "source-old", terminal_id: "terminal-old", agent_kind: "traex", session_id: "session-1", state: "error", checkpoint_offset: 69_000_000, earliest_cursor: "old:0", latest_cursor: "old:900" },
        { source_id: "source-current", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 72_000_000, earliest_cursor: "current:0", latest_cursor: "current:0" }
      ] });
      if (args.includes("locate")) {
        const sourceId = args[args.indexOf("--source") + 1];
        return response({ type: "agent_events_turn_cursor", source_id: sourceId, found: sourceId === "source-old", after_cursor: sourceId === "source-old" ? "old:700" : "current:0" });
      }
      const sourceId = args[args.indexOf("--source") + 1];
      const after = args[args.indexOf("--after") + 1];
      if (sourceId === "source-old") {
        expect(after).toBe("old:700");
        return response({ type: "agent_events_batch", events: [
          { ...event("old:701", "turn-1", "2026-09-26T00:00:01Z", { type: "message", message_id: "m1", channel: "commentary", text: "recovered", truncated: false }), source_id: "source-old" },
          { ...event("old:702", "turn-1", "2026-09-26T00:00:02Z", { type: "tool_call", call_id: "plan-1", name: "exec", arguments: 'tools.update_plan({plan:[{step:"Recovered plan",status:"in_progress"}]})', truncated: false }), source_id: "source-old" },
          { ...event("old:900", "turn-1", "2026-09-26T00:00:03Z", { type: "source_error", code: "runtime_identity_changed" }), source_id: "source-old" }
        ], next_cursor: "old:900", earliest_cursor: "old:0", latest_cursor: "old:900" });
      }
      expect(sourceId).toBe("source-current");
      expect(after).toBe("current:0");
      return response({ type: "agent_events_batch", events: [{ ...event("current:1", "turn-1", "2026-09-26T00:00:04Z", { type: "message", message_id: "m2", channel: "commentary", text: "live", truncated: false }), source_id: "source-current" }], next_cursor: "current:1", earliest_cursor: "current:0", latest_cursor: "current:1" });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr");

    const opened = await reader.open(source, { kind: "active" });
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({
      answerDelta: "recovered",
      mainStatus: { planSteps: [{ label: "Recovered plan", state: "active" }] }
    });
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "live" });
    expect(run.mock.calls.filter(([, args]) => args.includes("locate")).map(([, args]) => args[args.indexOf("--source") + 1])).toEqual(["source-current", "source-old"]);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["at" as const, "c900", "c901"],
    ["after" as const, "c999", "c1000"]
  ])("opens the %s turn boundary with one locate and no retained-floor reads", async (boundary, locatedCursor, eventCursor) => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("sources")) return response({ type: "agent_events_sources", enabled: true, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 65_761_620, earliest_cursor: "c0", latest_cursor: "c168805" }] });
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 65_761_620, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 65_761_620, earliest_cursor: "c0", latest_cursor: "c168805" }] });
      if (args.includes("locate")) {
        expect(args).toEqual(["agent", "events", "locate", "--source", "source-1", "--boundary", boundary, "--turn-id", "turn-1", "--started-at", "2026-09-26T00:00:00.000Z"]);
        return response({ type: "agent_events_turn_cursor", source_id: "source-1", found: true, after_cursor: locatedCursor });
      }
      expect(args[args.indexOf("--after") + 1]).toBe(locatedCursor);
      return response({ type: "agent_events_batch", events: [event(eventCursor, "turn-next", "2026-09-26T00:01:00Z", { type: "turn_started" })], next_cursor: eventCursor, earliest_cursor: "c0", latest_cursor: "c168805" });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr");

    const opened = await reader.open(source, {
      kind: boundary,
      turnId: "turn-1",
      startedAt: "2026-09-26T00:00:00.000Z"
    });
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

  it("recovers once from Core's retained floor when an open cursor expires", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("sources")) return response({ type: "agent_events_sources", enabled: true, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 10, earliest_cursor: "c0", latest_cursor: "c9" }] });
      if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 10, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", state: "active", checkpoint_offset: 10, earliest_cursor: "c0", latest_cursor: "c9" }] });
      const after = args[args.indexOf("--after") + 1];
      if (after === "c9") {
        throw new CommandError("herdr", args, "cursor expired", false, undefined, {
          code: "cursor_expired",
          earliestCursor: "c12",
          latestCursor: "c15"
        });
      }
      expect(after).toBe("c12");
      return response({ type: "agent_events_batch", events: [event("c13", "turn-2", "2026-09-26T00:01:00Z", { type: "message", message_id: "m2", channel: "commentary", text: "retained", truncated: false })], next_cursor: "c13", earliest_cursor: "c12", latest_cursor: "c15" });
    });
    const reader = new HerdrEventsReader({ run }, { async listAllPanes() { return [pane]; } }, "herdr");

    const opened = await reader.open(source);
    if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("reader unavailable");
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ answerDelta: "retained" });
    expect(run.mock.calls.filter(([, args]) => args.includes("read"))).toHaveLength(2);
  });
});
