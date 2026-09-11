import { describe, expect, it, vi } from "vitest";
import { TraexControlAdapter } from "../src/adapters/traex-control-adapter.js";

const session = { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" };
const peer = { threadId: session.value, socketPath: "/run/user/1/traex.sock", pid: 42, startedAtMs: 100 };

describe("TraexControlAdapter", () => {
  it.each(["herdr:traex", "herdr:codex", "herdr-traex-shim"])("lists models for TraeX source %s", async (source) => {
    const listModels = vi.fn(async () => [{ id: "one", name: "GPT-5.4", displayName: "GPT 5.4" }]);
    const findPeer = vi.fn(async () => peer);
    const adapter = control({ findPeer, listModels });

    await expect(adapter.listModels({ ...session, source })).resolves.toEqual([{ id: "one", name: "GPT-5.4", displayName: "GPT 5.4" }]);
    expect(findPeer).toHaveBeenCalledWith("/peers", session.value);
    expect(listModels).toHaveBeenCalledWith(peer, { timeoutMs: 1_000 });
  });

  it("prepares, checkpoints, and commits before reporting acceptance", async () => {
    const events: string[] = [];
    const adapter = control({
      prepare: vi.fn(async () => ({ operationId: "a".repeat(64), state: "prepared" as const, turnId: null, detail: null })),
      commit: vi.fn(async () => ({ operationId: "a".repeat(64), state: "accepted" as const, turnId: "turn-1", detail: null }))
    });

    await expect(adapter.runModelPrompt("w1:p1", "hello", {
      modelDispatch: { name: "GPT-5.4", revision: 3 }, agentSession: session,
      onPrepared: () => { events.push("prepared"); }, onAccepted: ({ turnId }) => { events.push(`accepted:${turnId}`); }
    }, undefined, () => { events.push("dispatched"); })).resolves.toEqual({ operationId: "a".repeat(64), turnId: "turn-1" });
    expect(events).toEqual(["prepared", "dispatched", "accepted:turn-1"]);
  });

  it("aborts a prepared operation when the durable dispatch checkpoint fails", async () => {
    const onPrepareAborted = vi.fn();
    const abort = vi.fn(async () => ({ operationId: "a".repeat(64), state: "rejected" as const, turnId: null, detail: "Aborted before dispatch" }));
    const adapter = control({ abort });

    await expect(adapter.runModelPrompt("w1:p1", "hello", {
      modelDispatch: { name: "GPT-5.4", revision: 3 }, agentSession: session, onPrepared() {}, onPrepareAborted
    }, undefined, () => { throw new Error("dispatch checkpoint failed"); })).rejects.toThrow("dispatch checkpoint failed");
    expect(abort).toHaveBeenCalledOnce();
    expect(onPrepareAborted).toHaveBeenCalledWith("a".repeat(64));
  });
});

function control(overrides: Partial<ConstructorParameters<typeof TraexControlAdapter>[3]> = {}) {
  const operations = {
    findPeer: vi.fn(async () => peer),
    listModels: vi.fn(async () => []),
    prepare: vi.fn(async () => ({ operationId: "a".repeat(64), state: "prepared" as const, turnId: null, detail: null })),
    commit: vi.fn(async () => ({ operationId: "a".repeat(64), state: "accepted" as const, turnId: "turn-1", detail: null })),
    abort: vi.fn(async () => ({ operationId: "a".repeat(64), state: "rejected" as const, turnId: null, detail: "Aborted before dispatch" })),
    ...overrides
  };
  return new TraexControlAdapter("/peers", "/operations", 1_000, operations);
}
