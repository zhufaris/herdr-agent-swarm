import { describe, expect, it, vi } from "vitest";
import { TurnSupervisor } from "../src/coordinator/turn-supervisor.js";

describe("turn supervisor", () => {
  it("owns observer identity, state, and shutdown detachment", () => {
    const supervisor = new TurnSupervisor();
    const detached = vi.fn();
    const controller = supervisor.attach("b1", "p1", "w1:p1");

    supervisor.updateState("b1", "other", "blocked");
    expect(supervisor.get("b1")?.state).toBe("working");
    supervisor.updateState("b1", "p1", "blocked");
    expect(supervisor.get("b1")?.state).toBe("blocked");

    supervisor.abortAll(detached);
    expect(controller.signal.aborted).toBe(true);
    expect(detached).toHaveBeenCalledWith(expect.objectContaining({ promptId: "p1", paneId: "w1:p1" }));
    supervisor.detach("b1", "p1");
    expect(supervisor.has("b1")).toBe(false);
  });

  it("rejects competing observers for the same binding", () => {
    const supervisor = new TurnSupervisor();
    supervisor.attach("b1", "p1", "w1:p1");
    expect(() => supervisor.attach("b1", "p2", "w1:p1")).toThrow(/already has an active turn observer/);
  });
});
