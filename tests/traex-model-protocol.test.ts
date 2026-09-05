import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listTraexModels } from "../src/runtime/traex-model-protocol.js";

const peer = { threadId: "01a03eb1-c193-7531-83c0-e6c6f70143d4", socketPath: "/run/user/1/traex.sock", pid: 42, startedAtMs: 1 };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("TraeX model protocol", () => {
  it("paginates the current peer catalog and excludes hidden models", async () => {
    const callPage = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "one", model: "GPT-5.4", displayName: "GPT 5.4", hidden: false }, { id: "hidden", model: "secret", displayName: "Secret", hidden: true }], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [{ id: "two", model: "GPT-5.5", displayName: "GPT 5.5", hidden: false }], nextCursor: null });

    await expect(listTraexModels(peer, { callPage })).resolves.toEqual([
      { id: "one", name: "GPT-5.4", displayName: "GPT 5.4" },
      { id: "two", name: "GPT-5.5", displayName: "GPT 5.5" }
    ]);
    expect(callPage).toHaveBeenNthCalledWith(1, peer, { cursor: null, limit: 100, includeHidden: false }, 10_000);
    expect(callPage).toHaveBeenNthCalledWith(2, peer, { cursor: "next", limit: 100, includeHidden: false }, 10_000);
  });

  it("fails closed for repeated cursors, malformed entries, and oversized catalogs", async () => {
    await expect(listTraexModels(peer, { callPage: vi.fn(async () => ({ data: [], nextCursor: "same" })) })).rejects.toThrow(/cursor/i);
    await expect(listTraexModels(peer, { callPage: vi.fn(async () => ({ data: [{ model: "bad" }], nextCursor: null })) })).rejects.toThrow(/entry/i);
    const data = Array.from({ length: 101 }, (_, index) => ({ id: String(index), model: `model-${index}`, displayName: `Model ${index}`, hidden: false }));
    await expect(listTraexModels(peer, { maxEntries: 100, callPage: vi.fn(async () => ({ data, nextCursor: null })) })).rejects.toThrow(/limit/i);
  });

  it("speaks initialize and paginated model/list over the authenticated peer socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "traex-model-list-")); roots.push(root);
    const socketPath = join(root, "peer.sock");
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => serve(socket, received));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    try {
      await expect(listTraexModels({ ...peer, socketPath })).resolves.toEqual([{ id: "one", name: "GPT-5.4", displayName: "GPT 5.4" }]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    expect(received).toEqual([
      expect.objectContaining({ method: "initialize", id: expect.stringContaining("model-list:init:") }),
      { method: "initialized" },
      expect.objectContaining({ method: "model/list", params: { cursor: null, limit: 100, includeHidden: false } })
    ]);
  });
});

function serve(socket: Socket, received: Array<Record<string, unknown>>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>; received.push(message);
      if (message.method === "initialize") socket.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`);
      if (message.method === "model/list") socket.write(`${JSON.stringify({ id: message.id, result: { data: [{ id: "one", model: "GPT-5.4", displayName: "GPT 5.4", hidden: false }], nextCursor: null } })}\n`);
    }
  });
}
