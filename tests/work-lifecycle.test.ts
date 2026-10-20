import { describe, expect, it } from "vitest";
import { WorkAdmissionGate, observeDetached } from "../src/runtime/work-lifecycle.js";

describe("WorkAdmissionGate", () => {
  it("closes admission before draining work that was already admitted", async () => {
    const gate = new WorkAdmissionGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;

    const admitted = gate.admit(async () => {
      starts += 1;
      await blocked;
      return "completed";
    });
    expect(admitted).not.toBeNull();
    await Promise.resolve();
    expect(starts).toBe(1);

    gate.close();
    gate.close();
    expect(gate.isOpen).toBe(false);
    expect(gate.admit(() => { starts += 1; })).toBeNull();
    expect(starts).toBe(1);

    let settled = false;
    const settling = gate.settle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(admitted).resolves.toBe("completed");
    await settling;
    expect(settled).toBe(true);
  });

  it("represents a synchronous admitted failure as a rejected promise", async () => {
    const gate = new WorkAdmissionGate();
    const admitted = gate.admit(() => { throw new Error("synchronous failure"); });
    expect(admitted).not.toBeNull();
    await expect(admitted).rejects.toThrow("synchronous failure");
    await gate.settle();
  });
});

describe("observeDetached", () => {
  it("owns both the task rejection and a rejecting observer", async () => {
    const failure = new Error("detached failure");
    const observed: unknown[] = [];

    observeDetached(Promise.reject(failure), (error) => {
      observed.push(error);
      throw new Error("observer failure");
    });

    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(observed).toEqual([failure]);
  });
});
