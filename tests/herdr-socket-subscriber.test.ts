import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrSocketSubscriber } from "../src/runtime/herdr-socket-subscriber.js";

describe("Herdr socket subscriber", () => {
  it("correlates concurrent native requests on the RPC connection", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-rpc-")), "herdr.sock");
    let buffer = "";
    const requests: Array<{ id: string; method: string }> = [];
    const requestClients = new Map<string, Socket>();
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
          buffer = buffer.slice(newline + 1);
          requests.push(request);
          requestClients.set(request.id, socket);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => [], () => {}, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await vi.waitFor(() => expect(requests.some(({ method }) => method === "events.subscribe")).toBe(true));

    const snapshot = subscriber.request("session.snapshot", {}, 1_000);
    const agent = subscriber.request("agent.get", { target: "w1:p1" }, 1_000);
    await vi.waitFor(() => expect(requests.filter(({ method }) => method !== "events.subscribe")).toHaveLength(2));
    const snapshotRequest = requests.find(({ method }) => method === "session.snapshot")!;
    const agentRequest = requests.find(({ method }) => method === "agent.get")!;
    requestClients.get(agentRequest.id)!.write(`${JSON.stringify({ id: agentRequest.id, result: { type: "agent_info", pane_id: "w1:p1" } })}\n`);
    requestClients.get(snapshotRequest.id)!.write(`${JSON.stringify({ id: snapshotRequest.id, result: { type: "session_snapshot", snapshot: { panes: [], agents: [] } } })}\n`);

    await expect(snapshot).resolves.toMatchObject({ snapshot: { panes: [], agents: [] } });
    await expect(agent).resolves.toMatchObject({ pane_id: "w1:p1" });
    expect(subscriber.status()).toMatchObject({ connected: true, requests: 2, responses: 2, requestFailures: 0, transportFailures: 0, pendingRequests: 0 });
    await subscriber.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects requests when disconnected and rejects in-flight work on close", async () => {
    const subscriber = new HerdrSocketSubscriber("unused", async () => [], () => {}, pino({ enabled: false }));
    await expect(subscriber.request("session.snapshot", {}, 50)).rejects.toMatchObject({ code: "socket_disconnected", written: false });
    expect(subscriber.status()).toMatchObject({ connected: false, requests: 1, requestFailures: 1, transportFailures: 1 });

    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-rpc-close-")), "herdr.sock");
    let rpcClient!: Socket;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (!chunk.includes('"method":"events.subscribe"')) rpcClient = socket;
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const connected = new HerdrSocketSubscriber(socketPath, async () => [], () => {}, pino({ enabled: false }), 5, 20);
    connected.start();
    const pending = connected.request("agent.prompt", { target: "w1:p1", text: "secret" }, 1_000);
    await vi.waitFor(() => expect(rpcClient).toBeDefined());
    rpcClient.destroy();
    await expect(pending).rejects.toMatchObject({ code: "socket_disconnected", written: true });
    expect(connected.status()).toMatchObject({ connected: false, requests: 1, responses: 0, requestFailures: 1, transportFailures: 1, pendingRequests: 0 });
    await connected.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("bounds an unterminated RPC response before it can grow the process heap", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-rpc-large-")), "herdr.sock");
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (!chunk.includes('"method":"events.subscribe"')) socket.write("x".repeat(513));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => [], () => {}, pino({ enabled: false }), 5, 20, 512);
    await expect(subscriber.request("session.snapshot", {}, 1_000)).rejects.toMatchObject({ code: "socket_response_too_large", written: true });
    expect(subscriber.status()).toMatchObject({ requestFailures: 1, pendingRequests: 0 });
    await subscriber.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("wakes targeted Pane waiters from native events", async () => {
    const subscriber = new HerdrSocketSubscriber("unused", async () => [], () => {}, pino({ enabled: false }));
    const first = subscriber.waitForPaneEvent("w1:p1", 1_000);
    const other = subscriber.waitForPaneEvent("w1:p2", 10);

    (subscriber as unknown as { receive(value: string): void }).receive(
      '{"event":"pane.agent_status_changed","data":{"workspace_id":"w1","pane_id":"w1:p1","agent_status":"working"}}\n'
    );

    await expect(first).resolves.toBe(true);
    await expect(other).resolves.toBe(false);
  });

  it("preserves native error codes and releases Pane waiters on disconnect", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-rpc-error-")), "herdr.sock");
    let client!: Socket;
    let requestId = "";
    const server = createServer((socket) => {
      client = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of chunk.trim().split("\n")) {
          const request = JSON.parse(line) as { id: string; method: string };
          if (request.method === "agent.read") requestId = request.id;
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => [], () => {}, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await vi.waitFor(() => expect(client).toBeDefined());
    const request = subscriber.request("agent.read", { target: "missing" }, 1_000);
    const waiter = subscriber.waitForPaneEvent("w1:p1", 1_000);
    await vi.waitFor(() => expect(requestId).not.toBe(""));
    client.write(`${JSON.stringify({ id: requestId, error: { code: "agent_not_found", message: "missing" } })}\n`);
    await expect(request).rejects.toMatchObject({ code: "agent_not_found", written: true });
    expect(subscriber.status()).toMatchObject({ connected: true, requestFailures: 1, transportFailures: 0 });
    client.destroy();
    await expect(waiter).resolves.toBe(false);
    await subscriber.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

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
    let eventClient!: Socket;
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        requests.push(chunk);
        if (chunk.includes('"method":"events.subscribe"')) eventClient = socket;
      });
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let paneIds = ["w1:p1"];
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => paneIds, () => {}, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    paneIds = ["w1:p1", "w1:p2"];
    eventClient.write('{"event":"pane.created","data":{"workspace_id":"w1","pane_id":"w1:p2"}}\n');
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2), { timeout: 1_000 });

    const refreshed = JSON.parse(requests.filter((request) => request.includes('"method":"events.subscribe"')).at(-1)!.trim()) as { params: { subscriptions: Array<Record<string, string>> } };
    expect(refreshed.params.subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });

    await subscriber.stop();
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("does not reconnect for a replayed create event that is already subscribed", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-socket-replay-")), "herdr.sock");
    const requests: string[] = [];
    let eventClient!: Socket;
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        requests.push(chunk);
        if (chunk.includes('"method":"events.subscribe"')) eventClient = socket;
      });
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => ["w1:p1"], () => {}, pino({ enabled: false }), 5, 20);
    subscriber.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    eventClient.write('{"event":"pane_created","data":{"workspace_id":"w1","pane_id":"w1:p1"}}\n');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(requests).toHaveLength(1);
    expect(subscriber.status().eventsConnected).toBe(true);
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
