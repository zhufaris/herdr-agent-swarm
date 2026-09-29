import { describe, expect, it, vi } from "vitest";
import { ExactTurnObserver } from "../src/runtime/exact-turn-observer.js";
import type { AgentTranscriptObservation, AgentTranscriptReaderPort } from "../src/domain/ports.js";

const session = { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" };
const transcriptSource = { agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "pane-1", nativeSession: session };
const exact = { turnId: "turn-1", startedAt: "2026-09-07T00:00:00.000Z" };

function reader(observations: AgentTranscriptObservation[]): AgentTranscriptReaderPort {
  const readObservation = vi.fn(async () => observations.shift() ?? { answerDelta: "" });
  const opened = { mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } };
  return {
    open: vi.fn(async () => opened)
  };
}

describe("ExactTurnObserver", () => {
  it("opens latest, active-turn, first-turn, at-turn, and after-turn cursors through one interface", async () => {
    const source = reader([]);
    const observer = new ExactTurnObserver(source);

    for (const boundary of [
      { kind: "latest" as const },
      { kind: "active" as const },
      { kind: "first" as const },
      { kind: "at" as const, ...exact },
      { kind: "after" as const, ...exact }
    ]) {
      expect((await observer.open({ source: transcriptSource, boundary })).mode).toBe("typed");
    }

    expect(source.open).toHaveBeenNthCalledWith(1, transcriptSource, { kind: "latest" });
    expect(source.open).toHaveBeenNthCalledWith(2, transcriptSource, { kind: "active" });
    expect(source.open).toHaveBeenNthCalledWith(3, transcriptSource, { kind: "first" });
    expect(source.open).toHaveBeenNthCalledWith(4, transcriptSource, { kind: "at", ...exact });
    expect(source.open).toHaveBeenNthCalledWith(5, transcriptSource, { kind: "after", ...exact });
  });

  it("accepts each exact observation once and rejects foreign turn identities", async () => {
    const matching = { turnId: exact.turnId, answerDelta: "trusted", turnLifecycle: { ...exact, state: "active" as const } };
    const source = reader([
      matching,
      matching,
      { turnId: "turn-2", answerDelta: "foreign", turnLifecycle: { turnId: "turn-2", startedAt: exact.startedAt, state: "completed" } },
      { turnId: exact.turnId, answerDelta: "wrong start", turnLifecycle: { turnId: exact.turnId, startedAt: "2026-09-07T00:00:01.000Z", state: "completed" } }
    ]);
    const opened = await new ExactTurnObserver(source).open({ source: transcriptSource, boundary: { kind: "latest" }, expected: exact });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    expect(await opened.cursor.read()).toEqual({ kind: "accepted", observation: matching });
    expect(await opened.cursor.read()).toEqual({ kind: "duplicate" });
    expect(await opened.cursor.read()).toMatchObject({ kind: "foreign", observedTurnId: "turn-2" });
    expect(await opened.cursor.read()).toMatchObject({ kind: "foreign", observedTurnId: exact.turnId });
  });

  it("compares rolling-upgrade start timestamps at canonical second precision", async () => {
    const sameSecond = { turnId: exact.turnId, answerDelta: "trusted", turnLifecycle: { turnId: exact.turnId, startedAt: "2026-09-07T00:00:00Z", state: "active" as const } };
    const nextSecond = { turnId: exact.turnId, answerDelta: "foreign", turnLifecycle: { turnId: exact.turnId, startedAt: "2026-09-07T00:00:01Z", state: "active" as const } };
    const opened = await new ExactTurnObserver(reader([sameSecond, nextSecond])).open({ source: transcriptSource, boundary: { kind: "latest" }, expected: { ...exact, startedAt: "2026-09-07T00:00:00.987Z" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    await expect(opened.cursor.read()).resolves.toEqual({ kind: "accepted", observation: sameSecond });
    await expect(opened.cursor.read()).resolves.toMatchObject({ kind: "foreign", observedStartedAt: "2026-09-07T00:00:01Z" });
  });

  it("fails closed when matching turn start timestamps are malformed", async () => {
    const malformed = { turnId: exact.turnId, answerDelta: "untrusted", turnLifecycle: { turnId: exact.turnId, startedAt: "not-a-time", state: "completed" as const } };
    const opened = await new ExactTurnObserver(reader([malformed])).open({
      source: transcriptSource,
      boundary: { kind: "latest" },
      expected: { ...exact, startedAt: "not-a-time" }
    });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    await expect(opened.cursor.read()).resolves.toMatchObject({ kind: "foreign", observedStartedAt: "not-a-time" });
  });

  it("drains bounded accepted observations and stops at terminal lifecycle", async () => {
    const active = { turnId: exact.turnId, answerDelta: "one", turnLifecycle: { ...exact, state: "active" as const } };
    const completed = { turnId: exact.turnId, answerDelta: "two", turnLifecycle: { ...exact, state: "completed" as const } };
    const source = reader([active, completed, { turnId: exact.turnId, answerDelta: "late" }]);
    const opened = await new ExactTurnObserver(source).open({ source: transcriptSource, boundary: { kind: "after", ...exact }, expected: exact });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const observed: AgentTranscriptObservation[] = [];

    const result = await opened.cursor.drain({ limit: 8, onObservation: async (value) => { observed.push(value); return value.turnLifecycle?.state === "completed" ? "stop" : "continue"; } });

    expect(result).toEqual({ accepted: 2, stopped: true });
    expect(observed).toEqual([active, completed]);
  });

  it("stops a final drain when the transcript repeats the last accepted observation", async () => {
    const active = { turnId: exact.turnId, answerDelta: "one", turnLifecycle: { ...exact, state: "active" as const } };
    const source = reader([active, active, { turnId: exact.turnId, answerDelta: "must not be reached" }]);
    const opened = await new ExactTurnObserver(source).open({ source: transcriptSource, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const observed: AgentTranscriptObservation[] = [];

    const result = await opened.cursor.drain({ limit: 8, onObservation: async (value) => { observed.push(value); return "continue"; } });

    expect(result).toEqual({ accepted: 1, stopped: false });
    expect(observed).toEqual([active]);
  });

  it("preserves an explicitly empty request as an observation", async () => {
    const source = reader([{ turnId: exact.turnId, requestText: "", answerDelta: "" }]);
    const opened = await new ExactTurnObserver(source).open({ source: transcriptSource, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    await expect(opened.cursor.read()).resolves.toEqual({
      kind: "accepted",
      observation: { turnId: exact.turnId, requestText: "", answerDelta: "" }
    });
  });

  it("preserves a timeline-only observation", async () => {
    const observation = { turnId: exact.turnId, answerDelta: "", timelineDeltas: [{ kind: "tool" as const, id: "tool:1", sequence: 1, category: "read" as const, label: "config", state: "running" as const }] };
    const opened = await new ExactTurnObserver(reader([observation])).open({ source: transcriptSource, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    await expect(opened.cursor.read()).resolves.toEqual({ kind: "accepted", observation });
  });

  it("preserves an unavailable boundary result without falling back to latest", async () => {
    const source: AgentTranscriptReaderPort = { open: vi.fn(async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" })) };

    await expect(new ExactTurnObserver(source).open({ source: transcriptSource, boundary: { kind: "first" } }))
      .resolves.toEqual({ mode: "unavailable", reason: "transcript_not_found" });
    await expect(new ExactTurnObserver(source).open({ source: transcriptSource, boundary: { kind: "after", ...exact } }))
      .resolves.toEqual({ mode: "unavailable", reason: "transcript_not_found" });
    expect(source.open).toHaveBeenCalledTimes(2);
  });
});
