import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeSessionEventMultiplexAck,
  normalizeSessionEventMultiplexFrame
} from "../src/adapters/herdr-events-adapter.js";
import type { CoreSessionEventMultiplexTarget } from "../src/domain/herdr-events.js";
import { HerdrSessionEventSubscriber } from "../src/runtime/herdr-session-event-subscriber.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/herdr-session-events-v3.json", import.meta.url), "utf8")) as {
  capability: object;
  ack: object;
  batchFrame: object;
};

describe("Herdr session event multiplex subscriber", () => {
  it("activates an acknowledged generation and emits normalized tagged batches", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-session-multiplex-")), "herdr.sock");
    const requests: Array<{ id: string; method: string; params: object }> = [];
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: string; method: string; params: object };
          requests.push(request);
          if (request.method === "ping") {
            socket.write(`${JSON.stringify({ id: request.id, result: fixture.capability })}\n`);
          } else if (request.method === "session.events.subscribe.v3") {
            socket.write(`${JSON.stringify({ id: request.id, result: fixture.ack })}\n`);
            socket.write(`${JSON.stringify(fixture.batchFrame)}\n`);
          }
        }
      });
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const received = vi.fn();
    const subscriber = new HerdrSessionEventSubscriber({
      socketPath,
      supportsMultiplex: async () => true,
      onFrame: received,
      normalizeAck: normalizeSessionEventMultiplexAck,
      normalizeFrame: normalizeSessionEventMultiplexFrame,
      logger: pino({ enabled: false }),
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      acknowledgementTimeoutMs: 1_000
    });
    const target: CoreSessionEventMultiplexTarget = {
      ringId: "session-ring-v2:ring-1",
      epoch: "epoch-1",
      after: "session-ring-v2:ring-1:epoch-1:9",
      limit: 128
    };

    subscriber.start();
    await subscriber.replaceTargets([target]);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());

    expect(requests.map(({ method }) => method)).toEqual(["session.events.subscribe.v3"]);
    expect(requests[0]?.params).toEqual({
      targets: [{
        ring_id: target.ringId,
        epoch: target.epoch,
        after: target.after,
        limit: target.limit
      }]
    });
    expect(subscriber.status()).toMatchObject({ connected: true, generation: 1, activeTargetCount: 1 });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ outcome: "batch" }), 1);

    await subscriber.stop();
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("validates target count, limits, and unique rings before opening a socket", async () => {
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
      else reply(socket, request.id, acknowledgement(targetCount(request)));
    });
    const subscriber = createSubscriber(server.socketPath);
    subscriber.start();

    await expect(subscriber.replaceTargets([])).rejects.toThrow(/1\.\.128/);
    await expect(subscriber.replaceTargets(makeTargets(129))).rejects.toThrow(/1\.\.128/);
    await expect(subscriber.replaceTargets([{ ...makeTarget("ring-1"), limit: 0 }])).rejects.toThrow(/limit/);
    await expect(subscriber.replaceTargets([{ ...makeTarget("ring-1"), limit: 129 }])).rejects.toThrow(/limit/);
    await expect(subscriber.replaceTargets([makeTarget("ring-1"), { ...makeTarget("ring-1"), epoch: "other" }])).rejects.toThrow(/Duplicate/);
    await subscriber.replaceTargets([{ ...makeTarget("ring-1"), limit: 1 }, { ...makeTarget("ring-2"), limit: 128 }]);
    expect(subscriber.status()).toMatchObject({ connected: true, activeTargetCount: 2 });

    await subscriber.stop();
    await server.close();
  });

  it("accepts the maximum 128 distinct targets", async () => {
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
      else reply(socket, request.id, acknowledgement(targetCount(request)));
    });
    const subscriber = createSubscriber(server.socketPath);
    subscriber.start();
    await subscriber.replaceTargets(makeTargets(128));
    expect(subscriber.status().activeTargetCount).toBe(128);
    await subscriber.stop();
    await server.close();
  });

  it("requires the advertised multiplex capability", async () => {
    const server = await startSocketServer((request, socket) => reply(socket, request.id, capability(false)));
    const subscriber = createSubscriber(server.socketPath, { supportsMultiplex: async () => false });
    subscriber.start();
    await expect(subscriber.replaceTargets([makeTarget("ring-1")])).rejects.toThrow(/capability.*unavailable/);
    expect(server.requests).toEqual([]);
    expect(subscriber.status()).toEqual({ connected: false, generation: 0, activeTargetCount: 0 });
    await subscriber.stop();
    await server.close();
  });

  it("rejects frames before acknowledgement and times out a silent candidate", async () => {
    const preAck = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
      else socket.write(`${JSON.stringify(fixture.batchFrame)}\n`);
    });
    const first = createSubscriber(preAck.socketPath, { acknowledgementTimeoutMs: 50 });
    first.start();
    await expect(first.replaceTargets([makeTarget("ring-1")])).rejects.toThrow(/RPC response|frame/i);
    await first.stop();
    await preAck.close();

    const silent = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
    });
    const second = createSubscriber(silent.socketPath, { acknowledgementTimeoutMs: 10 });
    second.start();
    await expect(second.replaceTargets([makeTarget("ring-1")])).rejects.toThrow(/timed out/);
    await second.stop();
    await silent.close();
  });

  it("preserves the active feed when a replacement candidate fails", async () => {
    const received = vi.fn();
    let ring2Attempts = 0;
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") return reply(socket, request.id, capability(true));
      if (requestedRing(request) === "ring-2" && ring2Attempts++ === 0) return socket.destroy();
      reply(socket, request.id, acknowledgement(1));
    });
    const subscriber = createSubscriber(server.socketPath, { onFrame: received });
    subscriber.start();
    await subscriber.replaceTargets([makeTarget("ring-1")]);
    const oldSocket = server.clients[0]!;

    await expect(subscriber.replaceTargets([makeTarget("ring-2")])).rejects.toThrow(/closed/);
    expect(subscriber.status()).toEqual({ connected: true, generation: 1, activeTargetCount: 1 });
    oldSocket.write(`${JSON.stringify(fixture.batchFrame)}\n`);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.anything(), 1));
    await vi.waitFor(() => expect(subscriber.status()).toEqual({ connected: true, generation: 2, activeTargetCount: 1 }));
    expect(requestedRing(server.requests.at(-1)!)).toBe("ring-2");

    await subscriber.stop();
    await server.close();
  });

  it("fences stale overlap after replacement and emits the candidate copy once", async () => {
    const received = vi.fn();
    let oldSocket: Socket | undefined;
    const server = await startSocketServer((request, socket, connection) => {
      if (request.method === "ping") return reply(socket, request.id, capability(true));
      reply(socket, request.id, acknowledgement(1));
      if (connection === 0) oldSocket = socket;
      if (connection === 1) {
        socket.write(`${JSON.stringify(fixture.batchFrame)}\n`);
        setTimeout(() => oldSocket?.write(`${JSON.stringify(fixture.batchFrame)}\n`), 5);
      }
    });
    const subscriber = createSubscriber(server.socketPath, { onFrame: received });
    subscriber.start();
    await subscriber.replaceTargets([makeTarget("ring-1")]);
    await subscriber.replaceTargets([makeTarget("ring-2")]);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ outcome: "batch" }), 2);

    await subscriber.stop();
    await server.close();
  });

  it("normalizes immediate and later typed gap frames", async () => {
    const received = vi.fn();
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") return reply(socket, request.id, capability(true));
      reply(socket, request.id, acknowledgement(1));
      socket.write(`${JSON.stringify(fixture.gapFrames?.[0])}\n`);
      setTimeout(() => socket.write(`${JSON.stringify(fixture.gapFrames?.[1])}\n`), 2);
    });
    const subscriber = createSubscriber(server.socketPath, { onFrame: received });
    subscriber.start();
    await subscriber.replaceTargets([makeTarget("ring-1")]);
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(received.mock.calls.map(call => [call[0].gap.code, call[1]])).toEqual([["cursor_expired", 1], ["epoch_changed", 1]]);
    await subscriber.stop();
    await server.close();
  });

  it.each([
    ["malformed", "{not-json\n", 2_048],
    ["oversized", "x".repeat(513), 512]
  ])("disconnects and rejects %s active frames", async (_name, invalidFrame, maxFrameBytes) => {
    let activeSocket: Socket | undefined;
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") return reply(socket, request.id, capability(true));
      activeSocket = socket;
      reply(socket, request.id, acknowledgement(1));
    });
    const subscriber = createSubscriber(server.socketPath, { maxFrameBytes, reconnectBaseMs: 1_000, reconnectMaxMs: 1_000 });
    subscriber.start();
    await subscriber.replaceTargets([makeTarget("ring-1")]);
    activeSocket!.write(invalidFrame);
    await vi.waitFor(() => expect(subscriber.status().connected).toBe(false));
    await subscriber.stop();
    await server.close();
  });

  it("reconnects the supplied target set with fake-timer backoff", async () => {
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
      else reply(socket, request.id, acknowledgement(1));
    });
    let durableTarget = makeTarget("ring-1");
    const refreshTargets = vi.fn(async () => [durableTarget]);
    const onActivated = vi.fn();
    const subscriber = createSubscriber(server.socketPath, {
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      refreshTargets,
      onActivated
    });
    subscriber.start();
    await subscriber.replaceTargets([makeTarget("ring-1")]);
    durableTarget = { ...durableTarget, after: "ring-1:durable-cursor" };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      server.clients[0]!.destroy();
      for (let attempt = 0; attempt < 10 && subscriber.status().connected; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(subscriber.status().connected).toBe(false);
      await vi.advanceTimersByTimeAsync(4);
      expect(server.clients).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      for (let attempt = 0; attempt < 10 && subscriber.status().generation < 2; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(subscriber.status()).toEqual({ connected: true, generation: 2, activeTargetCount: 1 });
      expect(requestedRing(server.requests.at(-1)!)).toBe("ring-1");
      expect(requestedAfter(server.requests.at(-1)!)).toBe(durableTarget.after);
      expect(refreshTargets).toHaveBeenCalled();
      expect(onActivated).toHaveBeenLastCalledWith([durableTarget], 2);
    } finally {
      vi.useRealTimers();
    }
    await subscriber.stop();
    await server.close();
  });

  it("clears the active feed without sending an invalid empty Core subscription", async () => {
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
      else reply(socket, request.id, acknowledgement(1));
    });
    const subscriber = createSubscriber(server.socketPath);
    subscriber.start();
    await subscriber.replaceTargets([makeTarget("ring-1")]);

    await subscriber.clearTargets();

    expect(subscriber.status()).toEqual({ connected: false, generation: 1, activeTargetCount: 0 });
    expect(server.requests.filter(({ method }) => method === "session.events.subscribe.v3")).toHaveLength(1);
    await subscriber.stop();
    await server.close();
  });

  it("stops with a pending candidate and cancels its promise and socket", async () => {
    const server = await startSocketServer((request, socket) => {
      if (request.method === "ping") reply(socket, request.id, capability(true));
    });
    const subscriber = createSubscriber(server.socketPath, { acknowledgementTimeoutMs: 10_000 });
    subscriber.start();
    const pending = subscriber.replaceTargets([makeTarget("ring-1")]);
    await vi.waitFor(() => expect(server.requests.some(request => request.method === "session.events.subscribe.v3")).toBe(true));
    await subscriber.stop();
    await expect(pending).rejects.toThrow(/stopped/);
    expect(subscriber.status()).toEqual({ connected: false, generation: 0, activeTargetCount: 0 });
    await server.close();
  });
});

interface TestRequest { id: string; method: string; params: Record<string, unknown> }

interface TestSocketServer {
  socketPath: string;
  server: Server;
  clients: Socket[];
  requests: TestRequest[];
  close(): Promise<void>;
}

async function startSocketServer(onRequest: (request: TestRequest, socket: Socket, connection: number) => void): Promise<TestSocketServer> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-session-multiplex-test-")), "herdr.sock");
  const clients: Socket[] = [];
  const requests: TestRequest[] = [];
  const server = createServer((socket) => {
    const connection = clients.push(socket) - 1;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as TestRequest;
        requests.push(request);
        onRequest(request, socket, connection);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  return {
    socketPath,
    server,
    clients,
    requests,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

function createSubscriber(socketPath: string, overrides: Partial<ConstructorParameters<typeof HerdrSessionEventSubscriber>[0]> = {}) {
  return new HerdrSessionEventSubscriber({
    socketPath,
    supportsMultiplex: async () => true,
    onFrame: () => undefined,
    normalizeAck: normalizeSessionEventMultiplexAck,
    normalizeFrame: normalizeSessionEventMultiplexFrame,
    logger: pino({ enabled: false }),
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    reconnectJitterRatio: 0,
    healthyDwellMs: 0,
    acknowledgementTimeoutMs: 100,
    ...overrides
  });
}

function makeTarget(ringId: string): CoreSessionEventMultiplexTarget {
  return { ringId, epoch: `epoch-${ringId}`, after: `${ringId}:cursor`, limit: 128 };
}

function makeTargets(count: number): CoreSessionEventMultiplexTarget[] {
  return Array.from({ length: count }, (_, index) => makeTarget(`ring-${index + 1}`));
}

function capability(enabled: boolean) {
  return { type: "pong", capabilities: { session_event_multiplex_v1: enabled } };
}

function acknowledgement(targetCount: number) {
  return { type: "session_event_multiplex_subscribed_v3", target_count: targetCount };
}

function reply(socket: Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ id, result })}\n`);
}

function targetCount(request: TestRequest): number {
  return ((request.params.targets ?? []) as unknown[]).length;
}

function requestedRing(request: TestRequest): string | undefined {
  const targets = request.params.targets as Array<{ ring_id?: string }> | undefined;
  return targets?.[0]?.ring_id;
}

function requestedAfter(request: TestRequest): string | undefined {
  const targets = request.params.targets as Array<{ after?: string }> | undefined;
  return targets?.[0]?.after;
}
