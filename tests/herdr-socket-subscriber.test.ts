import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrSocketSubscriber } from "../src/runtime/herdr-socket-subscriber.js";

describe("Herdr socket subscriber", () => {
  it("subscribes to native Pane events and routes fragmented event frames", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-socket-")), "herdr.sock");
    let client!: Socket;
    let request = "";
    const server = createServer((socket) => {
      client = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { request += chunk; });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const received = vi.fn();
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => ["w1:p1"], received, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await vi.waitFor(() => expect(request).toContain("events.subscribe"));
    const subscription = JSON.parse(request.trim()) as { params: { subscriptions: Array<Record<string, string>> } };
    expect(subscription.params.subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });

    client.write('{"event":"pane_agent_status_changed","data":{"type":"pane_agent_status_changed",');
    client.write('"pane_id":"w1:p1","workspace_id":"w1","agent_status":"working"}}\n');
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ event: "pane_agent_status_changed", workspaceIds: ["w1"], paneIds: ["w1:p1"] }));

    await subscriber.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("routes multiple frames and requests full convergence for malformed or oversized input", async () => {
    const received = vi.fn();
    const subscriber = new HerdrSocketSubscriber("unused", async () => [], received, pino({ enabled: false }), 5, 20, 512);
    const receive = (chunk: string) => (subscriber as unknown as { receive(value: string): void }).receive(chunk);

    receive(
      '{"event":"pane_updated","data":{"workspace_id":"w1","pane_id":"w1:p1"}}\n' +
      '{"event":"pane_exited","data":{"workspace_id":"w2","pane_id":"w2:p2"}}\n' +
      'not-json\n'
    );
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ event: "socket.batch", workspaceIds: [], paneIds: [] }));

    receive("x".repeat(513));
    await vi.waitFor(() => expect(received.mock.calls.some(([hint]) => hint.event === "socket.invalid" || hint.event === "socket.batch")).toBe(true));
  });

  it("contains rejected event handlers and leaves periodic reconciliation as fallback", async () => {
    const warnings: object[] = [];
    const subscriber = new HerdrSocketSubscriber(
      "unused",
      async () => [],
      async () => { throw new Error("reconciliation failed"); },
      { info() {}, debug() {}, warn(value) { warnings.push(value); } } as never
    );

    (subscriber as unknown as { receive(value: string): void }).receive(
      '{"event":"pane_updated","data":{"workspace_id":"w1"}}\n'
    );
    await vi.waitFor(() => expect(warnings).toContainEqual(expect.objectContaining({ event: "herdr-socket-event-handler-failed" })));
  });

  it("coalesces event bursts while one reconciliation is in flight", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const received = vi.fn(async () => { if (received.mock.calls.length === 1) await blocked; });
    const subscriber = new HerdrSocketSubscriber("unused", async () => [], received, pino({ enabled: false }));
    const receive = (chunk: string) => (subscriber as unknown as { receive(value: string): void }).receive(chunk);

    receive('{"event":"pane_updated","data":{"workspace_id":"w1","pane_id":"w1:p1"}}\n');
    receive('{"event":"pane_exited","data":{"workspace_id":"w2","pane_id":"w2:p2"}}\n' +
      '{"event":"pane_updated","data":{"workspace_id":"w3","pane_id":"w3:p3"}}\n');
    expect(received).toHaveBeenCalledTimes(1);
    release();

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(received.mock.calls[1]?.[0]).toEqual({ event: "socket.batch", workspaceIds: ["w2", "w3"], paneIds: ["w2:p2", "w3:p3"] });
  });

  it("refreshes per-Pane Agent subscriptions after a Pane is created", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-socket-refresh-")), "herdr.sock");
    const requests: string[] = [];
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => requests.push(chunk));
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let paneIds = ["w1:p1"];
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => paneIds, () => {}, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    paneIds = ["w1:p1", "w1:p2"];
    [...clients][0]!.write('{"event":"pane.created","data":{"workspace_id":"w1","pane_id":"w1:p2"}}\n');
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2));

    const refreshed = JSON.parse(requests.at(-1)!.trim()) as { params: { subscriptions: Array<Record<string, string>> } };
    expect(refreshed.params.subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });

    await subscriber.stop();
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("reconnects and requests full convergence after the socket returns", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-reconnect-")), "herdr.sock");
    const received = vi.fn();
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => [], received, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const clients = new Set<Socket>();
    const server = createServer((socket) => { clients.add(socket); socket.once("close", () => clients.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ event: "socket.connected", workspaceIds: [], paneIds: [] }));
    await subscriber.stop();
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
