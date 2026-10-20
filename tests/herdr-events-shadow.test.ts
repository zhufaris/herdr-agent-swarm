import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { CommandRunner } from "../src/infra/command-runner.js";
import type { AgentTranscriptReaderPort, AgentTranscriptSource } from "../src/domain/ports/external.js";
import { HerdrEventsShadowReader } from "../src/runtime/herdr-events-shadow.js";

const source: AgentTranscriptSource = {
  agentKind: "pi", bindingId: "binding-1", generation: 2, paneId: "pane-1",
  nativeSession: { source: "native", agent: "pi", kind: "id", value: "session-1" }
};

function response(result: object) { return { stdout: JSON.stringify({ id: "test", result }), stderr: "" }; }
function primary(finalAnswer = "same answer"): AgentTranscriptReaderPort {
  return { async open() { return { mode: "typed", cursor: {
    async readDelta() { return finalAnswer; },
    async readObservation() { return { answerDelta: finalAnswer, turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-26T00:00:00Z", finalAnswer } }; }
  } }; } };
}
function harness(eventAnswer = "same answer", fail = false, laggedAttach = false) {
  const entries: Array<Record<string, unknown>> = [];
  const logger = {
    info(fields: Record<string, unknown>) { entries.push(fields); },
    debug(fields: Record<string, unknown>) { entries.push(fields); }
  } as unknown as Logger;
  const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
    if (fail) throw new Error("secret host failure");
    if (args.includes("attach")) return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 100, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "pi", session_id: "session-1", state: "active", checkpoint_offset: laggedAttach ? 20 : 100, latest_cursor: laggedAttach ? "cursor-before-history" : "cursor-before-turn" }] });
    if (args.includes("sources")) return response({ type: "agent_events_sources", enabled: true, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "pi", session_id: "session-1", state: "active", checkpoint_offset: 100, latest_cursor: "cursor-before-turn" }] });
    return response({ type: "agent_events_batch", events: [
      { schema_version: 1, source_id: "source-1", turn_id: "turn-1", payload: { type: "message", channel: "final", text: eventAnswer, truncated: false } },
      { schema_version: 1, source_id: "source-1", turn_id: "turn-1", payload: { type: "turn_completed" } }
    ], next_cursor: "cursor-2", latest_cursor: "cursor-2" });
  });
  const reader = new HerdrEventsShadowReader(primary(), { run }, { async listAllPanes() { return [{ paneId: "pane-1", terminalId: "terminal-1", workspaceId: "w1", cwd: null, label: null, agentState: "idle", foregroundExecutables: [], agentSession: source.nativeSession }]; } }, "herdr", logger, async () => ({ sessionId: "session-1", path: "/tmp/pi-session.jsonl" }));
  return { reader, entries, run };
}
async function observe(reader: HerdrEventsShadowReader) {
  const opened = await reader.open(source);
  if (opened.mode !== "typed" || !opened.cursor.readObservation) throw new Error("expected typed cursor");
  const observation = await opened.cursor.readObservation();
  await vi.waitFor(() => expect(observation.turnLifecycle?.state).toBe("completed"));
  return observation;
}

describe("HerdrEventsShadowReader", () => {
  it("establishes the Core baseline before returning a primary cursor", async () => {
    let release!: () => void;
    const attachGate = new Promise<void>((resolve) => { release = resolve; });
    const { reader, run } = harness();
    run.mockImplementationOnce(async () => {
      await attachGate;
      return response({ type: "agent_events_attached", source_id: "source-1", attach_offset: 100, sources: [{ source_id: "source-1", terminal_id: "terminal-1", agent_kind: "pi", session_id: "session-1", state: "active", checkpoint_offset: 100, latest_cursor: "cursor-before-turn" }] });
    });
    let opened = false;
    const opening = reader.open(source).then((result) => { opened = true; return result; });
    await Promise.resolve();
    expect(opened).toBe(false);
    release();
    await expect(opening).resolves.toMatchObject({ mode: "typed" });
  });

  it("returns the primary observation unchanged and records a content-free match", async () => {
    const { reader, entries, run } = harness();
    const observation = await observe(reader);
    await vi.waitFor(() => expect(entries).toContainEqual(expect.objectContaining({ outcome: "match", turnId: "turn-1" })));
    expect(observation.answerDelta).toBe("same answer");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toContain("cursor-before-turn");
    expect(JSON.stringify(entries)).not.toContain("same answer");
  });

  it("reports mismatch without replacing JSONL output", async () => {
    const { reader, entries } = harness("different answer");
    expect((await observe(reader)).answerDelta).toBe("same answer");
    await vi.waitFor(() => expect(entries).toContainEqual(expect.objectContaining({ outcome: "answer_mismatch" })));
  });

  it("waits for Core to capture the attach high-water mark before baselining", async () => {
    const { reader, entries, run } = harness("same answer", false, true);
    await observe(reader);
    await vi.waitFor(() => expect(entries).toContainEqual(expect.objectContaining({ outcome: "match" })));
    expect(run.mock.calls.map((call) => call[1][2])).toEqual(["attach", "sources", "read"]);
    expect(run.mock.calls[2]?.[1]).toContain("cursor-before-turn");
  });

  it("contains Core failures and does not log command details", async () => {
    const { reader, entries } = harness("unused", true);
    expect((await observe(reader)).answerDelta).toBe("same answer");
    await vi.waitFor(() => expect(entries).toContainEqual(expect.objectContaining({ outcome: "unavailable", reason: "command_unavailable" })));
    expect(JSON.stringify(entries)).not.toContain("secret host failure");
  });
});
