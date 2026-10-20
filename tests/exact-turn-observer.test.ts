import { describe, expect, it, vi } from "vitest";
import { ExactTurnObserver } from "../src/runtime/exact-turn-observer.js";
import type { AgentTranscriptObservation, AgentTranscriptReaderPort } from "../src/domain/ports.js";

const session = { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" };
const exact = { turnId: "turn-1", startedAt: "2026-09-07T00:00:00.000Z" };

function reader(observations: AgentTranscriptObservation[]): AgentTranscriptReaderPort {
  const readObservation = vi.fn(async () => observations.shift() ?? { answerDelta: "" });
  const opened = { mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } };
  return {
    open: vi.fn(async () => opened),
    openActiveTurn: vi.fn(async () => opened),
    openFirstTurn: vi.fn(async () => opened),
    openAtTurn: vi.fn(async () => opened),
    openAfterTurn: vi.fn(async () => opened)
  };
}

describe("ExactTurnObserver", () => {
  it("opens latest, active-turn, first-turn, at-turn, and after-turn cursors through one interface", async () => {
    const source = reader([]);
    const observer = new ExactTurnObserver(source);

    expect((await observer.open({ session, boundary: { kind: "latest" } })).mode).toBe("typed");
    expect((await observer.open({ session, boundary: { kind: "active" } })).mode).toBe("typed");
    expect((await observer.open({ session, boundary: { kind: "first" } })).mode).toBe("typed");
    expect((await observer.open({ session, boundary: { kind: "at", ...exact } })).mode).toBe("typed");
    expect((await observer.open({ session, boundary: { kind: "after", ...exact } })).mode).toBe("typed");

    expect(source.open).toHaveBeenCalledWith(session);
    expect(source.openActiveTurn).toHaveBeenCalledWith(session);
    expect(source.openFirstTurn).toHaveBeenCalledWith(session);
    expect(source.openAtTurn).toHaveBeenCalledWith(session, exact.turnId, exact.startedAt);
    expect(source.openAfterTurn).toHaveBeenCalledWith(session, exact.turnId, exact.startedAt);
  });

  it("accepts each exact observation once and rejects foreign turn identities", async () => {
    const matching = { turnId: exact.turnId, answerDelta: "trusted", turnLifecycle: { ...exact, state: "active" as const } };
    const source = reader([
      matching,
      matching,
      { turnId: "turn-2", answerDelta: "foreign", turnLifecycle: { turnId: "turn-2", startedAt: exact.startedAt, state: "completed" } },
      { turnId: exact.turnId, answerDelta: "wrong start", turnLifecycle: { turnId: exact.turnId, startedAt: "2026-09-07T00:00:01.000Z", state: "completed" } }
    ]);
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "latest" }, expected: exact });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    expect(await opened.cursor.read()).toEqual({ kind: "accepted", observation: matching });
    expect(await opened.cursor.read()).toEqual({ kind: "duplicate" });
    expect(await opened.cursor.read()).toMatchObject({ kind: "foreign", observedTurnId: "turn-2" });
    expect(await opened.cursor.read()).toMatchObject({ kind: "foreign", observedTurnId: exact.turnId });
  });

  it("drains bounded accepted observations and stops at terminal lifecycle", async () => {
    const active = { turnId: exact.turnId, answerDelta: "one", turnLifecycle: { ...exact, state: "active" as const } };
    const completed = { turnId: exact.turnId, answerDelta: "two", turnLifecycle: { ...exact, state: "completed" as const } };
    const source = reader([active, completed, { turnId: exact.turnId, answerDelta: "late" }]);
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "after", ...exact }, expected: exact });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const observed: AgentTranscriptObservation[] = [];

    const result = await opened.cursor.drain({ limit: 8, onObservation: async (value) => { observed.push(value); return value.turnLifecycle?.state === "completed" ? "stop" : "continue"; } });

    expect(result).toEqual({ accepted: 2, stopped: true });
    expect(observed).toEqual([active, completed]);
  });

  it("quarantines a failed projection and continues draining later observations", async () => {
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-1", answerDelta: "poison" },
      { turnId: "turn-2", answerDelta: "healthy" },
      { answerDelta: "" }
    ];
    const acknowledge = vi.fn();
    const source: AgentTranscriptReaderPort = {
      open: vi.fn(async () => ({ mode: "typed" as const, cursor: {
        readDelta: vi.fn(async () => ""),
        readObservation: vi.fn(async () => observations.shift() ?? { answerDelta: "" }),
        acknowledge
      } }))
    };
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    const result = await opened.cursor.drain({
      limit: 8,
      onObservation: async (observation) => {
        if (observation.answerDelta === "poison") throw new Error("projection failed");
        return "continue";
      }
    });

    expect(result).toEqual({ accepted: 2, stopped: false });
    expect(acknowledge).toHaveBeenNthCalledWith(1, "quarantined", "projection failed");
    expect(acknowledge).toHaveBeenNthCalledWith(2, "projected", undefined);
  });

  it("does not treat a durable retry of the same failed event as a duplicate", async () => {
    const poison = { turnId: exact.turnId, answerDelta: "poison" };
    let settled = false;
    const source: AgentTranscriptReaderPort = {
      open: vi.fn(async () => ({ mode: "typed" as const, cursor: {
        readDelta: vi.fn(async () => ""),
        readObservation: vi.fn(async () => settled ? { answerDelta: "" } : poison),
        acknowledge: vi.fn(async (outcome: "projected" | "ignored" | "quarantined") => { if (outcome === "projected") settled = true; })
      } }))
    };
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await opened.cursor.read()).toEqual({ kind: "accepted", observation: poison });
      await opened.cursor.acknowledge?.("quarantined", "projection failed");
    }
    expect(await opened.cursor.read()).toEqual({ kind: "accepted", observation: poison });
    await opened.cursor.acknowledge?.("projected");
    expect(await opened.cursor.read()).toEqual({ kind: "empty" });
  });

  it("stops a final drain when the transcript repeats the last accepted observation", async () => {
    const active = { turnId: exact.turnId, answerDelta: "one", turnLifecycle: { ...exact, state: "active" as const } };
    const source = reader([active, active, { turnId: exact.turnId, answerDelta: "must not be reached" }]);
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const observed: AgentTranscriptObservation[] = [];

    const result = await opened.cursor.drain({ limit: 8, onObservation: async (value) => { observed.push(value); return "continue"; } });

    expect(result).toEqual({ accepted: 1, stopped: false });
    expect(observed).toEqual([active]);
  });

  it("preserves an explicitly empty request as an observation", async () => {
    const source = reader([{ turnId: exact.turnId, requestText: "", answerDelta: "" }]);
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    await expect(opened.cursor.read()).resolves.toEqual({
      kind: "accepted",
      observation: { turnId: exact.turnId, requestText: "", answerDelta: "" }
    });
  });

  it("preserves a timeline-only observation", async () => {
    const observation = { turnId: exact.turnId, answerDelta: "", timelineDeltas: [{ kind: "tool" as const, id: "tool:1", sequence: 1, category: "read" as const, label: "config", state: "running" as const }] };
    const opened = await new ExactTurnObserver(reader([observation])).open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");

    await expect(opened.cursor.read()).resolves.toEqual({ kind: "accepted", observation });
  });

  it("reports an unsupported recovery cursor without falling back to latest", async () => {
    const source: AgentTranscriptReaderPort = { open: vi.fn(async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" })) };

    await expect(new ExactTurnObserver(source).open({ session, boundary: { kind: "first" } }))
      .resolves.toEqual({ mode: "unavailable", reason: "recovery_cursor_unavailable" });
    await expect(new ExactTurnObserver(source).open({ session, boundary: { kind: "after", ...exact } }))
      .resolves.toEqual({ mode: "unavailable", reason: "recovery_cursor_unavailable" });
    expect(source.open).not.toHaveBeenCalled();
  });
});
