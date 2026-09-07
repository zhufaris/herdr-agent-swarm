import { describe, expect, it, vi } from "vitest";
import { ExactTurnObserver } from "../src/runtime/exact-turn-observer.js";
import type { TraexTranscriptObservation, TraexTranscriptReaderPort } from "../src/domain/ports.js";

const session = { source: "traex", agent: "traex", kind: "id" as const, value: "session-1" };
const exact = { turnId: "turn-1", startedAt: "2026-09-07T00:00:00.000Z" };

function reader(observations: TraexTranscriptObservation[]): TraexTranscriptReaderPort {
  const readObservation = vi.fn(async () => observations.shift() ?? { answerDelta: "" });
  const opened = { mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } };
  return {
    open: vi.fn(async () => opened),
    openAtTurn: vi.fn(async () => opened),
    openAfterTurn: vi.fn(async () => opened)
  };
}

describe("ExactTurnObserver", () => {
  it("opens latest, at-turn, and after-turn cursors through one interface", async () => {
    const source = reader([]);
    const observer = new ExactTurnObserver(source);

    expect((await observer.open({ session, boundary: { kind: "latest" } })).mode).toBe("typed");
    expect((await observer.open({ session, boundary: { kind: "at", ...exact } })).mode).toBe("typed");
    expect((await observer.open({ session, boundary: { kind: "after", ...exact } })).mode).toBe("typed");

    expect(source.open).toHaveBeenCalledWith(session);
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
    const observed: TraexTranscriptObservation[] = [];

    const result = await opened.cursor.drain({ limit: 8, onObservation: async (value) => { observed.push(value); return value.turnLifecycle?.state === "completed" ? "stop" : "continue"; } });

    expect(result).toEqual({ accepted: 2, stopped: true });
    expect(observed).toEqual([active, completed]);
  });

  it("stops a final drain when the transcript repeats the last accepted observation", async () => {
    const active = { turnId: exact.turnId, answerDelta: "one", turnLifecycle: { ...exact, state: "active" as const } };
    const source = reader([active, active, { turnId: exact.turnId, answerDelta: "must not be reached" }]);
    const opened = await new ExactTurnObserver(source).open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const observed: TraexTranscriptObservation[] = [];

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

  it("reports an unsupported recovery cursor without falling back to latest", async () => {
    const source: TraexTranscriptReaderPort = { open: vi.fn(async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" })) };

    await expect(new ExactTurnObserver(source).open({ session, boundary: { kind: "after", ...exact } }))
      .resolves.toEqual({ mode: "unavailable", reason: "recovery_cursor_unavailable" });
    expect(source.open).not.toHaveBeenCalled();
  });
});
