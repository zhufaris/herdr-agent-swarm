import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { steerTraexTurn } from "../src/runtime/traex-native-steering.js";

const roots: string[] = [];
const peer = { threadId: "01a04f1e-f789-77d2-aa08-7dd693650157", socketPath: "/tmp/unused.sock", pid: process.pid, startedAtMs: Date.now() };

afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("TraeX native steering", () => {
  it("deduplicates a delivered operation without repeating the external effect", async () => {
    const operationDir = await fixture();
    const callPeer = vi.fn(async () => "turn-1");
    const input = { peer, expectedTurnId: "turn-1", text: "change direction", idempotencyKey: "message:1" };
    await expect(steerTraexTurn(input, { operationDir, callPeer })).resolves.toMatchObject({ status: "delivered", turnId: "turn-1" });
    await expect(steerTraexTurn(input, { operationDir, callPeer })).resolves.toMatchObject({ status: "delivered", turnId: "turn-1" });
    expect(callPeer).toHaveBeenCalledOnce();
  });

  it("never replays a dispatching record without a terminal receipt", async () => {
    const operationDir = await fixture();
    const callPeer = vi.fn(async () => { throw new Error("connection reset"); });
    const input = { peer, expectedTurnId: "turn-1", text: "change direction", idempotencyKey: "message:2" };
    await expect(steerTraexTurn(input, { operationDir, callPeer })).resolves.toMatchObject({ status: "delivery-uncertain" });
    await expect(steerTraexTurn(input, { operationDir, callPeer })).resolves.toMatchObject({ status: "delivery-uncertain" });
    expect(callPeer).toHaveBeenCalledOnce();
  });

  it("rejects reuse of an idempotency key for different text", async () => {
    const operationDir = await fixture();
    const callPeer = vi.fn(async () => "turn-1");
    await steerTraexTurn({ peer, expectedTurnId: "turn-1", text: "first", idempotencyKey: "same" }, { operationDir, callPeer });
    await expect(steerTraexTurn({ peer, expectedTurnId: "turn-1", text: "second", idempotencyKey: "same" }, { operationDir, callPeer })).rejects.toThrow(/different request/);
  });

  it.each([
    ["activeTurnNotSteerable", "blocked"],
    ["expected turn does not match the active turn", "not-active"],
    ["method not found", "unsupported"]
  ])("maps explicit error %s to %s", async (message, status) => {
    const operationDir = await fixture();
    await expect(steerTraexTurn(
      { peer, expectedTurnId: "turn-1", text: "change", idempotencyKey: message },
      { operationDir, callPeer: async () => { throw new Error(message); } }
    )).resolves.toMatchObject({ status });
  });

  it("speaks initialize and exact-turn steer over the session peer socket", async () => {
    const root = await fixture();
    const socketPath = join(root, "peer.sock");
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => serve(socket, received));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    try {
      await expect(steerTraexTurn(
        { peer: { ...peer, socketPath }, expectedTurnId: "turn-42", text: "use the cache", idempotencyKey: "wire-1" },
        { operationDir: join(root, "operations") }
      )).resolves.toMatchObject({ status: "delivered", turnId: "turn-42" });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    expect(received).toEqual([
      expect.objectContaining({ method: "initialize", id: "native-steer:init" }),
      { method: "initialized" },
      { method: "turn/steer", id: "native-steer:dispatch", params: { threadId: peer.threadId, expectedTurnId: "turn-42", input: [{ type: "text", text: "use the cache", text_elements: [] }] } }
    ]);
    const stored = await readFile(join(root, "operations", `${sha256("wire-1")}.json`), "utf8");
    expect(stored).not.toContain("use the cache");
  });
});

async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "traex-native-steer-")); roots.push(root); return root; }
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
      if (message.id === "native-steer:init") socket.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } })}\n`);
      if (message.id === "native-steer:dispatch") socket.write(`${JSON.stringify({ id: message.id, result: { turnId: "turn-42" } })}\n`);
    }
  });
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
