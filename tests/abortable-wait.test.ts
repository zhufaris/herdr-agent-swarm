import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableWait } from "../src/runtime/abortable-wait.js";

afterEach(() => vi.useRealTimers());

describe("abortableWait", () => {
  it("does not retain abort listeners after repeated timer completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    for (let index = 0; index < 250; index += 1) {
      const waiting = abortableWait(10, controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      await waiting;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  });

  it("rejects promptly on abort and removes its timer and listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = abortableWait(60_000, controller.signal);

    expect(vi.getTimerCount()).toBe(1);
    controller.abort();

    await expect(waiting).rejects.toThrow("aborted");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already-aborted signal without allocating resources", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await expect(abortableWait(60_000, controller.signal)).rejects.toThrow("aborted");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
