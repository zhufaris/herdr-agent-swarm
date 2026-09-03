import { describe, expect, it } from "vitest";
import { KeyedSerialWorkQueue } from "../src/runtime/keyed-serial-work-queue.js";

describe("KeyedSerialWorkQueue", () => {
  it("serializes one key, allows another key, and continues after a failure", async () => {
    const queue = new KeyedSerialWorkQueue<string>();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue("a", async () => { order.push("a1-start"); await new Promise<void>((resolve) => { release = resolve; }); order.push("a1-end"); });
    const second = queue.enqueue("a", async () => { order.push("a2"); });
    const other = queue.enqueue("b", async () => { order.push("b1"); });
    await other;
    expect(order).toEqual(["a1-start", "b1"]);
    release();
    await Promise.all([first, second]);
    await expect(queue.enqueue("a", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await queue.enqueue("a", async () => { order.push("a3"); });
    expect(order).toEqual(["a1-start", "b1", "a1-end", "a2", "a3"]);
  });

  it("waits for queued work and rejects new work after stop", async () => {
    const queue = new KeyedSerialWorkQueue<string>();
    let release!: () => void;
    const running = queue.enqueue("a", () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = queue.stop();
    release();
    await Promise.all([running, stopping]);
    await expect(queue.enqueue("a", async () => { throw new Error("not run"); })).resolves.toBeUndefined();
  });
});
